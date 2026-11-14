import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv, Env } from "../env";
import { sha256Hex } from "../auth/crypto";
import { csrf, requireAdmin, requireAuth } from "../middleware";
import { adminRoutes } from "./routes";

// 本物のマイグレーションを node:sqlite に流して、認証 (requireAuth の再判定) から管理 API までを通しで検証する。
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

let sqlite: InstanceType<typeof DatabaseSync>;
let env: Env;
let app: Hono<AppEnv>;
const ORIGIN = "http://localhost";

const SID = "A".repeat(20); // 新規スケジュール ID 形式 (16-64 文字)
async function login(email: string): Promise<string> {
  const token = "tok-" + email;
  sqlite
    .prepare("UPDATE users SET last_login_at = last_login_at WHERE email = ?")
    .run(email);
  const u = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
  sqlite.prepare("INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,0,?)").run(await sha256Hex(token), u.id, Date.now() + 1e9);
  return "session=" + token;
}

function req(method: string, path: string, cookie?: string, body?: unknown) {
  return app.request(
    ORIGIN + path,
    {
      method,
      headers: { ...(cookie ? { cookie } : {}), origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    env,
  );
}

let admin: string, member: string, outsider: string;

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const f of ["0001_init.sql"]) {
    sqlite.exec(readFileSync(`${import.meta.dirname}/../../../migrations/${f}`, "utf8"));
  }
  const addUser = (id: string, email: string, name: string, hd: string | null, at: number) =>
    sqlite.prepare("INSERT INTO users (id,email,name,hd,created_at,last_login_at) VALUES (?,?,?,?,0,?)").run(id, email, name, hd, at);
  addUser("u-admin", "boss@corp.com", "Boss", "corp.com", 5);
  addUser("u-member", "m@corp.com", "Member", "corp.com", 4);
  addUser("u-out", "out@gmail.com", "Outsider", null, 3);
  addUser("u-gone", "gone@gmail.com", "Gone", null, 2);
  addUser("u-nohd", "x@corp.com", "NoHd", null, 1); // ドメインは合うが hd が保存されていない
  env = { DB: d1(sqlite), ALLOWED_DOMAINS: "corp.com", ADMIN_EMAILS: "boss@corp.com" } as unknown as Env;
  app = new Hono<AppEnv>();
  app.use("*", csrf);
  app.use("/api/*", requireAuth);
  app.use("/api/admin/*", requireAdmin);
  app.route("/api/admin", adminRoutes);
  admin = await login("boss@corp.com");
  member = await login("m@corp.com");
  sqlite.prepare("INSERT INTO allowed_emails (email,added_by,created_at) VALUES ('out@gmail.com','u-admin',10)").run();
  outsider = await login("out@gmail.com");
});

const ENDPOINTS: Array<[string, string, unknown?]> = [
  ["GET", "/api/admin/config"],
  ["GET", "/api/admin/allowed-emails"],
  ["POST", "/api/admin/allowed-emails", { email: "a@b.com" }],
  ["DELETE", "/api/admin/allowed-emails/out%40gmail.com"],
  ["GET", "/api/admin/users"],
  ["GET", "/api/admin/deleted-schedules"],
  ["POST", `/api/admin/schedules/${SID}/restore`],
];

