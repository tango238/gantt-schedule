import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../shared/engine";
import type { GanttDocument } from "../../shared/model/types";
import { sha256Hex } from "../auth/crypto";
import type { AppEnv, Env } from "../env";
import { csrf, requireAdmin, requireAuth } from "../middleware";
import { adminRoutes } from "../admin/routes";
import { scheduleRoutes } from "../schedules/routes";
import { userRoutes } from "../users/routes";
import { COMMENTS_PER_TASK_MAX, validCommentBody } from "./repo";

// 本物のマイグレーションを node:sqlite に流して、認証から API までを通しで検証する。
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
const SID = "S".repeat(22);
const OTHER_SID = "T".repeat(22);
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";

let sqlite: InstanceType<typeof DatabaseSync>;
let env: Env;
let app: Hono<AppEnv>;
let notified: Array<{ room: string; taskId: string }>;
let failNotify = false;
let alice: string, bob: string, boss: string;

async function login(email: string): Promise<string> {
  const token = "tok-" + email;
  const u = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
  sqlite.prepare("INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,0,?)").run(await sha256Hex(token), u.id, Date.now() + 1e9);
  return "session=" + token;
}
function req(method: string, path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(
    ORIGIN + path,
    {
      method,
      headers: { ...(cookie ? { cookie } : {}), origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    },
    env,
  );
}
const post = (sid: string, task: string, cookie: string, body: unknown) => req("POST", `/api/schedules/${sid}/tasks/${task}/comments`, cookie, body);
const list = async (sid: string, task: string, cookie: string) =>
  ((await (await req("GET", `/api/schedules/${sid}/tasks/${task}/comments`, cookie)).json()) as { comments: Array<Record<string, unknown>> }).comments;

function docWith(...ids: string[]): GanttDocument {
  const d = createEmptyDocument({ projectName: "P" });
  delete d.view;
  d.tasks = ids.map((id) => ({ id, parentId: null, name: id, start: "2026-11-12", end: "2026-11-12", progress: 0, resourceIds: [], dependencies: [] }));
  return d;
}

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const f of ["0001_init.sql"]) {
    sqlite.exec(readFileSync(`${import.meta.dirname}/../../../migrations/${f}`, "utf8"));
  }
  const addUser = (id: string, email: string, name: string) =>
    sqlite.prepare("INSERT INTO users (id,email,name,hd,created_at,last_login_at) VALUES (?,?,?,?,0,1)").run(id, email, name, "corp.com");
  addUser("u-alice", "alice@corp.com", "Alice");
  addUser("u-bob", "bob@corp.com", "Bob");
  addUser("u-boss", "boss@corp.com", "Boss");
  for (const sid of [SID, OTHER_SID]) {
    sqlite
      .prepare("INSERT INTO schedules (id,name,doc,rev,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,1,'u-alice',0,'u-alice',0)")
      .run(sid, "P", JSON.stringify(docWith(T1, T2)));
  }
  notified = [];
  failNotify = false;
  env = {
    DB: d1(sqlite),
    ALLOWED_DOMAINS: "corp.com",
    ADMIN_EMAILS: "boss@corp.com",
    SCHEDULE_ROOM: {
      idFromName: (n: string) => n,
      get: (room: string) => ({
        commentsChanged: async (taskId: string) => {
          if (failNotify) throw new Error("do down");
          notified.push({ room, taskId });
        },
      }),
    },
  } as unknown as Env;
  app = new Hono<AppEnv>();
  app.use("*", csrf);
  app.use("/api/*", requireAuth);
  app.route("/api/users", userRoutes);
  app.route("/api/schedules", scheduleRoutes);
  app.use("/api/admin/*", requireAdmin);
  app.route("/api/admin", adminRoutes);
  alice = await login("alice@corp.com");
  bob = await login("bob@corp.com");
  boss = await login("boss@corp.com");
});

