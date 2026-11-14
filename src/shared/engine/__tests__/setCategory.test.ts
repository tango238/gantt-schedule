import { describe, expect, it } from "vitest";
import type { GanttDocument } from "../../model/types";
import { compileCalendar } from "../calendar";
import { executeCommand, type Command, type CommandOk } from "../commands";
import { loadDocument, prepareForSave } from "../document";
import { buildTreeIndex, displayOrder, movableNext, movablePrevious, normalizeTopLevel, visibleRows } from "../hierarchy";
import { findViolations } from "../scheduling";
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

/** C1 > [A, P > p1], C2 > [B] ; sub-category C2s under C2 ; top-level tasks T1, T2 (T2 depends on A) */
const base = (): GanttDocument =>
  doc([
    cat("C1"),
    task({ id: "A", parentId: "C1", start: "2023-05-22", end: "2023-05-23" }),
    task({ id: "P", parentId: "C1" }),
    task({ id: "p1", parentId: "P", start: "2023-05-24", end: "2023-05-25" }),
    cat("C2"),
    task({ id: "B", parentId: "C2", start: "2023-05-22" }),
    cat("C2s", "C2"),
    task({ id: "T1", start: "2023-05-26" }),
    task({ id: "T2", start: "2023-05-29", deps: ["A"] }),
  ]);

describe("setCategory", () => {
  it("moves a top-level task to the end of a category", () => {
    const r = run(base(), { type: "setCategory", id: "T1", categoryId: "C1" });
    expect(byId(r.doc, "T1").parentId).toBe("C1");
    expect(ids(r.doc)).toEqual(["C1", "A", "P", "p1", "T1", "C2", "B", "C2s", "T2"]);
    expect(r.reveal).toEqual(["T1"]);
  });

  it("moves a task between categories, with its whole subtree, to the end of the target's children", () => {
    const r = run(base(), { type: "setCategory", id: "P", categoryId: "C2" });
    expect(byId(r.doc, "P").parentId).toBe("C2");
    expect(ids(r.doc)).toEqual(["C1", "A", "C2", "B", "C2s", "P", "p1", "T1", "T2"]);
    expect(byId(r.doc, "p1").parentId).toBe("P");
  });

  it("null moves it to the end of the top level (and 'no category' tasks stay after the categories)", () => {
    const r = run(base(), { type: "setCategory", id: "A", categoryId: null });
    expect(byId(r.doc, "A").parentId).toBeNull();
    expect(ids(r.doc)).toEqual(["C1", "P", "p1", "C2", "B", "C2s", "T1", "T2", "A"]);
  });

  it("works with a nested category as the target", () => {
    const r = run(base(), { type: "setCategory", id: "T1", categoryId: "C2s" });
    expect(byId(r.doc, "T1").parentId).toBe("C2s");
    expect(ids(r.doc)).toEqual(["C1", "A", "P", "p1", "C2", "B", "C2s", "T1", "T2"]);
  });

  it("same category (or already top-level for null) is a no-op", () => {
    expect(run(base(), { type: "setCategory", id: "A", categoryId: "C1" }).patches).toEqual([]);
    expect(run(base(), { type: "setCategory", id: "T1", categoryId: null }).patches).toEqual([]);
  });

  it("is case-insensitive for ids", () => {
    const d = doc([cat("Cx"), task({ id: "Tz", start: "2023-05-22" })]);
    const r = run(d, { type: "setCategory", id: "tz", categoryId: "cX" });
    expect(byId(r.doc, "Tz").parentId).toBe("Cx");
  });

  it("does not change dates or dependencies; rescheduling gives the same result", () => {
    const d = base();
    const r = run(d, { type: "setCategory", id: "A", categoryId: "C2" });
    for (const id of ["A", "p1", "T1", "T2", "B"]) expect(span(r.doc, id)).toEqual(span(d, id));
    expect(byId(r.doc, "T2").dependencies).toEqual(byId(d, "T2").dependencies);
    expect(findViolations(r.doc, WC)).toEqual([]);
    const again = run(r.doc, { type: "rescheduleAll" });
    expect(again.patches).toEqual([]);
  });

  it.each<[string, Command, string]>([
    ["a category", { type: "setCategory", id: "C1", categoryId: "C2" }, "CATEGORY_NOT_EDITABLE"],
    ["a subtask (parent is a task)", { type: "setCategory", id: "p1", categoryId: "C2" }, "SUBTASK_CATEGORY"],
    ["a subtask to null", { type: "setCategory", id: "p1", categoryId: null }, "SUBTASK_CATEGORY"],
    ["target that is a task", { type: "setCategory", id: "T1", categoryId: "A" }, "INVALID_VALUE"],
    ["unknown target", { type: "setCategory", id: "T1", categoryId: "zz" }, "TASK_NOT_FOUND"],
    ["unknown task", { type: "setCategory", id: "zz", categoryId: "C1" }, "TASK_NOT_FOUND"],
    ["bad categoryId type", { type: "setCategory", id: "T1", categoryId: 5 as unknown as string }, "INVALID_VALUE"],
  ])("rejects %s", (_n, cmd, code) => {
    expect(fail(base(), cmd)).toBe(code);
  });
});