describe("権限", () => {
  it.each(ENDPOINTS)("未ログインは 401: %s %s", async (m, p, b) => {
    expect((await req(m, p, undefined, b)).status).toBe(401);
  });
  it.each(ENDPOINTS)("非管理者は 403 (例外アドレスのユーザーも): %s %s", async (m, p, b) => {
    expect((await req(m, p, member, b)).status).toBe(403);
    expect((await req(m, p, outsider, b)).status).toBe(403);
  });
  it("403 のときは何も変更されない", async () => {
    await req("POST", "/api/admin/allowed-emails", member, { email: "new@x.com" });
    await req("DELETE", "/api/admin/allowed-emails/out%40gmail.com", member);
    expect(sqlite.prepare("SELECT email FROM allowed_emails").all()).toEqual([{ email: "out@gmail.com" }]);
  });
  it("Origin が違う POST は 403 (CSRF)", async () => {
    const r = await app.request(ORIGIN + "/api/admin/allowed-emails", {
      method: "POST",
      headers: { cookie: admin, origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com" }),
    }, env);
    expect(r.status).toBe(403);
  });
});

describe("例外アドレス", () => {
  it("一覧: 追加者の表示名つき", async () => {
    const r = await req("GET", "/api/admin/allowed-emails", admin);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [{ email: "out@gmail.com", createdAt: 10, addedBy: { name: "Boss", email: "boss@corp.com" } }] });
  });
  it("追加: 小文字化・trim、201、追加者が記録される", async () => {
    const r = await req("POST", "/api/admin/allowed-emails", admin, { email: "  New.User@Example.ORG " });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ email: "new.user@example.org", created: true });
    const row = sqlite.prepare("SELECT * FROM allowed_emails WHERE email = 'new.user@example.org'").get() as { added_by: string };
    expect(row.added_by).toBe("u-admin");
  });
  it("重複は冪等: 200 created:false で既存の行は変わらない", async () => {
    const r = await req("POST", "/api/admin/allowed-emails", admin, { email: "OUT@gmail.com" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ email: "out@gmail.com", created: false });
    expect(sqlite.prepare("SELECT created_at, added_by FROM allowed_emails").all()).toEqual([{ created_at: 10, added_by: "u-admin" }]);
  });
  it.each([{ email: "bad" }, { email: "a b@c.com" }, { email: "a@b.com\u0001" }, { email: 1 }, {}, { email: "x".repeat(250) + "@b.com" }])(
    "不正なメールは 400: %j",
    async (body) => {
      expect((await req("POST", "/api/admin/allowed-emails", admin, body)).status).toBe(400);
    },
  );
  it("JSON でない本文は 400、大きすぎる本文は 413", async () => {
    const r = await app.request(ORIGIN + "/api/admin/allowed-emails", { method: "POST", headers: { cookie: admin, origin: ORIGIN, "content-type": "application/json" }, body: "{" }, env);
    expect(r.status).toBe(400);
    expect((await req("POST", "/api/admin/allowed-emails", admin, { email: "a@b.com", pad: "x".repeat(5000) })).status).toBe(413);
  });
  it("削除: 200、2 回目は 404、不正な形式は 400", async () => {
    expect((await req("DELETE", "/api/admin/allowed-emails/out%40gmail.com", admin)).status).toBe(200);
    expect((await req("DELETE", "/api/admin/allowed-emails/out%40gmail.com", admin)).status).toBe(404);
    expect((await req("DELETE", "/api/admin/allowed-emails/nope", admin)).status).toBe(400);
  });
  it("削除されたユーザーは次のアクセスで 401 になり、セッションも消える (追加し直すと新規ログインが必要)", async () => {
    expect((await req("GET", "/api/admin/config", outsider)).status).toBe(403); // 認証は通っている (403 = 管理者ではない)
    await req("DELETE", "/api/admin/allowed-emails/out%40gmail.com", admin);
    expect((await req("GET", "/api/admin/config", outsider)).status).toBe(401);
    expect(sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = 'u-out'").get()).toEqual({ n: 0 });
  });
  it("追加した直後からそのアドレスの既存セッションが有効になる (未失効のセッションがある場合)", async () => {
    sqlite.prepare("INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES ('s-gone','u-gone',0,?)").run(Date.now() + 1e9);
    await req("POST", "/api/admin/allowed-emails", admin, { email: "gone@gmail.com" });
    const token = "tok-gone";
    sqlite.prepare("INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,0,?)").run(await sha256Hex(token), "u-gone", Date.now() + 1e9);
    expect((await req("GET", "/api/admin/config", "session=" + token)).status).toBe(403);
  });
});