describe("本文の検査", () => {
  it.each([
    ["  hi  ", "hi"],
    ["a\r\nb", "a\nb"],
    ["タブ\tあり", "タブ\tあり"],
    ["x".repeat(4000), "x".repeat(4000)],
    ["あ".repeat(4000), "あ".repeat(4000)],
    ["😀".repeat(4000), "😀".repeat(4000)],
  ])("受理: %s", (input, out) => expect(validCommentBody(input)).toBe(out));
  it.each([["", 1], ["   \n ", 1], ["x".repeat(4001), 1], ["😀".repeat(4001), 1], ["a\u0000b", 1], ["a\u001bb", 1], ["a\u0085b", 1], ["a\u009fb", 1], ["a\u2028b", 1], ["a\u202eb", 1], ["a\u202ab", 1], ["a\u2066b", 1], ["a\u2069b", 1]])("拒否: %j", (v) =>
    expect(validCommentBody(v)).toBeNull(),
  );
  it.each([null, undefined, 5, {}, []])("文字列以外 (%j) は拒否", (v) => expect(validCommentBody(v)).toBeNull());
});

describe("認証・CSRF", () => {
  it("未ログインは全エンドポイントで 401", async () => {
    for (const [m, p, b] of [
      ["GET", `/api/schedules/${SID}/comment-counts`],
      ["GET", `/api/schedules/${SID}/tasks/${T1}/comments`],
      ["POST", `/api/schedules/${SID}/tasks/${T1}/comments`, { body: "x" }],
      ["PATCH", `/api/schedules/${SID}/comments/${"c".repeat(20)}`, { body: "x" }],
      ["DELETE", `/api/schedules/${SID}/comments/${"c".repeat(20)}`],
      ["GET", "/api/users"],
    ] as Array<[string, string, unknown?]>) {
      expect((await req(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
    }
  });
  it("別オリジンからの変更系は 403", async () => {
    const r = await req("POST", `/api/schedules/${SID}/tasks/${T1}/comments`, alice, { body: "x" }, { origin: "http://evil.example" });
    expect(r.status).toBe(403);
  });
});

describe("作成と一覧", () => {
  it("作成者と日時はサーバーが決める (リクエストの値は無視)。一覧は古い順", async () => {
    const before = Date.now();
    const r = await post(SID, T1, alice, { body: "  最初\nのコメント  ", userId: "u-bob", createdAt: 1, author: { id: "u-bob", name: "X" }, mine: false });
    expect(r.status).toBe(201);
    const c = ((await r.json()) as { comment: Record<string, any> }).comment;
    expect(c).toMatchObject({ taskId: T1, body: "最初\nのコメント", updatedAt: null, author: { id: "u-alice", name: "Alice" }, mine: true });
    expect(c.createdAt).toBeGreaterThanOrEqual(before);
    await post(SID, T1, bob, { body: "二番目" });
    const a = await list(SID, T1, alice);
    expect(a.map((x) => x.body)).toEqual(["最初\nのコメント", "二番目"]);
    expect(a.map((x) => x.mine)).toEqual([true, false]);
    const b = await list(SID, T1, bob);
    expect(b.map((x) => x.mine)).toEqual([false, true]);
    expect(b[1]!.author).toEqual({ id: "u-bob", name: "Bob" });
  });
  it("コメントの JSON にメールを含めない", async () => {
    await post(SID, T1, alice, { body: "x" });
    const text = await (await req("GET", `/api/schedules/${SID}/tasks/${T1}/comments`, bob)).text();
    expect(text).not.toContain("@corp.com");
  });
  it("HTML っぽい本文もそのまま保存・返却する (描画側で文字列として扱う)", async () => {
    await post(SID, T1, alice, { body: "<img src=x onerror=alert(1)>" });
    expect((await list(SID, T1, alice))[0]!.body).toBe("<img src=x onerror=alert(1)>");
  });
  it.each([[{ body: "" }], [{ body: "   " }], [{ body: "x".repeat(4001) }], [{ body: 5 }], [{}], ["[1]"], ["not json"]])("不正な本文 %j は 400", async (b) => {
    expect((await post(SID, T1, alice, b)).status).toBe(400);
  });
  it("存在しない・削除済みスケジュール / 現在の doc にないタスク / 不正な ID は 404", async () => {
    expect((await post("Z".repeat(22), T1, alice, { body: "x" })).status).toBe(404);
    expect((await post(SID, GONE, alice, { body: "x" })).status).toBe(404);
    expect((await post(SID, "not-a-uuid", alice, { body: "x" })).status).toBe(404);
    sqlite.prepare("UPDATE schedules SET deleted_at = 5 WHERE id = ?").run(SID);
    expect((await post(SID, T1, alice, { body: "x" })).status).toBe(404);
    expect((await req("GET", `/api/schedules/${SID}/tasks/${T1}/comments`, alice)).status).toBe(404);
    expect((await req("GET", `/api/schedules/${SID}/comment-counts`, alice)).status).toBe(404);
  });
  it("タスクIDは大文字小文字を区別せず、小文字で保存する", async () => {
    expect((await post(SID, T1.toUpperCase(), alice, { body: "x" })).status).toBe(201);
    expect((await list(SID, T1, alice))).toHaveLength(1);
    expect((await list(SID, T1.toUpperCase(), alice))).toHaveLength(1);
  });
  it("別スケジュールのコメントとは混ざらない", async () => {
    await post(SID, T1, alice, { body: "a" });
    await post(OTHER_SID, T1, alice, { body: "b" });
    expect((await list(SID, T1, alice)).map((c) => c.body)).toEqual(["a"]);
  });
  it("カテゴリにもコメントできる (task id であれば種別は問わない)", async () => {
    const d = docWith(T1);
    d.tasks.push({ id: T2, kind: "category", parentId: null, name: "cat", resourceIds: [], dependencies: [] });
    sqlite.prepare("UPDATE schedules SET doc = ? WHERE id = ?").run(JSON.stringify(d), SID);
    expect((await post(SID, T2, alice, { body: "x" })).status).toBe(201);
  });
  it("1 タスク 500 件まで。超えたら 409 で作成されない。他のタスクは影響を受けない", async () => {
    const ins = sqlite.prepare("INSERT INTO task_comments (id,schedule_id,task_id,user_id,body,created_at) VALUES (?,?,?,?,?,?)");
    for (let i = 0; i < COMMENTS_PER_TASK_MAX - 1; i++) ins.run("c" + String(i).padStart(20, "0"), SID, T1, "u-alice", "x", i);
    expect((await post(SID, T1, alice, { body: "500th" })).status).toBe(201);
    const over = await post(SID, T1, bob, { body: "501st" });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: "comment_limit", limit: 500 });
    expect((sqlite.prepare("SELECT COUNT(*) n FROM task_comments WHERE task_id = ?").get(T1) as { n: number }).n).toBe(500);
    expect((await post(SID, T2, bob, { body: "ok" })).status).toBe(201);
    // 削除すれば再び書ける
    const mine = (await list(SID, T1, alice)).find((c) => c.body === "500th")!;
    expect((await req("DELETE", `/api/schedules/${SID}/comments/${mine.id}`, alice)).status).toBe(200);
    expect((await post(SID, T1, bob, { body: "again" })).status).toBe(201);
  });
});

describe("件数", () => {
  it("タスク別の件数を返す。コメントの無いタスクは含まない", async () => {
    await post(SID, T1, alice, { body: "a" });
    await post(SID, T1, bob, { body: "b" });
    await post(SID, T2, bob, { body: "c" });
    await post(OTHER_SID, T2, bob, { body: "d" });
    const r = await req("GET", `/api/schedules/${SID}/comment-counts`, alice);
    expect(await r.json()).toEqual({ counts: { [T1]: 2, [T2]: 1 } });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("タスクが doc から消えてもコメントは残り、戻れば再び見える", async () => {
    await post(SID, T1, alice, { body: "残る" });
    sqlite.prepare("UPDATE schedules SET doc = ? WHERE id = ?").run(JSON.stringify(docWith(T2)), SID);
    expect((await list(SID, T1, alice)).map((c) => c.body)).toEqual(["残る"]);
    expect((await post(SID, T1, alice, { body: "もう書けない" })).status).toBe(404);
    sqlite.prepare("UPDATE schedules SET doc = ? WHERE id = ?").run(JSON.stringify(docWith(T1, T2)), SID);
    expect((await list(SID, T1, alice)).map((c) => c.body)).toEqual(["残る"]);
  });
});

describe("編集と削除は書いた本人だけ", () => {
  let cid: string;
  beforeEach(async () => {
    const r = await post(SID, T1, alice, { body: "original" });
    cid = ((await r.json()) as { comment: { id: string } }).comment.id;
    notified = [];
  });
  const patch = (cookie: string, body: unknown, sid = SID, id = cid) => req("PATCH", `/api/schedules/${sid}/comments/${id}`, cookie, body);
  const del = (cookie: string, sid = SID, id = cid) => req("DELETE", `/api/schedules/${sid}/comments/${id}`, cookie);
  const bodyOf = () => (sqlite.prepare("SELECT body, updated_at u FROM task_comments WHERE id = ?").get(cid) as { body: string; u: number | null } | undefined);

  it("本人は編集できる (updatedAt が付く)。作成者と createdAt は変わらない", async () => {
    const before = ((await list(SID, T1, alice))[0] as { createdAt: number }).createdAt;
    const r = await patch(alice, { body: " edited ", author: { id: "u-bob" } });
    expect(r.status).toBe(200);
    const c = ((await r.json()) as { comment: Record<string, any> }).comment;
    expect(c).toMatchObject({ id: cid, body: "edited", author: { id: "u-alice" }, mine: true, createdAt: before });
    expect(typeof c.updatedAt).toBe("number");
    expect(notified).toEqual([{ room: SID, taskId: T1 }]);
  });
  it("内容が同じなら編集済みにしない", async () => {
    const r = await patch(alice, { body: "original" });
    expect(r.status).toBe(200);
    expect(bodyOf()!.u).toBeNull();
    expect(notified).toEqual([]);
  });
  it("他人の編集は 403 で、内容は変わらない (管理者でも)", async () => {
    expect((await patch(bob, { body: "hijack" })).status).toBe(403);
    expect((await patch(boss, { body: "hijack" })).status).toBe(403);
    expect(bodyOf()).toEqual({ body: "original", u: null });
    expect(notified).toEqual([]);
  });
  it("他人の削除は 403 で、残る (管理者でも)", async () => {
    expect((await del(bob)).status).toBe(403);
    expect((await del(boss)).status).toBe(403);
    expect(bodyOf()).toBeDefined();
    expect(notified).toEqual([]);
  });
  it("本人は削除できる (物理削除)。通知され、もう一度は 404", async () => {
    expect((await del(alice)).status).toBe(200);
    expect(bodyOf()).toBeUndefined();
    expect(notified).toEqual([{ room: SID, taskId: T1 }]);
    expect((await del(alice)).status).toBe(404);
    expect((await patch(alice, { body: "x" })).status).toBe(404);
  });
  it("別スケジュールの URL からは触れない (404)", async () => {
    expect((await patch(alice, { body: "x" }, OTHER_SID)).status).toBe(404);
    expect((await del(alice, OTHER_SID)).status).toBe(404);
    expect(bodyOf()).toBeDefined();
  });
  it("不正な本文は 400。存在しない ID・削除済みスケジュールは 404", async () => {
    expect((await patch(alice, { body: "" })).status).toBe(400);
    expect((await patch(alice, { body: "x".repeat(4001) })).status).toBe(400);
    expect((await patch(alice, { body: "x" }, SID, "n".repeat(20))).status).toBe(404);
    sqlite.prepare("UPDATE schedules SET deleted_at = 5 WHERE id = ?").run(SID);
    expect((await patch(alice, { body: "x" })).status).toBe(404);
    expect((await del(alice)).status).toBe(404);
  });
});

describe("通知", () => {
  it("作成のあと Durable Object に taskId で通知する", async () => {
    await post(SID, T1, alice, { body: "x" });
    expect(notified).toEqual([{ room: SID, taskId: T1 }]);
  });
  it("通知が失敗してもコメントは保存され、成功を返す", async () => {
    failNotify = true;
    const r = await post(SID, T1, alice, { body: "保存される" });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { comment: { id: string } }).comment.id;
    expect((await list(SID, T1, alice)).map((c) => c.body)).toEqual(["保存される"]);
    expect((await req("PATCH", `/api/schedules/${SID}/comments/${id}`, alice, { body: "編集" })).status).toBe(200);
    expect((await req("DELETE", `/api/schedules/${SID}/comments/${id}`, alice)).status).toBe(200);
  });
  it("作成が拒否されたとき (404 / 400 / 上限) は通知しない", async () => {
    await post(SID, GONE, alice, { body: "x" });
    await post(SID, T1, alice, { body: "" });
    expect(notified).toEqual([]);
  });
});

describe("ユーザー一覧 (/api/users)", () => {
  it("ログイン済みなら誰でも取得でき、id・name・email だけを返す", async () => {
    const r = await req("GET", "/api/users", bob);
    expect(r.status).toBe(200);
    const { users } = (await r.json()) as { users: Array<Record<string, unknown>> };
    expect(users.map((u) => u.name)).toEqual(["Alice", "Bob", "Boss"]);
    expect(Object.keys(users[0]!).sort()).toEqual(["email", "id", "name"]);
    expect(users[0]).toEqual({ id: "u-alice", name: "Alice", email: "alice@corp.com" });
  });
  it("管理者用の一覧 (/api/admin/users) は管理者だけ。一般ユーザーは 403", async () => {
    expect((await req("GET", "/api/admin/users", bob)).status).toBe(403);
    expect((await req("GET", "/api/admin/users", boss)).status).toBe(200);
  });
});

describe("リクエストボディの上限 (コメントだけ 64KB。他のルートは変わらない)", () => {
  const bigDoc = (bytes: number) => {
    const d = docWith(T1);
    d.project.description = "a".repeat(bytes);
    return d;
  };
  it("100KB / 500KB の doc の JSON インポートと作成は 201 (コメントの上限の影響を受けない)", async () => {
    for (const size of [100 * 1024, 500 * 1024]) {
      const r = await req("POST", "/api/schedules", alice, { doc: bigDoc(size) });
      expect(r.status, `import ${size}`).toBe(201);
    }
  });
  it("複製 (copyFrom) も大きな doc で 201", async () => {
    sqlite.prepare("UPDATE schedules SET doc = ? WHERE id = ?").run(JSON.stringify(bigDoc(200 * 1024)), SID);
    expect((await req("POST", "/api/schedules", alice, { copyFrom: SID })).status).toBe(201);
  });
  it("バージョン・エクスポート系 (versions) の既存の上限 (2MB) のままで、64KB 超でも 413 にならない", async () => {
    const r = await req("POST", `/api/schedules/${SID}/versions`, alice, { name: "x".repeat(100 * 1024) });
    expect(r.status).toBe(400); // 名前の検査で拒否 (413 ではない)
    const huge = await req("POST", "/api/schedules", alice, { doc: bigDoc(2 * 1024 * 1024 + 10) });
    expect(huge.status).toBe(413); // 従来どおり 2MB で止まる
  });
  it("コメント本文の過大なボディは 413 のまま (POST / PATCH)", async () => {
    const big = { body: "x".repeat(70 * 1024) };
    expect((await post(SID, T1, alice, big)).status).toBe(413);
    const ok = await post(SID, T1, alice, { body: "x" });
    const id = ((await ok.json()) as { comment: { id: string } }).comment.id;
    expect((await req("PATCH", `/api/schedules/${SID}/comments/${id}`, alice, big)).status).toBe(413);
  });
});
