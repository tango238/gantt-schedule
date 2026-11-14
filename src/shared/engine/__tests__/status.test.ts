import { describe, expect, it } from "vitest";
import type { GanttDocument } from "../../model/types";
import { executeCommand, type Command, type CommandOk } from "../commands";
import { loadDocument, prepareForSave } from "../document";
import { buildTreeIndex } from "../hierarchy";
import { allLeavesDone, countOverdue, overdueReasons, statusOf } from "../status";
import { byId, cat, doc, makeCtx, ms, task } from "./fixtures";

function run(d: GanttDocument, cmd: Command, ctx = makeCtx()): CommandOk {
  const r = executeCommand(d, cmd, ctx);
  if (!r.ok) throw new Error(`unexpected error ${r.code}`);
  return r;
}
const failCode = (d: GanttDocument, cmd: Command) => {
  const r = executeCommand(d, cmd, makeCtx());
  if (r.ok) throw new Error("expected failure");
  return r.code;
};

describe("overdueReasons (今日 = 2023-05-22)", () => {
  const T = "2023-05-22";
  it.each([
    // [status, start, end, expected]
    ["todo", "2023-05-21", "2023-05-23", ["startPassed"]],
    ["todo", "2023-05-22", "2023-05-22", []], // 今日が開始・終了: エラーにしない
    ["todo", "2023-05-23", "2023-05-23", []],
    ["todo", "2023-05-20", "2023-05-21", ["startPassed", "endPassed"]], // 両方
    ["todo", "2023-05-22", "2023-05-21", ["endPassed"]], // 終了だけ (start が今日)
    [undefined, "2023-05-21", "2023-05-23", ["startPassed"]], // 省略 = todo
    ["doing", "2023-05-01", "2023-05-23", []], // 進行中は開始日を過ぎていてもエラーでない
    ["doing", "2023-05-01", "2023-05-21", ["endPassed"]],
    ["doing", "2023-05-01", "2023-05-22", []],
    ["done", "2023-05-01", "2023-05-02", []], // 完了はエラーにしない
  ] as const)("%s %s – %s -> %j", (status, start, end, expected) => {
    expect(overdueReasons(status, start, end, T)).toEqual(expected);
  });
});

describe("status: 導出と集計", () => {
  const d = (): GanttDocument =>
    doc([
      cat("C"),
      task({ id: "P", parentId: "C" }),
      task({ id: "a", parentId: "P", start: "2023-05-01", status: "done" }),
      task({ id: "b", parentId: "P", start: "2023-05-02", status: "done" }),
      task({ id: "T1", start: "2023-05-01" }), // 未着手・開始超過 -> エラー
      task({ id: "T2", start: "2023-05-30", status: "doing" }),
      task({ id: "T3", start: "2023-05-01", end: "2023-05-10", status: "doing" }), // 終了超過 -> エラー
      ms("M", "2023-01-01"),
    ]);
  it("statusOf: 省略は todo", () => {
    expect(statusOf(undefined)).toBe("todo");
    expect(statusOf({})).toBe("todo");
    expect(statusOf({ status: "doing" })).toBe("doing");
  });
  it("親は子孫の葉がすべて done のときだけ完了扱い。1 つでも未完了なら違う。葉が無いものは false", () => {
    const doc1 = d();
    expect(allLeavesDone(buildTreeIndex(doc1), "P")).toBe(true);
    byId(doc1, "b").status = "doing";
    expect(allLeavesDone(buildTreeIndex(doc1), "P")).toBe(false);
    expect(allLeavesDone(buildTreeIndex(doc1), "T1")).toBe(false);
  });
  it("countOverdue: 葉タスクだけ (親・カテゴリ・マイルストーン・done は数えない)", () => {
    expect(countOverdue(d(), "2023-05-22")).toBe(2);
    expect(countOverdue(d(), "2023-04-01")).toBe(0);
  });
});

