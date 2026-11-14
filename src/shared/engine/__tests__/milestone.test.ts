import { describe, expect, it } from "vitest";
import type { GanttDocument } from "../../model/types";
import { compileCalendar } from "../calendar";
import { executeCommand, type Command, type CommandOk } from "../commands";
import { loadDocument, prepareForSave } from "../document";
import { buildTreeIndex, deriveAll, findCategoryIssues, getDerived, getLeafDescendantsOrSelf, normalizeTopLevel } from "../hierarchy";
import { canAddDependency, findViolations } from "../scheduling";
import { byId, cat, doc, makeCtx, ms, span, task } from "./fixtures";

function run(d: GanttDocument, cmd: Command, ctx = makeCtx()): CommandOk {
  const r = executeCommand(d, cmd, ctx);
  if (!r.ok) throw new Error(`unexpected error ${r.code}`);
  return r;
}
function fail(d: GanttDocument, cmd: Command): string {
  const r = executeCommand(d, cmd, makeCtx());
  if (r.ok) throw new Error("expected failure");
  return r.code;
}
const ids = (d: GanttDocument) => d.tasks.map((t) => t.id);
const WC = compileCalendar({ weekends: [0, 6], holidays: [] });

/** C > [A (task), M (milestone), P > p1] ; D (category) ; T (task, depends on A) ; M2 (top-level milestone) */
const base = (): GanttDocument =>
  doc([
    cat("C"),
    task({ id: "A", parentId: "C", start: "2023-05-22", end: "2023-05-23" }),
    ms("M", "2023-05-27", "C", "締切"), // 土曜日 (稼働日でない)
    task({ id: "P", parentId: "C" }),
    task({ id: "p1", parentId: "P", start: "2023-05-24", end: "2023-05-25" }),
    cat("D"),
    task({ id: "T", start: "2023-05-29", end: "2023-05-30", deps: ["A"] }),
    ms("M2", "2023-06-01"),
  ]);

