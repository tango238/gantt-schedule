import { describe, expect, it } from "vitest";
import { executeCommand, MAX_DAYS, type Command } from "../commands";
import { ctx, doc as mkDoc, task } from "./fixtures";

const base = () =>
  mkDoc([task({ id: "A", start: "2023-05-22", end: "2023-05-23" }), task({ id: "B", start: "2023-05-24", end: "2023-05-25" })]);
const run = (cmd: Command) => executeCommand(base(), cmd, ctx);
const invalid = (field?: string) => expect.objectContaining({ ok: false, code: "INVALID_VALUE", ...(field ? { params: { field } } : {}) });

describe("日数系入力の上限 (±36600)", () => {
  it("moveTask deltaDays", () => {
    expect(run({ type: "moveTask", id: "A", deltaDays: 100000000 })).toEqual(invalid("deltaDays"));
    expect(run({ type: "moveTask", id: "A", deltaDays: -(MAX_DAYS + 1) })).toEqual(invalid("deltaDays"));
    expect(run({ type: "moveTask", id: "A", deltaDays: 1.5 })).toEqual(invalid("deltaDays"));
    expect(run({ type: "moveTask", id: "A", deltaDays: 10 }).ok).toBe(true);
  });
  it("setDuration days", () => {
    expect(run({ type: "setDuration", id: "A", days: 100000000 })).toEqual(invalid("days"));
    expect(run({ type: "setDuration", id: "A", days: 5 }).ok).toBe(true);
  });
  it("上限内でも結果の日付が 4 桁年の有効日付を外れるなら拒否 (doc は変わらない)", () => {
    const d = mkDoc([task({ id: "A", start: "9999-12-30", end: "9999-12-31" })]);
    expect(executeCommand(d, { type: "moveTask", id: "A", deltaDays: MAX_DAYS }, ctx)).toEqual(invalid("date"));
    const d2 = mkDoc([task({ id: "A", start: "0001-01-02", end: "0001-01-03" })]);
    expect(executeCommand(d2, { type: "moveTask", id: "A", deltaDays: -MAX_DAYS }, ctx).ok).toBe(false);
  });
});

describe("色の型検査", () => {
  it("配列などの文字列でない color を拒否する", () => {
    const bad = ["#ffffff"] as unknown as string;
    expect(run({ type: "addColorLabel", name: "x", color: bad })).toEqual(invalid("color"));
    expect(run({ type: "addResource", name: "x", color: bad })).toEqual(invalid("color"));
    expect(run({ type: "addColorLabel", name: "x", color: "#ffffff" }).ok).toBe(true);
  });
});

describe("project.name", () => {
  it("空・空白のみ・201 文字以上は拒否", () => {
    expect(run({ type: "setProjectInfo", name: "" })).toEqual(invalid("name"));
    expect(run({ type: "setProjectInfo", name: "  " })).toEqual(invalid("name"));
    expect(run({ type: "setProjectInfo", name: "a".repeat(201) })).toEqual(invalid("name"));
    expect(run({ type: "setProjectInfo", name: "a".repeat(200) }).ok).toBe(true);
  });
});
