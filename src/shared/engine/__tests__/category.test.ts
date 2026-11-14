import { describe, expect, it } from "vitest";
import type { GanttDocument } from "../../model/types";
import { compileCalendar } from "../calendar";
import { executeCommand, type Command, type CommandOk } from "../commands";
import { loadDocument, prepareForSave } from "../document";
import { buildTreeIndex, deriveAll, findCategoryIssues, getDerived, getLeafDescendantsOrSelf } from "../hierarchy";
import { canAddDependency, findViolations } from "../scheduling";
import { byId, cat, doc, makeCtx, span, task } from "./fixtures";

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

/** C (category) > [A (task), P (task) > p1], D (category, empty), T (top-level task) */
const base = (): GanttDocument =>
  doc([
    cat("C"),
    task({ id: "A", parentId: "C", start: "2023-05-22", end: "2023-05-23", progress: 50 }),
    task({ id: "P", parentId: "C" }),
    task({ id: "p1", parentId: "P", start: "2023-05-24", end: "2023-05-25", progress: 100 }),
    cat("D"),
    task({ id: "T", start: "2023-05-29", end: "2023-05-30", deps: ["A"] }),
  ]);

describe("category: addCategory", () => {
  it("appends at the top level with the default name and no dates", () => {
    const r = run(base(), { type: "addCategory", afterId: null });
    const c = byId(r.doc, "N1");
    expect(c).toEqual({ id: "N1", kind: "category", parentId: null, name: "新しいカテゴリ", resourceIds: [], dependencies: [] });
    // トップレベルはカテゴリが先: 最後のカテゴリの直後 (カテゴリなしタスク T の前) に入る。
    expect(ids(r.doc)).toEqual(["C", "A", "P", "p1", "D", "N1", "T"]);
    expect(r).toMatchObject({ selection: "N1", editName: true, reveal: ["N1"], createdId: "N1" });
  });

  it("after a category: sibling placed behind its whole subtree", () => {
    const r = run(base(), { type: "addCategory", afterId: "C" });
    expect(ids(r.doc)).toEqual(["C", "A", "P", "p1", "N1", "D", "T"]);
    expect(byId(r.doc, "N1").parentId).toBeNull();
  });

  it("after a task directly under a category: becomes a child of that category, after the task subtree", () => {
    const r = run(base(), { type: "addCategory", afterId: "P" });
    expect(ids(r.doc)).toEqual(["C", "A", "P", "p1", "N1", "D", "T"]);
    expect(byId(r.doc, "N1").parentId).toBe("C");
  });

  it("after a task nested in a task hierarchy: climbs to the nearest category level", () => {
    const r = run(base(), { type: "addCategory", afterId: "p1" });
    expect(ids(r.doc)).toEqual(["C", "A", "P", "p1", "N1", "D", "T"]);
    expect(byId(r.doc, "N1").parentId).toBe("C");
  });

  it("after a top-level task with children climbs to the top level", () => {
    const d = doc([task({ id: "X" }), task({ id: "x1", parentId: "X", start: "2023-05-22" }), task({ id: "Y", start: "2023-05-23" })]);
    const r = run(d, { type: "addCategory", afterId: "x1" });
    expect(ids(r.doc)).toEqual(["N1", "X", "x1", "Y"]); // 新しいカテゴリはカテゴリなしタスクより前
    expect(byId(r.doc, "N1").parentId).toBeNull();
  });

  it("unknown afterId is rejected", () => {
    expect(fail(base(), { type: "addCategory", afterId: "nope" })).toBe("TASK_NOT_FOUND");
  });

  it("does not change any task's dates", () => {
    const d = base();
    const r = run(d, { type: "addCategory", afterId: "A" });
    for (const id of ["A", "p1", "T"]) expect(span(r.doc, id)).toEqual(span(d, id));
  });
});

