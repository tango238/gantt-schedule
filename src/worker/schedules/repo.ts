import type { GanttDocument } from "../../shared/model/types";

/** D1 の schedules 表へのアクセス。時刻は ms の INTEGER。 */

/** D1Database のうち使う部分だけ (Worker 以外の型環境・テストのモックでも使えるように)。 */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

export interface ScheduleListItem {
  id: string;
  name: string;
  updatedAt: number;
  updatedBy: { name: string; email: string };
  /** ログイン中のユーザーのお気に入りか。 */
  favorite: boolean;
}

export interface ScheduleDetail {
  id: string;
  name: string;
  doc: GanttDocument;
  rev: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: { name: string; email: string };
  /** ログイン中のユーザーのお気に入りか (共同編集の doc には含めない)。 */
  favorite: boolean;
}

const LIST_LIMIT = 1000;

/** 推測不能な ID: 乱数 16 バイトの base64url (22 文字)。 */
export function newScheduleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function listSchedules(db: D1Like, userId: string): Promise<ScheduleListItem[]> {
  // お気に入りは LEFT JOIN 1 回 (主キーが (user_id, schedule_id) なので行は増えない)。
  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, s.updated_at AS updatedAt, u.name AS userName, u.email AS userEmail,
         (f.schedule_id IS NOT NULL) AS favorite
       FROM schedules s JOIN users u ON u.id = s.updated_by
       LEFT JOIN schedule_favorites f ON f.schedule_id = s.id AND f.user_id = ?
       WHERE s.deleted_at IS NULL
       ORDER BY s.updated_at DESC, s.id
       LIMIT ?`,
    )
    .bind(userId, LIST_LIMIT)
    .all<{ id: string; name: string; updatedAt: number; userName: string; userEmail: string; favorite: number }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    updatedAt: r.updatedAt,
    updatedBy: { name: r.userName, email: r.userEmail },
    favorite: Number(r.favorite) === 1,
  }));
}

interface DetailRow {
  id: string;
  name: string;
  doc: string;
  rev: number;
  createdAt: number;
  updatedAt: number;
  userName: string;
  userEmail: string;
  favorite: number;
}

const DETAIL_SQL = `SELECT s.id, s.name, s.doc, s.rev, s.created_at AS createdAt, s.updated_at AS updatedAt,
  u.name AS userName, u.email AS userEmail, (f.schedule_id IS NOT NULL) AS favorite
  FROM schedules s JOIN users u ON u.id = s.updated_by
  LEFT JOIN schedule_favorites f ON f.schedule_id = s.id AND f.user_id = ?
  WHERE s.id = ? AND s.deleted_at IS NULL`;

function toDetail(r: DetailRow): ScheduleDetail {
  return {
    id: r.id,
    name: r.name,
    doc: JSON.parse(r.doc) as GanttDocument,
    rev: r.rev,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: { name: r.userName, email: r.userEmail },
    favorite: Number(r.favorite) === 1,
  };
}

/** 未削除のスケジュールを取得。無い・削除済みなら null。favorite は userId にとってのお気に入りか。 */
export async function getSchedule(db: D1Like, id: string, userId: string): Promise<ScheduleDetail | null> {
  const row = await db.prepare(DETAIL_SQL).bind(userId, id).first<DetailRow>();
  return row ? toDetail(row) : null;
}

export async function createSchedule(
  db: D1Like,
  userId: string,
  name: string,
  docJson: string,
): Promise<{ id: string; name: string; rev: number }> {
  const id = newScheduleId();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO schedules (id, name, doc, rev, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .bind(id, name, docJson, userId, now, userId, now)
    .run();
  return { id, name, rev: 0 };
}

export async function softDeleteSchedule(db: D1Like, id: string, userId: string): Promise<boolean> {
  const r = await db
    .prepare("UPDATE schedules SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(Date.now(), userId, id)
    .run();
  return r.meta.changes > 0;
}

/** 未削除のスケジュールがあるか (WebSocket 接続の前提確認。doc は読まない)。 */
export async function scheduleExists(db: D1Like, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM schedules WHERE id = ? AND deleted_at IS NULL").bind(id).first();
  return row !== null;
}

/** Durable Object が起動時・キャッシュ破棄後に読む現在の doc と rev。無い・削除済みなら null。 */
export async function loadDocAndRev(db: D1Like, id: string): Promise<{ doc: GanttDocument; rev: number } | null> {
  const row = await db
    .prepare("SELECT doc, rev FROM schedules WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<{ doc: string; rev: number }>();
  return row ? { doc: JSON.parse(row.doc) as GanttDocument, rev: row.rev } : null;
}

export async function loadRev(db: D1Like, id: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT rev FROM schedules WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<{ rev: number }>();
  return row ? row.rev : null;
}

export type SaveOutcome = "ok" | "conflict";

/**
 * doc を保存する (rev+1, updated_by, name 同期)。`rev = expectedRev` の行だけ更新する安全側の楽観ロック。
 * 0 行更新 (rev が違う・削除済み) なら "conflict"。呼び出し側 (Durable Object) はキャッシュを捨てて読み直す。
 * スケジュールの doc を更新する唯一の経路 (Durable Object からのみ呼ぶ)。
 */
export async function saveDocAtRev(
  db: D1Like,
  id: string,
  expectedRev: number,
  userId: string,
  json: string,
  name: string,
  now: number,
): Promise<SaveOutcome> {
  const upd = await db
    .prepare(
      `UPDATE schedules SET doc = ?, name = ?, rev = rev + 1, updated_by = ?, updated_at = ?
       WHERE id = ? AND rev = ? AND deleted_at IS NULL`,
    )
    .bind(json, name, userId, now, id, expectedRev)
    .run();
  return upd.meta.changes > 0 ? "ok" : "conflict";
}

/** お気に入りに追加 (冪等)。未削除のスケジュールが無ければ false。 */
export async function addFavorite(db: D1Like, userId: string, scheduleId: string): Promise<boolean> {
  if (!(await scheduleExists(db, scheduleId))) return false;
  await db
    .prepare("INSERT OR IGNORE INTO schedule_favorites (user_id, schedule_id, created_at) VALUES (?, ?, ?)")
    .bind(userId, scheduleId, Date.now())
    .run();
  return true;
}

/** お気に入りを解除 (冪等)。未削除のスケジュールが無ければ false。 */
export async function removeFavorite(db: D1Like, userId: string, scheduleId: string): Promise<boolean> {
  if (!(await scheduleExists(db, scheduleId))) return false;
  await db.prepare("DELETE FROM schedule_favorites WHERE user_id = ? AND schedule_id = ?").bind(userId, scheduleId).run();
  return true;
}
