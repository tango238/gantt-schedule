/**
 * D1 の schedule_versions 表へのアクセス。時刻は ms の INTEGER。
 *
 * - スナップショットは `INSERT ... SELECT s.doc FROM schedules s` で作る: doc を Worker に読み出さず、
 *   D1 上でその時点の確定 doc を 1 文で写す (rev も一緒に記録)。呼び出し側 (Durable Object) が直列化の中で呼ぶので、
 *   コマンドの保存と混ざらない。
 * - 手動 (kind='manual') と自動 (kind='auto') は別枠で、スケジュールごとにそれぞれ新しい順 VERSION_KEEP 件だけ残す。
 *   作るたびに、その種別だけを刈り込む (手動の作成で自動は消えず、逆も同様)。
 *   順序は `created_at DESC, id DESC` で固定 (同一ミリ秒でも決まる)。
 * - 直前の自動バージョンと doc が同一なら新規作成しない (AI 適用の連打などで乱造しない)。
 */

/** 種別ごと (手動・自動それぞれ) の保持件数。 */
export const VERSION_KEEP = 10;
export const VERSION_NAME_MAX = 100;

export interface VersionStatement {
  bind(...values: unknown[]): VersionStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
/** D1Database のうち使う部分だけ (テストでは node:sqlite で作った互換物を渡す)。 */
export interface VersionsDb {
  prepare(sql: string): VersionStatement;
  batch(statements: VersionStatement[]): Promise<Array<{ meta: { changes: number } }>>;
}

export type VersionKind = "manual" | "auto";

export interface VersionListItem {
  id: string;
  name: string;
  kind: VersionKind;
  rev: number | null;
  createdAt: number;
  createdBy: { name: string; email: string };
}

export interface VersionDetail extends VersionListItem {
  doc: unknown;
}

export function newVersionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SnapshotInput {
  id: string;
  scheduleId: string;
  name: string;
  kind: VersionKind;
  userId: string;
  now: number;
  /** 指定すると、スケジュールの rev がこの値のときだけ作る (復元で書き換えと同じ状態を写すため)。 */
  expectedRev?: number;
}

/** 直前 (最新) の自動バージョンと doc が同一なら除外する条件。 */
const NOT_DUPLICATE_OF_LATEST_AUTO = `NOT EXISTS (
  SELECT 1 FROM schedule_versions a
  WHERE a.schedule_id = s.id AND a.kind = 'auto' AND a.doc = s.doc
    AND a.id = (SELECT l.id FROM schedule_versions l WHERE l.schedule_id = s.id AND l.kind = 'auto'
                ORDER BY l.created_at DESC, l.id DESC LIMIT 1)
)`;

/** 現在の doc を写す INSERT。 */
export function snapshotStatement(db: VersionsDb, v: SnapshotInput): VersionStatement {
  const rev = v.expectedRev !== undefined ? " AND s.rev = ?" : "";
  const dup = v.kind === "auto" ? ` AND ${NOT_DUPLICATE_OF_LATEST_AUTO}` : "";
  const args: unknown[] = [v.id, v.name, v.kind, v.userId, v.now, v.scheduleId];
  if (v.expectedRev !== undefined) args.push(v.expectedRev);
  return db
    .prepare(
      `INSERT INTO schedule_versions (id, schedule_id, name, kind, doc, created_by, created_at, rev)
       SELECT ?, s.id, ?, ?, s.doc, ?, ?, s.rev FROM schedules s
       WHERE s.id = ? AND s.deleted_at IS NULL${rev}${dup}`,
    )
    .bind(...args);
}

/** 指定した種別のバージョンを新しい順に VERSION_KEEP 件だけ残す DELETE。 */
export function pruneStatement(db: VersionsDb, scheduleId: string, kind: VersionKind): VersionStatement {
  return db
    .prepare(
      `DELETE FROM schedule_versions
       WHERE schedule_id = ? AND kind = ?
         AND id NOT IN (SELECT id FROM schedule_versions WHERE schedule_id = ? AND kind = ?
                        ORDER BY created_at DESC, id DESC LIMIT ?)`,
    )
    .bind(scheduleId, kind, scheduleId, kind, VERSION_KEEP);
}

/**
 * 現在の doc をバージョンとして保存する。スケジュールが無い (削除済み) なら null。
 * 自動で直前の自動と同一内容だった場合は新規作成せず、その既存の id を created:false で返す。
 */
export async function createVersion(
  db: VersionsDb,
  v: Omit<SnapshotInput, "id" | "expectedRev">,
): Promise<{ id: string; created: boolean } | null> {
  const id = newVersionId();
  const ins = snapshotStatement(db, { ...v, id });
  // 作成と刈り込み (同じ種別だけ) は 1 回の batch。
  const results = await db.batch([ins, pruneStatement(db, v.scheduleId, v.kind)]);
  if (results[0]!.meta.changes > 0) return { id, created: true };
  const exists = await db
    .prepare("SELECT 1 AS x FROM schedules WHERE id = ? AND deleted_at IS NULL")
    .bind(v.scheduleId)
    .first();
  if (!exists) return null;
  if (v.kind === "auto") {
    const latest = await db
      .prepare(
        "SELECT id FROM schedule_versions WHERE schedule_id = ? AND kind = 'auto' ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .bind(v.scheduleId)
      .first<{ id: string }>();
    if (latest) return { id: latest.id, created: false };
  }
  throw new Error("version insert affected no rows");
}

/**
 * 復元: rev が expectedRev のときだけ、(1) 現在の doc を自動バージョンとして保存 (直前の自動と同一なら省略)、
 * (2) 自動の刈り込み (手動には触れない)、(3) 現在の doc を json で置き換える (rev+1)、を 1 回の batch (= 1 トランザクション) で行う。
 * (1) と (3) は同じ rev 条件なので、両方実行されるか両方されないかのどちらか。
 */
export async function restoreDocWithAutoVersion(
  db: VersionsDb,
  p: {
    scheduleId: string;
    expectedRev: number;
    userId: string;
    json: string;
    name: string;
    now: number;
    autoName: string;
  },
): Promise<"ok" | "conflict"> {
  const results = await db.batch([
    snapshotStatement(db, {
      id: newVersionId(),
      scheduleId: p.scheduleId,
      name: p.autoName,
      kind: "auto",
      userId: p.userId,
      now: p.now,
      expectedRev: p.expectedRev,
    }),
    pruneStatement(db, p.scheduleId, "auto"),
    db
      .prepare(
        `UPDATE schedules SET doc = ?, name = ?, rev = rev + 1, updated_by = ?, updated_at = ?
         WHERE id = ? AND rev = ? AND deleted_at IS NULL`,
      )
      .bind(p.json, p.name, p.userId, p.now, p.scheduleId, p.expectedRev),
  ]);
  return results[2]!.meta.changes > 0 ? "ok" : "conflict";
}

interface ListRow {
  id: string;
  name: string;
  kind: VersionKind;
  rev: number | null;
  createdAt: number;
  userName: string;
  userEmail: string;
}
const toItem = (r: ListRow): VersionListItem => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  rev: r.rev,
  createdAt: r.createdAt,
  createdBy: { name: r.userName, email: r.userEmail },
});