describe("milestone: 不変条件 (読み込み)", () => {
  const errs = (d: GanttDocument) => {
    const r = loadDocument(structuredClone(d));
    return r.ok ? [] : r.errors.map((e) => [e.code, e.path]);
  };
  const mod = (f: (d: GanttDocument) => void) => {
    const d = base();
    f(d);
    return d;
  };
  it("正しい doc は警告なしで読め、日付はそのまま (稼働日でない日も可)", () => {
    const r = loadDocument(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(span(r.doc, "M")).toEqual(["2023-05-27", "2023-05-27"]);
  });
  it("日付が片方だけなら同じ値で補完し、両方無いと LEAF_NO_DATES", () => {
    const a = mod((d) => { delete byId(d, "M").end; });
    const r = loadDocument(a);
    expect(r.ok && span(r.doc, "M")).toEqual(["2023-05-27", "2023-05-27"]);
    const b = mod((d) => { delete byId(d, "M").start; delete byId(d, "M").end; });
    expect(errs(b)).toContainEqual(["LEAF_NO_DATES", "/tasks/2"]);
  });
  it.each<[string, (d: GanttDocument) => void, string, string]>([
    ["hours", (d) => { byId(d, "M").hours = 1; }, "MILESTONE_FIELD", "/tasks/2/hours"],
    ["status", (d) => { byId(d, "M").status = "done"; }, "MILESTONE_FIELD", "/tasks/2/status"],
    ["dependencies", (d) => { byId(d, "M").dependencies = [{ predecessorId: "A" }]; }, "MILESTONE_FIELD", "/tasks/2/dependencies"],
    ["resourceIds", (d) => { byId(d, "M").resourceIds = ["r"]; }, "MILESTONE_FIELD", "/tasks/2/resourceIds"],
    ["assigneeIds", (d) => { byId(d, "M").assigneeIds = ["u"]; }, "MILESTONE_FIELD", "/tasks/2/assigneeIds"],
    ["期間 (start != end)", (d) => { byId(d, "M").end = "2023-05-28"; }, "MILESTONE_DATE", "/tasks/2"],
    ["タスクの下", (d) => { byId(d, "M").parentId = "A"; }, "MILESTONE_PARENT", "/tasks/2/parentId"],
    ["子を持つ", (d) => { byId(d, "p1").parentId = "M"; }, "MILESTONE_CHILD", "/tasks/2"],
    ["依存の先行", (d) => { byId(d, "T").dependencies = [{ predecessorId: "M" }]; }, "MILESTONE_DEPENDENCY", "/tasks/6/dependencies/0/predecessorId"],
  ])("不正: %s", (_n, f, code, path) => {
    expect(errs(mod(f))).toContainEqual([code, path]);
  });
  it("カテゴリの下のマイルストーン・トップレベルのマイルストーンは有効", () => {
    expect(findCategoryIssues(base())).toEqual([]);
  });
});

describe("addMilestone", () => {
  it("afterId なし: トップレベルの「カテゴリなし」側 (タスクの並び) の末尾。既定名と今日の日付、稼働日補正なし", () => {
    const r = run(base(), { type: "addMilestone", afterId: null }, makeCtx("2023-05-27")); // 土曜
    expect(byId(r.doc, "N1")).toEqual({ id: "N1", kind: "milestone", parentId: null, name: "新しいマイルストーン", start: "2023-05-27", end: "2023-05-27", resourceIds: [], dependencies: [] });
    expect(ids(r.doc).at(-1)).toBe("N1");
    expect(r).toMatchObject({ selection: "N1", editName: true, reveal: ["N1"], createdId: "N1" });
  });
  it("カテゴリを選んでいればその子の末尾", () => {
    const r = run(base(), { type: "addMilestone", afterId: "C" });
    expect(byId(r.doc, "N1").parentId).toBe("C");
    expect(ids(r.doc)).toEqual(["C", "A", "M", "P", "p1", "N1", "D", "T", "M2"]);
    const r2 = run(base(), { type: "addMilestone", afterId: "D" });
    expect(byId(r2.doc, "N1").parentId).toBe("D");
  });
  it("タスク階層の中なら、最も近いカテゴリ階層で、そのタスクのサブツリーの後ろ", () => {
    const r = run(base(), { type: "addMilestone", afterId: "p1" });
    expect(byId(r.doc, "N1").parentId).toBe("C");
    expect(ids(r.doc)).toEqual(["C", "A", "M", "P", "p1", "N1", "D", "T", "M2"]);
    const r2 = run(base(), { type: "addMilestone", afterId: "T" });
    expect(byId(r2.doc, "N1").parentId).toBeNull();
    expect(ids(r2.doc)).toEqual(["C", "A", "M", "P", "p1", "D", "T", "N1", "M2"]);
  });
  it("マイルストーンを選んでいれば、その兄弟として直後 (親は同じ)", () => {
    const r = run(base(), { type: "addMilestone", afterId: "M" });
    expect(byId(r.doc, "N1").parentId).toBe("C");
    expect(ids(r.doc)).toEqual(["C", "A", "M", "N1", "P", "p1", "D", "T", "M2"]);
  });
  it("存在しない afterId は拒否。他のタスクの日付・並びは変わらない", () => {
    expect(fail(base(), { type: "addMilestone", afterId: "zz" })).toBe("TASK_NOT_FOUND");
    const d = base();
    const r = run(d, { type: "addMilestone", afterId: "T" });
    for (const id of ["A", "p1", "T"]) expect(span(r.doc, id)).toEqual(span(d, id));
  });
  it("トップレベルでは、カテゴリの後・カテゴリなしタスクと同じ側に並ぶ (カテゴリが先)", () => {
    const d = doc([task({ id: "T", start: "2023-05-22" }), ms("M", "2023-05-23")]);
    const r = run(d, { type: "addCategory", afterId: null });
    expect(ids(r.doc)).toEqual(["N1", "T", "M"]);
    const m = doc([ms("M", "2023-05-23"), cat("C")]);
    const copy = structuredClone(m);
    normalizeTopLevel(copy);
    expect(ids(copy)).toEqual(["C", "M"]);
  });
});

describe("milestone: コマンド", () => {
  it("moveTask: 暦日でそのまま動かす (稼働日補正なし)。他のタスクは動かない", () => {
    const d = base();
    const r = run(d, { type: "moveTask", id: "M", deltaDays: 1 });
    expect(span(r.doc, "M")).toEqual(["2023-05-28", "2023-05-28"]); // 日曜
    expect(span(run(d, { type: "moveTask", id: "M", deltaDays: -7 }).doc, "M")).toEqual(["2023-05-20", "2023-05-20"]);
    for (const id of ["A", "p1", "T"]) expect(span(r.doc, id)).toEqual(span(d, id));
    expect(run(d, { type: "moveTask", id: "M", deltaDays: 0 }).patches).toEqual([]);
    expect(fail(d, { type: "moveTask", id: "M", deltaDays: 1.5 })).toBe("INVALID_VALUE");
  });
  it("setDates: start = end のときだけ (右ペインの日付入力)。違えば INVALID_VALUE。同じ日付は変更なし", () => {
    const d = base();
    const r = run(d, { type: "setDates", id: "M", start: "2023-07-01", end: "2023-07-01" });
    expect(span(r.doc, "M")).toEqual(["2023-07-01", "2023-07-01"]);
    expect(fail(d, { type: "setDates", id: "M", start: "2023-07-01", end: "2023-07-02" })).toBe("INVALID_VALUE");
    expect(fail(d, { type: "setDates", id: "M", start: "bad", end: "bad" })).toBe("INVALID_VALUE");
    expect(run(d, { type: "setDates", id: "M", start: "2023-05-27", end: "2023-05-27" }).patches).toEqual([]);
  });
  it.each<[string, Command]>([
    ["resizeTaskEnd", { type: "resizeTaskEnd", id: "M", newEnd: "2023-06-30" }],
    ["resizeTaskStart", { type: "resizeTaskStart", id: "M", newStart: "2023-05-01" }],
    ["setDuration", { type: "setDuration", id: "M", days: 3 }],
    ["setHours", { type: "setHours", id: "M", hours: 3 }],
    ["setResources", { type: "setResources", id: "M", resourceIds: [] }],
    ["setAssignees", { type: "setAssignees", id: "M", userIds: ["u1"] }],
    ["setStatus", { type: "setStatus", id: "M", status: "done" }],
    ["addDependency (succ)", { type: "addDependency", succId: "M", predId: "A" }],
    ["addDependency (pred)", { type: "addDependency", succId: "A", predId: "M" }],
    ["removeDependency", { type: "removeDependency", succId: "M", predId: "A" }],
  ])("%s は拒否", (_n, cmd) => {
    expect(fail(base(), cmd)).toBe("MILESTONE_NOT_EDITABLE");
  });
  it("canAddDependency はマイルストーンを拒否する", () => {
    expect(canAddDependency(base(), "T", "M")).toEqual({ ok: false, code: "MILESTONE_NOT_EDITABLE" });
  });
  it("indent: マイルストーンをタスクの子にはできず、タスクをマイルストーンの子にもできない。カテゴリの子にはできる", () => {
    const d = doc([cat("C"), ms("M", "2023-05-22"), task({ id: "A", start: "2023-05-22" })]);
    expect(run(d, { type: "indent", id: "M" }).doc.tasks.find((t) => t.id === "M")!.parentId).toBe("C");
    const d2 = doc([cat("C"), task({ id: "A", parentId: "C", start: "2023-05-22" }), ms("M", "2023-05-23", "C")]);
    expect(fail(d2, { type: "indent", id: "M" })).toBe("MILESTONE_PARENT_INVALID");
    const d3 = doc([cat("C"), ms("M", "2023-05-23", "C"), task({ id: "A", parentId: "C", start: "2023-05-22" })]);
    expect(fail(d3, { type: "indent", id: "A" })).toBe("MILESTONE_PARENT_INVALID");
  });
  it("setName / setNotes / setColorLabel / setCategory / moveUp / moveDown / duplicateTask / deleteTask は使える", () => {
    let d = base();
    d = run(d, { type: "setName", id: "M", name: "リリース" }).doc;
    d = run(d, { type: "setNotes", id: "M", notes: "詳細" }).doc;
    expect(byId(d, "M")).toMatchObject({ name: "リリース", notes: "詳細" });
    d = { ...d, colorLabels: [{ id: "L", name: "x", color: "#ff0000" }] };
    expect(byId(run(d, { type: "setColorLabel", id: "M", colorLabelId: "L" }).doc, "M").colorLabelId).toBe("L");
    expect(byId(run(d, { type: "setCategory", id: "M", categoryId: "D" }).doc, "M").parentId).toBe("D");
    expect(byId(run(d, { type: "setCategory", id: "M2", categoryId: "C" }).doc, "M2").parentId).toBe("C");
    expect(byId(run(d, { type: "setCategory", id: "M", categoryId: null }).doc, "M").parentId).toBeNull();
    expect(ids(run(d, { type: "moveUp", id: "M" }).doc).slice(0, 3)).toEqual(["C", "M", "A"]);
    const dup = run(d, { type: "duplicateTask", id: "M" });
    expect(byId(dup.doc, "N1")).toMatchObject({ kind: "milestone", name: "リリース", start: "2023-05-27", end: "2023-05-27" });
    expect(ids(run(d, { type: "deleteTask", id: "M" }).doc)).not.toContain("M");
  });
  it("トップレベルの moveUp/moveDown は、タスクと同じ「カテゴリなし」側として扱う (カテゴリとの境界は越えない)", () => {
    const d = doc([cat("C"), task({ id: "T", start: "2023-05-22" }), ms("M", "2023-05-23")]);
    expect(fail(d, { type: "moveUp", id: "T" })).toBe("NO_PREVIOUS_SIBLING");
    expect(ids(run(d, { type: "moveUp", id: "M" }).doc)).toEqual(["C", "M", "T"]);
  });
});

describe("milestone: スケジューリング・集計の対象外", () => {
  it("他のタスクの移動で動かない。rescheduleAll でも不変、依存違反の対象にもならない", () => {
    const d = base();
    const moved = run(d, { type: "moveTask", id: "A", deltaDays: 14 });
    expect(span(moved.doc, "M")).toEqual(["2023-05-27", "2023-05-27"]);
    expect(span(moved.doc, "M2")).toEqual(["2023-06-01", "2023-06-01"]);
    const all = run(structuredClone(d), { type: "rescheduleAll" });
    expect(span(all.doc, "M")).toEqual(span(d, "M"));
    expect(findViolations(d, WC).map((v) => v.succId)).not.toContain("M");
  });
  it("親・カテゴリの導出には集約されない。導出は日付だけを持ち工数・期間は無い", () => {
    const di = deriveAll(base(), WC);
    expect(getDerived(di, "M")).toMatchObject({ isMilestone: true, isCategory: false, isParent: false, start: "2023-05-27", end: "2023-05-27", durationDays: 0 });
    expect(getDerived(di, "M")!.hours).toBeUndefined();
    expect(getDerived(di, "P")).toMatchObject({ start: "2023-05-24", end: "2023-05-25" });
    expect(getDerived(di, "C")).toMatchObject({ isCategory: true, start: "", end: "" });
  });
  it("葉の集合 (スケジューリングの対象) に含まれない", () => {
    const ix = buildTreeIndex(base());
    expect(getLeafDescendantsOrSelf(ix, "M")).toEqual([]);
    expect(getLeafDescendantsOrSelf(ix, "C")).toEqual(["A", "p1"]);
  });
  it("prepareForSave / load で値は保持され、並びは正規化される", () => {
    const saved = prepareForSave(base());
    expect(byId(saved, "M")).toMatchObject({ kind: "milestone", start: "2023-05-27", end: "2023-05-27" });
    expect(loadDocument(saved).ok).toBe(true);
  });
});