describe("top-level normalization (categories first, then tasks without a category)", () => {
  const messy = (): GanttDocument =>
    doc([
      task({ id: "T1", start: "2023-05-22" }),
      cat("C1"),
      task({ id: "A", parentId: "C1", start: "2023-05-22" }),
      task({ id: "T2", start: "2023-05-23" }),
      task({ id: "T2c", parentId: "T2", start: "2023-05-24" }),
      cat("C2"),
      cat("C2s", "C2"),
    ]);

  it("normalizeTopLevel is stable: categories first, relative order kept, subtrees follow their parent", () => {
    const d = messy();
    normalizeTopLevel(d);
    expect(ids(d)).toEqual(["C1", "A", "C2", "C2s", "T1", "T2", "T2c"]);
  });

  it("is idempotent and does nothing to a normalized doc", () => {
    const d = messy();
    normalizeTopLevel(d);
    const once = structuredClone(d);
    normalizeTopLevel(d);
    expect(d).toEqual(once);
  });

  it("the tree index orders roots the same way without touching the array (defensive derivation)", () => {
    const d = messy();
    const ix = buildTreeIndex(d);
    expect(displayOrder(ix)).toEqual(["C1", "A", "C2", "C2s", "T1", "T2", "T2c"]);
    expect(visibleRows(ix, new Set())).toEqual(["C1", "A", "C2", "C2s", "T1", "T2", "T2c"]);
    expect(ids(d)[0]).toBe("T1");
  });

  it("every command normalizes an unnormalized doc, even a rename", () => {
    const r = run(messy(), { type: "setName", id: "T1", name: "x" });
    expect(ids(r.doc)).toEqual(["C1", "A", "C2", "C2s", "T1", "T2", "T2c"]);
    expect(run(r.doc, { type: "setName", id: "T1", name: "y" }).doc.tasks.map((t) => t.id)).toEqual(ids(r.doc));
  });

  it("loadDocument and prepareForSave return the normalized order", () => {
    const res = loadDocument(messy());
    expect(res.ok && ids(res.doc)).toEqual(["C1", "A", "C2", "C2s", "T1", "T2", "T2c"]);
    expect(ids(prepareForSave(messy()))).toEqual(["C1", "A", "C2", "C2s", "T1", "T2", "T2c"]);
  });

  it("replaceDocument normalizes the result as well", () => {
    const r = run(doc([]), { type: "replaceDocument", doc: messy() });
    expect(ids(r.doc)).toEqual(["C1", "A", "C2", "C2s", "T1", "T2", "T2c"]);
  });

  it("addTask / addCategory / duplicate / outdent keep the order", () => {
    const cx = makeCtx("2023-05-22");
    let d = base();
    d = run(d, { type: "addCategory", afterId: null }, cx).doc;
    expect(ids(d)).toEqual(["C1", "A", "P", "p1", "C2", "B", "C2s", "N1", "T1", "T2"]);
    d = run(d, { type: "addTask", afterId: null }, cx).doc;
    expect(ids(d).slice(-3)).toEqual(["T1", "T2", "N2"]);
    expect(d.tasks.at(-1)!.parentId).toBeNull();
    expect(d.tasks.at(-1)!.kind).toBeUndefined();
    d = run(d, { type: "duplicateTask", id: "A" }, cx).doc;
    const topKinds = d.tasks.filter((t) => t.parentId === null).map((t) => t.kind === "category");
    expect(topKinds).toEqual([...topKinds].sort((a, b) => Number(b) - Number(a)));
    // outdent a task out of a category: it lands among the top-level tasks, not between categories
    const o = run(base(), { type: "outdent", id: "B" }).doc;
    const top = o.tasks.filter((t) => t.parentId === null).map((t) => t.id);
    expect(top).toEqual(["C1", "C2", "B", "T1", "T2"]);
  });

  it("deriving rows from a doc that is already normalized gives the same as normalizing it", () => {
    const a = base();
    const rowsBefore = visibleRows(buildTreeIndex(a), new Set());
    normalizeTopLevel(a);
    expect(visibleRows(buildTreeIndex(a), new Set())).toEqual(rowsBefore);
  });
});

describe("moveUp / moveDown at the top level", () => {
  it("cannot cross the boundary between categories and no-category tasks", () => {
    const d = base();
    expect(fail(d, { type: "moveUp", id: "T1" })).toBe("NO_PREVIOUS_SIBLING");
    expect(fail(d, { type: "moveDown", id: "C2" })).toBe("NO_NEXT_SIBLING");
    const ix = buildTreeIndex(d);
    expect(movablePrevious(ix, "T1")).toBeNull();
    expect(movableNext(ix, "C2")).toBeNull();
    expect(movablePrevious(ix, "C2")).toBe("C1");
    expect(movableNext(ix, "T1")).toBe("T2");
  });
  it("moves within each group and inside categories freely", () => {
    expect(ids(run(base(), { type: "moveDown", id: "T1" }).doc).slice(-2)).toEqual(["T2", "T1"]);
    expect(ids(run(base(), { type: "moveUp", id: "C2" }).doc).slice(0, 2)).toEqual(["C2", "B"]);
    // inside a category: a task and a sub-category can swap
    const r = run(base(), { type: "moveDown", id: "B" });
    expect(ids(r.doc)).toEqual(["C1", "A", "P", "p1", "C2", "C2s", "B", "T1", "T2"]);
    // a task directly under a category can move past its sibling category freely
    expect(ids(run(base(), { type: "moveUp", id: "P" }).doc).slice(0, 4)).toEqual(["C1", "P", "p1", "A"]);
  });
});