const SELECT_COLS = `v.id, v.name, v.kind, v.rev, v.created_at AS createdAt, u.name AS userName, u.email AS userEmail`;

/** 新しい順。doc は含めない。スケジュールが削除済みなら空 (呼び出し側が 404 にする)。 */
export async function listVersions(db: VersionsDb, scheduleId: string): Promise<VersionListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLS}
       FROM schedule_versions v JOIN users u ON u.id = v.created_by JOIN schedules s ON s.id = v.schedule_id
       WHERE v.schedule_id = ? AND s.deleted_at IS NULL
       ORDER BY v.created_at DESC, v.id DESC`,
    )
    .bind(scheduleId)
    .all<ListRow>();
  return results.map(toItem);
}

/** schedule_id を必ず条件に入れる (他スケジュールの versionId は null)。 */
export async function getVersion(db: VersionsDb, scheduleId: string, versionId: string): Promise<VersionDetail | null> {
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLS}, v.doc AS doc
       FROM schedule_versions v JOIN users u ON u.id = v.created_by JOIN schedules s ON s.id = v.schedule_id
       WHERE v.id = ? AND v.schedule_id = ? AND s.deleted_at IS NULL`,
    )
    .bind(versionId, scheduleId)
    .first<ListRow & { doc: string }>();
  return row ? { ...toItem(row), doc: JSON.parse(row.doc) as unknown } : null;
}

/** 復元用: 名前と doc の JSON 文字列。 */
export async function loadVersionDoc(
  db: VersionsDb,
  scheduleId: string,
  versionId: string,
): Promise<{ name: string; doc: string } | null> {
  return db
    .prepare(
      `SELECT v.name AS name, v.doc AS doc FROM schedule_versions v JOIN schedules s ON s.id = v.schedule_id
       WHERE v.id = ? AND v.schedule_id = ? AND s.deleted_at IS NULL`,
    )
    .bind(versionId, scheduleId)
    .first<{ name: string; doc: string }>();
}

/** 手動バージョンだけ削除する。"not_found" / "auto" (自動は削除不可) / "ok"。 */
export async function deleteManualVersion(
  db: VersionsDb,
  scheduleId: string,
  versionId: string,
): Promise<"ok" | "not_found" | "auto"> {
  const row = await db
    .prepare(
      `SELECT v.kind AS kind FROM schedule_versions v JOIN schedules s ON s.id = v.schedule_id
       WHERE v.id = ? AND v.schedule_id = ? AND s.deleted_at IS NULL`,
    )
    .bind(versionId, scheduleId)
    .first<{ kind: VersionKind }>();
  if (!row) return "not_found";
  if (row.kind !== "manual") return "auto";
  const r = await db
    .prepare("DELETE FROM schedule_versions WHERE id = ? AND schedule_id = ? AND kind = 'manual'")
    .bind(versionId, scheduleId)
    .run();
  return r.meta.changes > 0 ? "ok" : "not_found";
}