describe("category: invariants through the engine", () => {
  it("derived values: category has no dates and does not aggregate its children", () => {
    const di = deriveAll(base(), WC);
    const c = getDerived(di, "C")!;
    expect(c).toMatchObject({ isCategory: true, isParent: true, start: "", end: "", durationDays: 0, isMilestone: false });
    expect(c.hours).toBeUndefined();
    const d = getDerived(di, "D")!;
    expect(d).toMatchObject({ isCategory: true, isParent: false });
    // task parents under a category still aggregate
    expect(getDerived(di, "P")).toMatchObject({ isParent: true, isCategory: false, start: "2023-05-24", end: "2023-05-25" });
  });

  it("leaf descendants of a category skip categories and parents", () => {
    const ix = buildTreeIndex(base());
    expect(getLeafDescendantsOrSelf(ix, "C")).toEqual(["A", "p1"]);
    expect(getLeafDescendantsOrSelf(ix, "D")).toEqual([]);
  });

  it("a childless category stays a category (no dates appear)", () => {
    const cx = makeCtx();
    let d = run(base(), { type: "addCategory", afterId: null }, cx).doc;
    d = run(d, { type: "addTask", afterId: "N1" }, cx).doc;
    expect(byId(d, "N2").parentId).toBe("N1");
    d = run(d, { type: "deleteTask", id: "N2" }).doc;
    const c = byId(d, "N1");
    expect(c.kind).toBe("category");
    expect(c.start).toBeUndefined();
    expect(c.end).toBeUndefined();
    expect(c.progress).toBeUndefined();
  });

  it("outdenting the last child of a category does not give the category dates", () => {
    let d = doc([cat("C"), task({ id: "A", parentId: "C", start: "2023-05-22", end: "2023-05-23" })]);
    d = run(d, { type: "outdent", id: "A" }).doc;
    expect(byId(d, "A").parentId).toBeNull();
    expect(byId(d, "C").start).toBeUndefined();
    expect(byId(d, "C").progress).toBeUndefined();
    expect(findCategoryIssues(d)).toEqual([]);
  });

  it("indenting a task under a category does not strip or add anything to the category", () => {
    const d = doc([cat("C"), task({ id: "A", start: "2023-05-22", end: "2023-05-23" })]);
    const r = run(d, { type: "indent", id: "A" });
    expect(byId(r.doc, "A").parentId).toBe("C");
    expect(byId(r.doc, "C")).toEqual(byId(d, "C"));
  });

  it("scheduling passes through categories: dependency pushes tasks inside categories", () => {
    // T depends on A (inside C). Moving A pushes T.
    const r = run(base(), { type: "moveTask", id: "A", deltaDays: 7 });
    expect(span(r.doc, "A")).toEqual(["2023-05-29", "2023-05-30"]);
    expect(span(r.doc, "T")).toEqual(["2023-05-31", "2023-06-01"]);
    expect(findViolations(r.doc, WC)).toEqual([]);
    for (const id of ["C", "D"]) {
      expect(byId(r.doc, id).start).toBeUndefined();
      expect(byId(r.doc, id).end).toBeUndefined();
    }
  });

  it("rescheduleAll leaves categories untouched", () => {
    const d = base();
    d.tasks[5]!.start = "2023-05-22";
    d.tasks[5]!.end = "2023-05-22";
    const r = run(d, { type: "rescheduleAll" });
    expect(span(r.doc, "T")).toEqual(["2023-05-24", "2023-05-24"]);
    expect(byId(r.doc, "C")).toEqual(byId(d, "C"));
    expect(byId(r.doc, "D")).toEqual(byId(d, "D"));
  });

  it("a task parent inside a category still aggregates from its children", () => {
    const r = run(base(), { type: "moveTask", id: "p1", deltaDays: 1 });
    expect(getDerived(deriveAll(r.doc, WC), "P")).toMatchObject({ start: "2023-05-25", end: "2023-05-26" });
  });

  it("addTask with a category as afterId appends to the end of that category's children (dated from today); after a task inside a category stays inside", () => {
    const r1 = run(base(), { type: "addTask", afterId: "C" });
    expect(byId(r1.doc, "N1")).toMatchObject({ parentId: "C", start: "2023-05-22", end: "2023-05-22", resourceIds: [] });
    expect(ids(r1.doc)).toEqual(["C", "A", "P", "p1", "N1", "D", "T"]);
    const r3 = run(base(), { type: "addTask", afterId: "D" });
    expect(byId(r3.doc, "N1").parentId).toBe("D");
    expect(ids(r3.doc)).toEqual(["C", "A", "P", "p1", "D", "N1", "T"]);
    const r2 = run(base(), { type: "addTask", afterId: "A" });
    expect(byId(r2.doc, "N1").parentId).toBe("C");
  });
});

