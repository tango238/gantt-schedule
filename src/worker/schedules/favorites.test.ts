import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../auth/crypto";
import type { AppEnv, Env } from "../env";
import { csrf, requireAuth } from "../middleware";
import { scheduleRoutes } from "./routes";

// 本物のマイグレーション (全部) を node:sqlite に流して、お気に入り API を通しで検証する。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function d1(sqlite: InstanceType<typeof DatabaseSync>) {
  const stmt = (sql: string, args: unknown[] = []): unknown => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => sqlite.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

const ORIGIN = "http://localhost";
const A = "A".repeat(22);
const B = "B".repeat(22);
const C = "C".repeat(22);

let sqlite: InstanceType<typeof DatabaseSync>;
let env: Env;
let app: Hono<AppEnv>;
let alice: string, bob: string;

async function login(email: string): Promise<string> {
  const token = "tok-" + email;
  const u = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
  sqlite.prepare("INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,0,?)").run(await sha256Hex(token), u.id, Date.now() + 1e9);
  return "session=" + token;
}
function req(method: string, path: string, cookie?: string, headers: Record<string, string> = {}) {
  return app.request(ORIGIN + path, { method, headers: { ...(cookie ? { cookie } : {}), origin: ORIGIN, ...headers } }, env);
}
const put = (id: string, cookie?: string) => req("PUT", `/api/schedules/${id}/favorite`, cookie);
const del = (id: string, cookie?: string) => req("DELETE", `/api/schedules/${id}/favorite`, cookie);
type Item = { id: string; favorite: boolean };
const list = async (cookie: string) => ((await (await req("GET", "/api/schedules", cookie)).json()) as { schedules: Item[] }).schedules;
const favs = async (cookie: string) => (await list(cookie)).filter((s) => s.favorite).map((s) => s.id).sort();

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const dir = `${import.meta.dirname}/../../../migrations`;
  for (const f of readdirSync(dir).sort()) sqlite.exec(readFileSync(`${dir}/${f}`, "utf8"));
  const addUser = (id: string, email: string, name: string) =>
    sqlite.prepare("INSERT INTO users (id,email,name,hd,created_at,last_login_at) VALUES (?,?,?,?,0,1)").run(id, email, name, "corp.com");
  addUser("u-alice", "alice@corp.com", "Alice");
  addUser("u-bob", "bob@corp.com", "Bob");
  [A, B, C].forEach((sid, i) =>
    sqlite
      .prepare("INSERT INTO schedules (id,name,doc,rev,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,1,'u-alice',0,'u-alice',?)")
      .run(sid, "P" + sid[0], JSON.stringify({ project: { name: "P" }, tasks: [] }), 100 - i),
  );
  env = { DB: d1(sqlite), ALLOWED_DOMAINS: "corp.com", ADMIN_EMAILS: "" } as unknown as Env;
  app = new Hono<AppEnv>();
  app.use("*", csrf);
  app.use("/api/*", requireAuth);
  app.route("/api/schedules", scheduleRoutes);
  alice = await login("alice@corp.com");
  bob = await login("bob@corp.com");
});

describe("お気に入り API", () => {
  it("初期状態は全部 false で、一覧の並び (更新の新しい順) は変わらない", async () => {
    const l = await list(bob);
    expect(l.map((s) => s.id)).toEqual([A, B, C]);
    expect(l.every((s) => s.favorite === false)).toBe(true);
  });
  it("追加すると自分の一覧だけ favorite: true。他ユーザーには見えない・影響しない", async () => {
    const r = await put(A, bob);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ favorite: true });
    expect(await favs(bob)).toEqual([A]);
    expect(await favs(alice)).toEqual([]);
    await put(B, alice);
    expect(await favs(alice)).toEqual([B]);
    expect(await favs(bob)).toEqual([A]);
    // 並びはサーバーでは変えない
    expect((await list(bob)).map((s) => s.id)).toEqual([A, B, C]);
  });
  it("追加は冪等 (2 回押しても 1 行)", async () => {
    expect((await put(A, bob)).status).toBe(200);
    expect((await put(A, bob)).status).toBe(200);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_favorites").get()).toEqual({ n: 1 });
  });
  it("解除は冪等で、他人のお気に入りは消さない", async () => {
    await put(A, bob);
    await put(A, alice);
    const r = await del(A, bob);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ favorite: false });
    expect((await del(A, bob)).status).toBe(200);
    expect(await favs(bob)).toEqual([]);
    expect(await favs(alice)).toEqual([A]);
  });
  it("存在しない・ID 形式が不正・論理削除済みは 404", async () => {
    expect((await put("Z".repeat(22), bob)).status).toBe(404);
    expect((await del("Z".repeat(22), bob)).status).toBe(404);
    expect((await put("short", bob)).status).toBe(404);
    sqlite.prepare("UPDATE schedules SET deleted_at = 1 WHERE id = ?").run(C);
    expect((await put(C, bob)).status).toBe(404);
    expect((await del(C, bob)).status).toBe(404);
  });
  it("論理削除するとお気に入り行は残り、一覧には出ず、復元で戻る", async () => {
    await put(B, bob);
    sqlite.prepare("UPDATE schedules SET deleted_at = 1 WHERE id = ?").run(B);
    expect((await list(bob)).map((s) => s.id)).toEqual([A, C]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_favorites").get()).toEqual({ n: 1 });
    sqlite.prepare("UPDATE schedules SET deleted_at = NULL WHERE id = ?").run(B);
    expect(await favs(bob)).toEqual([B]);
  });
  it("GET /api/schedules/:id にも自分にとっての favorite が入る", async () => {
    await put(A, bob);
    const get = async (cookie: string) => (await (await req("GET", `/api/schedules/${A}`, cookie)).json()) as { favorite: boolean };
    expect((await get(bob)).favorite).toBe(true);
    expect((await get(alice)).favorite).toBe(false);
  });
  it("未ログインは 401", async () => {
    expect((await put(A)).status).toBe(401);
    expect((await del(A)).status).toBe(401);
  });
  it("CSRF: 別オリジンは 403、Origin 無し + Sec-Fetch-Site: cross-site も 403", async () => {
    expect((await req("PUT", `/api/schedules/${A}/favorite`, bob, { origin: "http://evil.example" })).status).toBe(403);
    expect((await req("DELETE", `/api/schedules/${A}/favorite`, bob, { origin: "http://evil.example" })).status).toBe(403);
    const r = await app.request(ORIGIN + `/api/schedules/${A}/favorite`, { method: "PUT", headers: { cookie: bob, "sec-fetch-site": "cross-site" } }, env);
    expect(r.status).toBe(403);
    expect(await favs(bob)).toEqual([]);
  });
  it("他ユーザー ID をクエリ・ボディで渡してもセッションのユーザーにだけ作用する", async () => {
    await app.request(ORIGIN + `/api/schedules/${A}/favorite?userId=u-alice`, { method: "PUT", headers: { cookie: bob, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ userId: "u-alice" }) }, env);
    expect(await favs(alice)).toEqual([]);
    expect(await favs(bob)).toEqual([A]);
  });
});
