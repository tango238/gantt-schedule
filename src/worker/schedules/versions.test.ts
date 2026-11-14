import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import {
  VERSION_KEEP,
  createVersion,
  deleteManualVersion,
  getVersion,
  listVersions,
  loadVersionDoc,
  restoreDocWithAutoVersion,
  type VersionStatement,
  type VersionsDb,
} from "./versions";

// 実際の SQL を node:sqlite (SQLite) で動かして検証する。D1 も SQLite なので、刈り込み・重複抑止・条件付き INSERT の
// 挙動を本物のマイグレーションに対して確かめられる。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function d1Like(sqlite: InstanceType<typeof DatabaseSync>): VersionsDb {
  const stmt = (sql: string, args: unknown[] = []): VersionStatement => ({
    bind: (...v) => stmt(sql, v),
    first: async <T>() => (sqlite.prepare(sql).get(...(args as never[])) as T | undefined) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(args as never[])) as T[] }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      sqlite.exec("BEGIN");
      try {
        const out: Array<{ meta: { changes: number } }> = [];
        for (const s of list) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

let sqlite: InstanceType<typeof DatabaseSync>;
let db: VersionsDb;

function seed(): void {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const f of ["0001_init.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../../migrations/${f}`, import.meta.url), "utf8"));
  }
  sqlite.exec(`INSERT INTO users (id,email,name,created_at,last_login_at) VALUES ('u1','a@example.com','A',0,0)`);
  for (const id of ["S1", "S2"]) {
    sqlite.exec(
      `INSERT INTO schedules (id,name,doc,rev,created_by,created_at,updated_by,updated_at) VALUES ('${id}','n','{"d":0}',5,'u1',0,'u1',0)`,
    );
  }
  db = d1Like(sqlite);
}
const setDoc = (id: string, doc: string, rev = 5) =>
  sqlite.prepare("UPDATE schedules SET doc = ?, rev = ? WHERE id = ?").run(doc, rev, id);
const rows = (sid: string, kind?: string) =>
  sqlite
    .prepare(
      `SELECT id, name, kind, doc, rev, created_at AS at FROM schedule_versions WHERE schedule_id = ?${kind ? " AND kind = ?" : ""} ORDER BY created_at DESC, id DESC`,
    )
    .all(...(kind ? [sid, kind] : [sid])) as Array<{ id: string; name: string; kind: string; doc: string; rev: number; at: number }>;
const mk = (kind: "manual" | "auto", name: string, now: number, sid = "S1") =>
  createVersion(db, { scheduleId: sid, name, kind, userId: "u1", now });

beforeEach(seed);

describe("createVersion", () => {
  it("現在の doc と rev を写す", async () => {
    const r = await mk("manual", "v1", 100);
    expect(r?.created).toBe(true);
    const row = rows("S1")[0]!;
    expect(row).toMatchObject({ name: "v1", kind: "manual", doc: '{"d":0}', rev: 5, at: 100 });
    setDoc("S1", '{"d":1}', 6);
    expect(rows("S1")[0]!.doc).toBe('{"d":0}'); // 後の更新に影響されない
  });
  it("削除済み・存在しないスケジュールは null", async () => {
    sqlite.exec("UPDATE schedules SET deleted_at = 1 WHERE id = 'S1'");
    expect(await mk("manual", "v", 1)).toBeNull();
    expect(await mk("auto", "v", 1, "NOPE")).toBeNull();
    expect(rows("S1")).toHaveLength(0);
  });
  it("手動は同一内容でも毎回作る。手動は直近 10 件に刈り込まれ、自動には影響しない", async () => {
    expect(VERSION_KEEP).toBe(10);
    await mk("auto", "auto-keep", 1);
    for (let i = 0; i < 12; i++) expect((await mk("manual", "m" + i, 10 + i))?.created).toBe(true);
    expect(rows("S1", "manual").map((r) => r.name)).toEqual(Array.from({ length: 10 }, (_, i) => "m" + (11 - i)));
    expect(rows("S1", "auto")).toHaveLength(1);
  });
  it("自動: 直前の自動と同一内容なら作らず、その既存 id を返す。内容が変われば作る", async () => {
    const a = await mk("auto", "a1", 1);
    const b = await mk("auto", "a2", 2);
    expect(b).toEqual({ id: a!.id, created: false });
    expect(rows("S1", "auto")).toHaveLength(1);
    setDoc("S1", '{"d":1}', 6);
    expect((await mk("auto", "a3", 3))?.created).toBe(true);
    // A -> B -> A: 直前 (B) とは違うので作る
    setDoc("S1", '{"d":0}', 7);
    expect((await mk("auto", "a4", 4))?.created).toBe(true);
    expect(rows("S1", "auto")).toHaveLength(3);
  });
  it("自動の重複判定は手動を見ない", async () => {
    await mk("manual", "m", 1);
    expect((await mk("auto", "a", 2))?.created).toBe(true);
  });
  it("自動は新しい順に 10 件だけ残す (同一 created_at でも件数は 10、手動は残る)", async () => {
    await mk("manual", "keep", 0);
    for (let i = 0; i < 25; i++) {
      setDoc("S1", `{"d":${i + 10}}`, 6 + i);
      expect((await mk("auto", "a" + i, 1000))?.created).toBe(true); // 全部同じ created_at
    }
    expect(rows("S1", "auto")).toHaveLength(VERSION_KEEP);
    expect(rows("S1", "manual")).toHaveLength(1);
    // 同一 created_at のとき残るのは id の大きい 10 件 (DESC 順で固定)
    const kept = rows("S1", "auto").map((r) => r.id);
    expect([...kept].sort().reverse()).toEqual(kept);
  });
  it("自動の刈り込みは created_at の新しい順 (古い方から消える)", async () => {
    for (let i = 0; i < 25; i++) {
      setDoc("S1", `{"d":${i}}`, i);
      await mk("auto", "a" + i, 100 + i);
    }
    expect(rows("S1", "auto").map((r) => r.name)).toEqual(Array.from({ length: 10 }, (_, i) => "a" + (24 - i)));
  });
  it("刈り込みは他のスケジュールの自動に影響しない", async () => {
    for (let i = 0; i < 3; i++) {
      setDoc("S2", `{"d":${i}}`, i);
      await mk("auto", "s2-" + i, i, "S2");
    }
    for (let i = 0; i < 25; i++) {
      setDoc("S1", `{"d":${i}}`, i);
      await mk("auto", "a" + i, 100 + i);
    }
    expect(rows("S2", "auto")).toHaveLength(3);
  });
});

describe("restoreDocWithAutoVersion", () => {
  const params = (over: Partial<Parameters<typeof restoreDocWithAutoVersion>[1]> = {}) => ({
    scheduleId: "S1",
    expectedRev: 5,
    userId: "u1",
    json: '{"d":"restored"}',
    name: "復元後",
    now: 500,
    autoName: "復元前の自動保存",
    ...over,
  });
  it("現在の doc を自動で保存してから置き換える (rev+1, name, updated_by)", async () => {
    expect(await restoreDocWithAutoVersion(db, params())).toBe("ok");
    const s = sqlite.prepare("SELECT doc, rev, name, updated_at FROM schedules WHERE id='S1'").get() as Record<string, unknown>;
    expect(s).toMatchObject({ doc: '{"d":"restored"}', rev: 6, name: "復元後", updated_at: 500 });
    expect(rows("S1")).toHaveLength(1);
    expect(rows("S1")[0]).toMatchObject({ kind: "auto", doc: '{"d":0}', rev: 5, name: "復元前の自動保存" });
  });
  it("rev が違えば何も変えない (自動も作らない)", async () => {
    expect(await restoreDocWithAutoVersion(db, params({ expectedRev: 4 }))).toBe("conflict");
    expect(rows("S1")).toHaveLength(0);
    expect(sqlite.prepare("SELECT doc, rev FROM schedules WHERE id='S1'").get()).toMatchObject({ doc: '{"d":0}', rev: 5 });
  });
  it("削除済みなら conflict", async () => {
    sqlite.exec("UPDATE schedules SET deleted_at = 1 WHERE id = 'S1'");
    expect(await restoreDocWithAutoVersion(db, params())).toBe("conflict");
    expect(rows("S1")).toHaveLength(0);
  });
  it("直前の自動と同一内容なら自動は増やさずに置き換える。自動は 10 件に刈られ、手動は残る", async () => {
    await mk("manual", "手動", 0);
    await mk("auto", "既存", 1);
    expect(await restoreDocWithAutoVersion(db, params())).toBe("ok");
    expect(rows("S1", "auto")).toHaveLength(1);
    for (let i = 0; i < 25; i++) {
      const rev = 6 + i;
      expect(await restoreDocWithAutoVersion(db, params({ expectedRev: rev, json: `{"d":${i}}`, now: 600 + i }))).toBe("ok");
    }
    expect(rows("S1", "auto")).toHaveLength(VERSION_KEEP);
    expect(rows("S1", "manual")).toHaveLength(1);
  });
});

describe("参照系", () => {
  it("一覧は新しい順で doc を含まない。作成者名つき", async () => {
    await mk("manual", "old", 1);
    await mk("manual", "new", 2);
    const list = await listVersions(db, "S1");
    expect(list.map((v) => v.name)).toEqual(["new", "old"]);
    expect(list[0]).toMatchObject({ kind: "manual", rev: 5, createdAt: 2, createdBy: { name: "A", email: "a@example.com" } });
    expect("doc" in list[0]!).toBe(false);
  });
  it("他スケジュールの versionId は取得・復元・削除のどれも null / not_found", async () => {
    const v = (await mk("manual", "s1", 1))!;
    expect(await getVersion(db, "S1", v.id)).toMatchObject({ name: "s1", doc: { d: 0 } });
    expect(await getVersion(db, "S2", v.id)).toBeNull();
    expect(await loadVersionDoc(db, "S2", v.id)).toBeNull();
    expect(await deleteManualVersion(db, "S2", v.id)).toBe("not_found");
    expect(rows("S1")).toHaveLength(1);
  });
  it("削除済みスケジュールのバージョンは見えない", async () => {
    const v = (await mk("manual", "s1", 1))!;
    sqlite.exec("UPDATE schedules SET deleted_at = 1 WHERE id = 'S1'");
    expect(await listVersions(db, "S1")).toEqual([]);
    expect(await getVersion(db, "S1", v.id)).toBeNull();
    expect(await loadVersionDoc(db, "S1", v.id)).toBeNull();
    expect(await deleteManualVersion(db, "S1", v.id)).toBe("not_found");
  });
  it("削除は手動だけ。自動は拒否", async () => {
    const m = (await mk("manual", "m", 1))!;
    const a = (await mk("auto", "a", 2))!;
    expect(await deleteManualVersion(db, "S1", a.id)).toBe("auto");
    expect(rows("S1", "auto")).toHaveLength(1);
    expect(await deleteManualVersion(db, "S1", m.id)).toBe("ok");
    expect(await deleteManualVersion(db, "S1", m.id)).toBe("not_found");
  });
  it("スケジュールを物理削除するとバージョンも消える (ON DELETE CASCADE)", async () => {
    await mk("manual", "m", 1);
    sqlite.exec("DELETE FROM schedules WHERE id = 'S1'");
    expect(rows("S1")).toHaveLength(0);
  });
});
