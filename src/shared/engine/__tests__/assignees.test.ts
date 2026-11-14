import { describe, expect, it } from "vitest";
import type { GanttDocument } from "../../model/types";
import { executeCommand, MAX_ASSIGNEES, type Command, type CommandOk } from "../commands";
import { loadDocument, prepareForSave } from "../document";
import { findCategoryIssues } from "../hierarchy";
import { byId, cat, doc, makeCtx, task } from "./fixtures";

function run(d: GanttDocument, cmd: Command): CommandOk {
  const r = executeCommand(d, cmd, makeCtx());
  if (!r.ok) throw new Error(`unexpected error ${r.code}`);
  return r;
}
function fail(d: GanttDocument, cmd: Command): string {
  const r = executeCommand(d, cmd, makeCtx());
  if (r.ok) throw new Error("expected failure");
  return r.code;
}

const base = (): GanttDocument =>
  doc([cat("C"), task({ id: "A", parentId: "C", start: "2023-05-22" }), task({ id: "P" }), task({ id: "p1", parentId: "P", start: "2023-05-23" })]);

describe("setAssignees", () => {
  it("sets the list (case-sensitive ids, order kept, duplicates dropped)", () => {
    const r = run(base(), { type: "setAssignees", id: "A", userIds: ["Ab_1", "ab_1", "Ab_1", "x-2"] });
    expect(byId(r.doc, "A").assigneeIds).toEqual(["Ab_1", "ab_1", "x-2"]);
  });

  it("an empty list removes the field", () => {
    const d = run(base(), { type: "setAssignees", id: "A", userIds: ["u1"] }).doc;
    const r = run(d, { type: "setAssignees", id: "A", userIds: [] });
    expect("assigneeIds" in byId(r.doc, "A")).toBe(false);
  });

  it("no change produces no patches", () => {
    const d = run(base(), { type: "setAssignees", id: "A", userIds: ["u1", "u2"] }).doc;
    const r = run(d, { type: "setAssignees", id: "A", userIds: ["u1", "u2"] });
    expect(r.patches).toEqual([]);
  });

  it("parents can have assignees; children are not touched", () => {
    const r = run(base(), { type: "setAssignees", id: "P", userIds: ["u1"] });
    expect(byId(r.doc, "P").assigneeIds).toEqual(["u1"]);
    expect(byId(r.doc, "p1").assigneeIds).toBeUndefined();
  });

  it("allows exactly MAX_ASSIGNEES and rejects one more", () => {
    const ids = Array.from({ length: MAX_ASSIGNEES + 1 }, (_, i) => `u${i}`);
    expect(run(base(), { type: "setAssignees", id: "A", userIds: ids.slice(0, MAX_ASSIGNEES) }).doc.tasks.length).toBe(4);
    expect(fail(base(), { type: "setAssignees", id: "A", userIds: ids })).toBe("INVALID_VALUE");
  });

  it.each<[string, unknown]>([
    ["not an array", "u1"],
    ["non-string item", [1]],
    ["empty string", [""]],
    ["too long", ["x".repeat(65)]],
  ])("rejects bad input: %s", (_n, v) => {
    expect(fail(base(), { type: "setAssignees", id: "A", userIds: v as string[] })).toBe("INVALID_VALUE");
  });

  it("unknown task / category are rejected", () => {
    expect(fail(base(), { type: "setAssignees", id: "nope", userIds: [] })).toBe("TASK_NOT_FOUND");
    expect(fail(base(), { type: "setAssignees", id: "C", userIds: ["u1"] })).toBe("CATEGORY_NOT_EDITABLE");
  });

  it("duplicateTask carries assignees over", () => {
    const d = run(base(), { type: "setAssignees", id: "A", userIds: ["u1", "u2"] }).doc;
    const r = run(d, { type: "duplicateTask", id: "A" });
    expect(byId(r.doc, "N1").assigneeIds).toEqual(["u1", "u2"]);
    const d2 = run(base(), { type: "setAssignees", id: "p1", userIds: ["u9"] }).doc;
    const r2 = run(d2, { type: "duplicateTask", id: "P" });
    expect(r2.doc.tasks.filter((t) => t.assigneeIds?.[0] === "u9")).toHaveLength(2);
  });

  it("new tasks do not inherit assignees; other commands keep them", () => {
    let d = run(base(), { type: "setAssignees", id: "P", userIds: ["u1"] }).doc;
    d = run(d, { type: "setAssignees", id: "A", userIds: ["u2"] }).doc;
    d = run(d, { type: "addTask", afterId: "P" }).doc;
    expect(byId(d, "N1").assigneeIds).toBeUndefined();
    d = run(d, { type: "moveTask", id: "A", deltaDays: 3 }).doc;
    d = run(d, { type: "indent", id: "N1" }).doc;
    expect(byId(d, "A").assigneeIds).toEqual(["u2"]);
    expect(byId(d, "P").assigneeIds).toEqual(["u1"]);
  });
});

describe("assigneeIds in documents", () => {
  it("categories must not have assignees (load error), empty list is fine", () => {
    const bad = base();
    byId(bad, "C").assigneeIds = ["u1"];
    expect(findCategoryIssues(bad)).toEqual([{ code: "CATEGORY_FIELD", index: 0, field: "assigneeIds" }]);
    const r = loadDocument(bad);
    expect(r.ok).toBe(false);
    byId(bad, "C").assigneeIds = [];
    expect(loadDocument(bad).ok).toBe(true);
  });

  it("unknown user ids are kept as-is by load / save (no check in the engine)", () => {
    const d = base();
    byId(d, "A").assigneeIds = ["someone-who-left"];
    const r = loadDocument(structuredClone(d));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(byId(prepareForSave(r.doc), "A").assigneeIds).toEqual(["someone-who-left"]);
  });

  it("replaceDocument accepts unknown ids", () => {
    const d = base();
    byId(d, "A").assigneeIds = ["ghost"];
    const r = run(doc([]), { type: "replaceDocument", doc: d });
    expect(byId(r.doc, "A").assigneeIds).toEqual(["ghost"]);
  });
});
