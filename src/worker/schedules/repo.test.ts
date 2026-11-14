import { describe, expect, it } from "vitest";
import { saveDocAtRev, type D1Like } from "./repo";

function fakeDb(changes: number) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => {
            calls.push({ sql, args });
            return { meta: { changes } };
          },
        }),
      };
    },
  } as unknown as D1Like;
  return { db, calls };
}

describe("saveDocAtRev (楽観ロック)", () => {
  it("rev が一致して更新できたら ok。WHERE は期待 rev と未削除で守られる", async () => {
    const { db, calls } = fakeDb(1);
    expect(await saveDocAtRev(db, "id", 7, "u1", "{}", "n", 123)).toBe("ok");
    expect(calls[0]!.sql).toContain("rev = rev + 1");
    expect(calls[0]!.sql).toContain("rev = ?");
    expect(calls[0]!.sql).toContain("deleted_at IS NULL");
    expect(calls[0]!.args).toEqual(["{}", "n", "u1", 123, "id", 7]);
  });
  it("0 行更新 (rev 不一致・削除済み) は conflict", async () => {
    const { db } = fakeDb(0);
    expect(await saveDocAtRev(db, "id", 7, "u1", "{}", "n", 1)).toBe("conflict");
  });
});
