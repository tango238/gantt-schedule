import { Hono } from "hono";
import type { AppEnv } from "../env";
import { validName } from "../../shared/name";
import { autoVersionName } from "../room/core";
import { scheduleExists } from "./repo";
import {
  VERSION_NAME_MAX,
  deleteManualVersion,
  getVersion,
  listVersions,
  type VersionsDb,
} from "./versions";

/**
 * バージョン API (/api/schedules/:id/versions ...)。全ルート要ログイン・CSRF 検査は共通ミドルウェア。
 * doc を読み書きする操作 (作成・復元) は Durable Object (スケジュールごとに 1 個) を経由して、コマンドと直列化する。
 */
export const versionRoutes = new Hono<AppEnv>();

const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const vdb = (c: { env: { DB: D1Database } }) => c.env.DB as unknown as VersionsDb;
const noStore = (c: { header(k: string, v: string): void }) => c.header("cache-control", "no-store");
const room = (c: { env: AppEnv["Bindings"] }, id: string) => c.env.SCHEDULE_ROOM.get(c.env.SCHEDULE_ROOM.idFromName(id));

/** 未削除のスケジュールの id か。不正な形式・無い・削除済みは false (404 にする)。 */
async function validSchedule(c: { env: AppEnv["Bindings"] }, id: string): Promise<boolean> {
  return ID_PATTERN.test(id) && (await scheduleExists(c.env.DB, id));
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

versionRoutes.get("/:id/versions", async (c) => {
  const id = c.req.param("id");
  if (!(await validSchedule(c, id))) return c.json({ error: "not_found" }, 404);
  noStore(c);
  return c.json({ versions: await listVersions(vdb(c), id) });
});

/**
 * 手動: body `{name}` (1〜100 文字、制御文字なし)。
 * 自動: body `{kind:"auto", reason:"ai"}` のみ (AI 適用の直前)。名前はサーバーが「AI 適用前の自動保存 YYYY-MM-DD HH:mm」と付ける。
 * 直前の自動と同一内容なら新規作成せず、その既存バージョンの id を created:false (200) で返す。
 */
versionRoutes.post("/:id/versions", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const kind = body.kind ?? "manual";
  let name: string | null;
  if (kind === "manual") {
    name = validName(body.name, VERSION_NAME_MAX);
    if (name === null) return c.json({ error: "invalid_body", message: `name must be 1-${VERSION_NAME_MAX} characters without control characters` }, 400);
  } else if (kind === "auto") {
    if (body.reason !== "ai" || body.name !== undefined) return c.json({ error: "invalid_body", message: 'auto requires reason "ai" and takes no name' }, 400);
    name = autoVersionName("AI 適用前の自動保存", Date.now());
  } else {
    return c.json({ error: "invalid_body", message: "kind must be manual or auto" }, 400);
  }
  if (!(await validSchedule(c, id))) return c.json({ error: "not_found" }, 404);
  const user = c.var.user;
  const r = await room(c, id).createVersion({ userId: user.id, name: user.name }, id, { name, kind });
  if (!r.ok) return c.json({ error: r.error }, r.status);
  noStore(c);
  return c.json({ id: r.id, created: r.created }, r.created ? 201 : 200);
});

versionRoutes.get("/:id/versions/:versionId", async (c) => {
  const id = c.req.param("id");
  const vid = c.req.param("versionId");
  const v = ID_PATTERN.test(id) && ID_PATTERN.test(vid) ? await getVersion(vdb(c), id, vid) : null;
  if (!v) return c.json({ error: "not_found" }, 404);
  noStore(c);
  return c.json(v);
});

versionRoutes.post("/:id/versions/:versionId/restore", async (c) => {
  const id = c.req.param("id");
  const vid = c.req.param("versionId");
  if (!ID_PATTERN.test(vid) || !(await validSchedule(c, id))) return c.json({ error: "not_found" }, 404);
  const user = c.var.user;
  const r = await room(c, id).restoreVersion({ userId: user.id, name: user.name }, id, vid);
  noStore(c);
  if (r.ok) return c.json({ ok: true, changed: r.changed, rev: r.rev });
  const { status, ok: _ok, ...rest } = r as unknown as { status: number; ok: false } & Record<string, unknown>;
  return c.json(rest, status as 404 | 409 | 413 | 422 | 400);
});

versionRoutes.delete("/:id/versions/:versionId", async (c) => {
  const id = c.req.param("id");
  const vid = c.req.param("versionId");
  const out = ID_PATTERN.test(id) && ID_PATTERN.test(vid) ? await deleteManualVersion(vdb(c), id, vid) : "not_found";
  if (out === "not_found") return c.json({ error: "not_found" }, 404);
  if (out === "auto") return c.json({ error: "auto_version_not_deletable" }, 409);
  noStore(c);
  return c.json({ ok: true });
});