describe("ユーザー一覧と設定", () => {
  it("許可理由: admin / domain / exception / 不許可 (hd 未保存はドメイン扱いにしない)", async () => {
    const r = await req("GET", "/api/admin/users", admin);
    const items = ((await r.json()) as { items: Array<{ email: string; access: string | null; lastLoginAt: number }> }).items;
    expect(items.map((i) => [i.email, i.access])).toEqual([
      ["boss@corp.com", "admin"],
      ["m@corp.com", "domain"],
      ["out@gmail.com", "exception"],
      ["gone@gmail.com", null],
      ["x@corp.com", null],
    ]);
  });
  it("例外を外すと不許可になり、ドメイン変更も保存済み hd で反映される", async () => {
    sqlite.prepare("DELETE FROM allowed_emails").run();
    env = { ...env, ALLOWED_DOMAINS: "other.com" } as Env;
    const items = ((await (await req("GET", "/api/admin/users", admin)).json()) as { items: Array<{ email: string; access: string | null }> }).items;
    expect(items.find((i) => i.email === "out@gmail.com")?.access).toBeNull();
    expect(items.find((i) => i.email === "m@corp.com")?.access).toBeNull();
  });
  it("config: 許可ドメインと管理者 (正規化済み)", async () => {
    expect(await (await req("GET", "/api/admin/config", admin)).json()).toEqual({ allowedDomains: ["corp.com"], adminEmails: ["boss@corp.com"] });
  });
});

describe("削除済みスケジュールと復元", () => {
  const ID2 = "B".repeat(22);
  beforeEach(() => {
    const ins = sqlite.prepare("INSERT INTO schedules (id,name,doc,rev,created_by,created_at,updated_by,updated_at,deleted_at,deleted_by) VALUES (?,?,?,?,?,?,?,?,?,?)");
    ins.run(SID, "削除した", "{}", 3, "u-member", 0, "u-member", 0, 200, "u-member");
    ins.run(ID2, "生きている", "{}", 0, "u-member", 0, "u-member", 0, null, null);
    ins.run("C".repeat(22), "古い削除", "{}", 0, "u-member", 0, "u-member", 0, 100, "u-admin");
  });
  it("一覧は削除済みだけ・新しい削除順・削除者つき", async () => {
    const { items } = (await (await req("GET", "/api/admin/deleted-schedules", admin)).json()) as { items: unknown[] };
    expect(items).toEqual([
      { id: SID, name: "削除した", deletedAt: 200, deletedBy: { name: "Member", email: "m@corp.com" } },
      { id: "C".repeat(22), name: "古い削除", deletedAt: 100, deletedBy: { name: "Boss", email: "boss@corp.com" } },
    ]);
  });
  it("復元: deleted_at/deleted_by が NULL、rev や doc はそのまま、一覧から消える", async () => {
    expect((await req("POST", `/api/admin/schedules/${SID}/restore`, admin)).status).toBe(200);
    expect(sqlite.prepare("SELECT deleted_at, deleted_by, rev, doc, name FROM schedules WHERE id = ?").get(SID)).toEqual({
      deleted_at: null, deleted_by: null, rev: 3, doc: "{}", name: "削除した",
    });
    const { items } = (await (await req("GET", "/api/admin/deleted-schedules", admin)).json()) as { items: unknown[] };
    expect(items).toHaveLength(1);
  });
  it("未削除・存在しない・形式不正は 404", async () => {
    for (const id of [ID2, "Z".repeat(22), "short", "a b"]) {
      expect((await req("POST", `/api/admin/schedules/${encodeURIComponent(id)}/restore`, admin)).status).toBe(404);
    }
  });
  it("完全削除の経路は無い (DELETE /schedules/:id は 404)", async () => {
    expect((await req("DELETE", `/api/admin/schedules/${SID}`, admin)).status).toBe(404);
  });
});