describe("setStatus", () => {
  const base = () => doc([cat("C"), task({ id: "A", start: "2023-05-22" }), task({ id: "P" }), task({ id: "cc", parentId: "P", start: "2023-05-22" })]);
  it("done / doing を設定し、todo は項目を消す。同じ値は変更なし", () => {
    let r = run(base(), { type: "setStatus", id: "A", status: "doing" });
    expect(byId(r.doc, "A").status).toBe("doing");
    expect(run(r.doc, { type: "setStatus", id: "A", status: "doing" }).patches).toEqual([]);
    r = run(r.doc, { type: "setStatus", id: "A", status: "done" });
    r = run(r.doc, { type: "setStatus", id: "A", status: "todo" });
    expect("status" in byId(r.doc, "A")).toBe(false);
    expect(run(base(), { type: "setStatus", id: "A", status: "todo" }).patches).toEqual([]);
  });
  it("親タスク・カテゴリ・存在しない ID・不正な値は拒否", () => {
    expect(failCode(base(), { type: "setStatus", id: "P", status: "done" })).toBe("PARENT_NOT_EDITABLE");
    expect(failCode(base(), { type: "setStatus", id: "C", status: "done" })).toBe("CATEGORY_NOT_EDITABLE");
    expect(failCode(base(), { type: "setStatus", id: "zz", status: "done" })).toBe("TASK_NOT_FOUND");
    expect(failCode(base(), { type: "setStatus", id: "A", status: "x" as never })).toBe("INVALID_VALUE");
  });
  it("duplicateTask は状態を引き継がない (todo に戻る)。サブツリー内の子も同様", () => {
    let d = run(base(), { type: "setStatus", id: "A", status: "done" }).doc;
    d = run(d, { type: "setStatus", id: "cc", status: "doing" }).doc;
    const r1 = run(d, { type: "duplicateTask", id: "A" });
    expect(byId(r1.doc, "N1").status).toBeUndefined();
    expect(byId(r1.doc, "A").status).toBe("done");
    const r2 = run(d, { type: "duplicateTask", id: "P" }, makeCtx());
    expect(r2.doc.tasks.filter((t) => t.status === "doing")).toHaveLength(1);
  });
  it("葉が親になる (indent) と、その status は取り除かれる", () => {
    let d = doc([task({ id: "A", start: "2023-05-22", status: "done" }), task({ id: "B", start: "2023-05-23" })]);
    d = run(d, { type: "indent", id: "B" }).doc;
    expect("status" in byId(d, "A")).toBe(false);
  });
  it("カテゴリが status を持つ doc はエラー (読み込み)", () => {
    const c = cat("C");
    c.status = "done";
    expect(loadDocument(doc([c])).ok).toBe(false);
  });
});

describe("進捗 (progress) の廃止", () => {
  it("setProgress は engine にもう無い (未知のコマンドは何も変えない)", () => {
    const d = doc([task({ id: "A", start: "2023-05-22" })]);
    const r = executeCommand(d, { type: "setProgress", id: "A", progress: 50 } as unknown as Command, makeCtx());
    expect(r.ok && r.patches).toEqual([]);
  });
  it("新規タスクに progress を書かない", () => {
    const r = run(doc([]), { type: "addTask", afterId: null });
    expect("progress" in byId(r.doc, "N1")).toBe(false);
  });
  it("progress 付きの古い doc は読め、値は消さず保持する (書き出しでも残る)。progress なしの doc も読める", () => {
    const old = doc([task({ id: "A", start: "2023-05-22", progress: 40 }), task({ id: "B", start: "2023-05-23" })]);
    const r = loadDocument(structuredClone(old));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(byId(r.doc, "A").progress).toBe(40);
    expect("progress" in byId(r.doc, "B")).toBe(false);
    expect(byId(prepareForSave(r.doc), "A").progress).toBe(40);
    // 他の操作で消えない
    expect(byId(run(r.doc, { type: "setName", id: "A", name: "x" }).doc, "A").progress).toBe(40);
  });
  it("親の progress (古い doc) は読み込みで警告対象にしない (導出値ではなくなった)", () => {
    const raw = doc([{ ...task({ id: "P" }), progress: 10 }, task({ id: "c", parentId: "P", start: "2023-05-22" })]);
    const r = loadDocument(raw);
    expect(r.ok && r.warnings).toEqual([]);
  });
});