describe("category: commands on categories", () => {
  it.each<[string, Command]>([
    ["moveTask", { type: "moveTask", id: "C", deltaDays: 1 }],
    ["resizeTaskEnd", { type: "resizeTaskEnd", id: "C", newEnd: "2023-05-30" }],
    ["resizeTaskStart", { type: "resizeTaskStart", id: "C", newStart: "2023-05-30" }],
    ["setDates", { type: "setDates", id: "C", start: "2023-05-22", end: "2023-05-23" }],
    ["setDuration", { type: "setDuration", id: "D", days: 3 }],
    ["setStatus", { type: "setStatus", id: "C", status: "done" }],
    ["setHours", { type: "setHours", id: "D", hours: 3 }],
    ["setResources", { type: "setResources", id: "C", resourceIds: [] }],
    ["setAssignees", { type: "setAssignees", id: "C", userIds: ["u1"] }],
    ["addDependency (succ)", { type: "addDependency", succId: "C", predId: "T" }],
    ["addDependency (pred)", { type: "addDependency", succId: "T", predId: "C" }],
    ["removeDependency", { type: "removeDependency", succId: "C", predId: "T" }],
  ])("%s is rejected", (_n, cmd) => {
    expect(fail(base(), cmd)).toBe("CATEGORY_NOT_EDITABLE");
  });

  it("canAddDependency refuses categories", () => {
    expect(canAddDependency(base(), "T", "C")).toEqual({ ok: false, code: "CATEGORY_NOT_EDITABLE" });
  });

  it("setName / setNotes / setColorLabel work", () => {
    let d = base();
    d.colorLabels = [{ id: "L", name: "L", color: "#112233" }];
    d = run(d, { type: "setName", id: "C", name: "設計" }).doc;
    d = run(d, { type: "setNotes", id: "C", notes: "メモ" }).doc;
    d = run(d, { type: "setColorLabel", id: "C", colorLabelId: "L" }).doc;
    expect(byId(d, "C")).toMatchObject({ name: "設計", notes: "メモ", colorLabelId: "L", kind: "category" });
    d = run(d, { type: "setNotes", id: "C", notes: "" }).doc;
    expect(byId(d, "C").notes).toBeUndefined();
  });

  it("deleteTask removes the descendants and dependencies pointing at them", () => {
    const r = run(base(), { type: "deleteTask", id: "C" });
    expect(ids(r.doc)).toEqual(["D", "T"]);
    expect(byId(r.doc, "T").dependencies).toEqual([]);
  });

  it("moveUp / moveDown swap whole blocks among siblings", () => {
    const r = run(base(), { type: "moveDown", id: "C" });
    expect(ids(r.doc)).toEqual(["D", "C", "A", "P", "p1", "T"]);
    const r2 = run(base(), { type: "moveUp", id: "D" });
    expect(ids(r2.doc)).toEqual(["D", "C", "A", "P", "p1", "T"]);
  });

  it("indent: a category can go under a previous category, not under a task", () => {
    const r = run(base(), { type: "indent", id: "D" });
    expect(byId(r.doc, "D").parentId).toBe("C");
    const d = doc([cat("C"), task({ id: "X", parentId: "C", start: "2023-05-22" }), cat("Y", "C")]);
    expect(fail(d, { type: "indent", id: "Y" })).toBe("CATEGORY_PARENT_INVALID");
  });

  it("outdent a nested category", () => {
    const d = doc([cat("C"), cat("S", "C"), task({ id: "A", parentId: "S", start: "2023-05-22" })]);
    const r = run(d, { type: "outdent", id: "S" });
    expect(byId(r.doc, "S").parentId).toBeNull();
    expect(ids(r.doc)).toEqual(["C", "S", "A"]);
    expect(findCategoryIssues(r.doc)).toEqual([]);
  });

  it("duplicateTask copies a category subtree with new ids and keeps kinds", () => {
    const r = run(base(), { type: "duplicateTask", id: "C" });
    expect(ids(r.doc)).toEqual(["C", "A", "P", "p1", "N1", "N2", "N3", "N4", "D", "T"]);
    expect(byId(r.doc, "N1").kind).toBe("category");
    expect(byId(r.doc, "N2").parentId).toBe("N1");
    expect(byId(r.doc, "N4").parentId).toBe("N3");
    expect(span(r.doc, "N2")).toEqual(["2023-05-22", "2023-05-23"]);
    expect(findCategoryIssues(r.doc)).toEqual([]);
  });

  it("indent that would put a category under a task is rejected (a new category after a task is indented under that task)", () => {
    const d = run(base(), { type: "addCategory", afterId: "p1" }).doc;
    expect(fail(d, { type: "indent", id: "N1" })).toBe("CATEGORY_PARENT_INVALID");
    expect(findCategoryIssues(d)).toEqual([]);
  });
});

