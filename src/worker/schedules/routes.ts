import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createEmptyDocument, PROJECT_NAME_MAX } from "../../shared/engine";
import type { GanttDocument } from "../../shared/model/types";
import type { AppEnv } from "../env";
import { validName } from "../../shared/name";
import { isLocalHostname } from "../auth/access";
import { requestHostname } from "../auth/session";
import { ROOM_USER_HEADER, type RoomUserInfo } from "../room/core";
import { serializeDoc } from "./apply";
import { addFavorite, createSchedule, getSchedule, listSchedules, removeFavorite, scheduleExists, softDeleteSchedule } from "./repo";
import { validateImportedDoc } from "./validate";
import { versionRoutes } from "./versionRoutes";
import { commentRoutes } from "../comments/routes";

export const NAME_MAX = PROJECT_NAME_MAX;
const COPY_SUFFIX = "のコピー";
/** 複製の名前 (「〜のコピー」)。上限を超えないよう元の名前側を切り詰める。 */
export const copyName = (name: string): string => name.slice(0, NAME_MAX - COPY_SUFFIX.length) + COPY_SUFFIX;
/** リクエストボディの上限。doc 1MB + コマンド周りの余裕。 */
const BODY_MAX = 2 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const scheduleRoutes = new Hono<AppEnv>();

scheduleRoutes.use("*", bodyLimit({ maxSize: BODY_MAX, onError: (c) => c.json({ error: "too_large", limit: BODY_MAX }, 413) }));

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const noStore = (c: { header(k: string, v: string): void }) => c.header("cache-control", "no-store");

scheduleRoutes.route("/", versionRoutes);
scheduleRoutes.route("/", commentRoutes);

scheduleRoutes.get("/", async (c) => {
  noStore(c);
  return c.json({ schedules: await listSchedules(c.env.DB, c.var.user.id) });
});

scheduleRoutes.post("/", async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const given = ["name", "doc", "copyFrom"].filter((k) => body[k] !== undefined);
  if (given.length !== 1) {
    return c.json({ error: "invalid_body", message: "exactly one of name / doc / copyFrom is required" }, 400);
  }

  let doc: GanttDocument;
  let warnings: unknown[] = [];
  if (body.name !== undefined) {
    const name = validName(body.name, NAME_MAX);
    if (name === null) {
      return c.json({ error: "invalid_body", message: `name must be 1-${NAME_MAX} characters without control characters` }, 400);
    }
    doc = createEmptyDocument({ projectName: name });
    delete doc.view;
  } else if (body.doc !== undefined) {
    const v = validateImportedDoc(body.doc);
    if (!v.ok) return c.json({ error: "invalid_document", kind: v.kind, issues: v.issues }, 422);
    doc = v.doc;
    warnings = v.warnings;
  } else {
    if (typeof body.copyFrom !== "string" || !ID_PATTERN.test(body.copyFrom)) return c.json({ error: "not_found" }, 404);
    const src = await getSchedule(c.env.DB, body.copyFrom, c.var.user.id);
    if (!src) return c.json({ error: "not_found" }, 404);
    doc = { ...src.doc, project: { ...src.doc.project, name: copyName(src.name) } };
  }

  const ser = serializeDoc(doc);
  if (!ser.ok) return c.json({ error: ser.error, bytes: ser.bytes, limit: ser.limit }, 413);
  const created = await createSchedule(c.env.DB, c.var.user.id, doc.project.name, ser.json);
  noStore(c);
  return c.json({ ...created, warnings }, 201);
});

scheduleRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const s = ID_PATTERN.test(id) ? await getSchedule(c.env.DB, id, c.var.user.id) : null;
  if (!s) return c.json({ error: "not_found" }, 404);
  noStore(c);
  return c.json(s);
});

// お気に入り (ユーザーごと。常にセッションのユーザーに対して作用する。冪等)。
scheduleRoutes.put("/:id/favorite", async (c) => {
  const id = c.req.param("id");
  if (!ID_PATTERN.test(id) || !(await addFavorite(c.env.DB, c.var.user.id, id))) return c.json({ error: "not_found" }, 404);
  noStore(c);
  return c.json({ favorite: true });
});
scheduleRoutes.delete("/:id/favorite", async (c) => {
  const id = c.req.param("id");
  if (!ID_PATTERN.test(id) || !(await removeFavorite(c.env.DB, c.var.user.id, id))) return c.json({ error: "not_found" }, 404);
  noStore(c);
  return c.json({ favorite: false });
});

/**
 * 同時編集の WebSocket。接続後は requireAuth を通らないので、ここで (1) Origin が自オリジンと一致すること
 * (CSWSH 対策)、(2) スケジュールが存在し未削除であること を確認し、検証済みのユーザー情報を DO へ渡す。
 * 接続後の権限再判定は DO が行う (src/worker/room)。
 */
scheduleRoutes.get("/:id/ws", async (c) => {
  const id = c.req.param("id");
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "upgrade_required" }, 426);
  const origin = c.req.header("origin");
  if (origin === undefined || origin !== new URL(c.req.url).origin) return c.json({ error: "forbidden" }, 403);
  if (!ID_PATTERN.test(id) || !(await scheduleExists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);

  const user = c.var.user;
  const info: RoomUserInfo = {
    scheduleId: id,
    userId: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    sessionId: c.var.sessionId,
    local: isLocalHostname(requestHostname(c)),
  };
  // クライアントが付けた x-room-* は渡さず、検証済みの値だけを新しいヘッダーとして付ける。
  const headers = new Headers();
  for (const k of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"]) {
    const v = c.req.header(k);
    if (v !== undefined) headers.set(k, v);
  }
  headers.set(ROOM_USER_HEADER, encodeURIComponent(JSON.stringify(info)));
  const stub = c.env.SCHEDULE_ROOM.get(c.env.SCHEDULE_ROOM.idFromName(id));
  return stub.fetch(new Request(c.req.url, { headers }));
});

scheduleRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_PATTERN.test(id) || !(await softDeleteSchedule(c.env.DB, id, c.var.user.id))) {
    return c.json({ error: "not_found" }, 404);
  }
  // 接続中の全クライアントへ通知して切断させ、DO のキャッシュを捨てる (D1 の更新は済んでいる)。
  try {
    await c.env.SCHEDULE_ROOM.get(c.env.SCHEDULE_ROOM.idFromName(id)).deleted();
  } catch (e) {
    console.error("room: delete notify failed", e);
  }
  noStore(c);
  return c.json({ ok: true });
});