describe("category: document validation", () => {
  const raw = (over: (d: GanttDocument) => void): GanttDocument => {
    const d = structuredClone(base());
    over(d);
    return d;
  };
  const errs = (d: GanttDocument): Array<[string, string]> => {
    const r = loadDocument(d);
    if (r.ok) throw new Error("expected errors");
    return r.errors.map((e) => [e.code, e.path]);
  };

  it("a valid document with categories loads without warnings, order preserved", () => {
    const r = loadDocument(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(ids(r.doc)).toEqual(["C", "A", "P", "p1", "D", "T"]);
    expect(byId(r.doc, "C").start).toBeUndefined();
    expect(byId(r.doc, "D").kind).toBe("category");
  });

  it("a category with dates, status, hours, dependencies or resources is an error", () => {
    expect(errs(raw((d) => { d.tasks[0]!.start = "2023-05-22"; }))).toContainEqual(["CATEGORY_FIELD", "/tasks/0/start"]);
    expect(errs(raw((d) => { d.tasks[0]!.end = "2023-05-22"; }))).toContainEqual(["CATEGORY_FIELD", "/tasks/0/end"]);
    expect(errs(raw((d) => { d.tasks[0]!.status = "done"; }))).toContainEqual(["CATEGORY_FIELD", "/tasks/0/status"]);
    // 廃止された progress は持っていても無視する (エラーにしない)
    expect(loadDocument(raw((d) => { d.tasks[0]!.progress = 10; })).ok).toBe(true);
    expect(errs(raw((d) => { d.tasks[0]!.hours = 1; }))).toContainEqual(["CATEGORY_FIELD", "/tasks/0/hours"]);
    expect(errs(raw((d) => { d.tasks[4]!.dependencies = [{ predecessorId: "A" }]; }))).toContainEqual(["CATEGORY_FIELD", "/tasks/4/dependencies"]);
    expect(errs(raw((d) => { d.tasks[4]!.resourceIds = ["r"]; }))).toContainEqual(["CATEGORY_FIELD", "/tasks/4/resourceIds"]);
  });

  it("a category under a task is an error", () => {
    expect(errs(raw((d) => { d.tasks[4]!.parentId = "A"; }))).toContainEqual(["CATEGORY_PARENT", "/tasks/4/parentId"]);
  });

  it("a dependency whose predecessor is a category is an error", () => {
    expect(errs(raw((d) => { d.tasks[5]!.dependencies = [{ predecessorId: "C" }]; }))).toContainEqual([
      "CATEGORY_DEPENDENCY",
      "/tasks/5/dependencies/0/predecessorId",
    ]);
  });

  it("a childless category without dates is not LEAF_NO_DATES", () => {
    const d = doc([cat("C")]);
    expect(loadDocument(d).ok).toBe(true);
  });

  it("prepareForSave keeps categories in pre-order and drops nothing", () => {
    const shuffled = base();
    const [c] = shuffled.tasks.splice(0, 1);
    shuffled.tasks.splice(1, 0, c!); // A, C, P, p1, D, T
    const out = prepareForSave(shuffled);
    expect(ids(out)).toEqual(["C", "A", "P", "p1", "D", "T"]);
    expect(byId(out, "C").kind).toBe("category");
  });
});
