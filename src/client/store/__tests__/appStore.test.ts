// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import sample from "../../../../schema/examples/sample.json";
import { loadDocument as normalize } from "../../../shared/engine";
import { doc as mkDoc, seq, task } from "../../../shared/engine/__tests__/fixtures";
import type { GanttDocument } from "../../../shared/model/types";
import { setCommandContextOverride, useAppStore } from "../appStore";
import {
  selectDerived,
  selectSelectedTask,
  selectViolations,
  selectVisibleRowIds,
  visibleAncestorOf,
} from "../selectors";
import { loadView, saveView } from "../viewStorage";

const st = () => useAppStore.getState();

/** サーバー保存形 (view なし)。 */
function serverDoc(d: GanttDocument): GanttDocument {
  const { view: _v, ...rest } = d;
  return rest as GanttDocument;
}
function show(doc: GanttDocument, id = "S1"): void {
  st().applySnapshot({ id, rev: 0, doc });
}
function loadSample(): GanttDocument {
  const r = normalize(structuredClone(sample) as unknown as GanttDocument);
  if (!r.ok) throw new Error("sample invalid");
  show(serverDoc(r.doc));
  return st().doc!;
}
const DEFINE_GOALS = "4652e672-a21d-4222-b9a9-56b4138ea105";

beforeEach(() => {
  localStorage.clear();
  setCommandContextOverride({ today: "2023-05-22", newId: seq("N"), defaultTaskName: "新しいタスク", defaultCategoryName: "新しいカテゴリ" });
  useAppStore.setState({ doc: null, preview: null, scheduleId: null });
});

describe("store commands (local application)", () => {
  it("applies a command to the displayed doc", () => {
    loadSample();
    expect(st().dispatch({ type: "moveTask", id: DEFINE_GOALS, deltaDays: 1 }).ok).toBe(true);
  });

  it("no-op command keeps the doc reference", () => {
    show(mkDoc([task({ id: "A", start: "2023-05-22", end: "2023-05-23" }), task({ id: "B", start: "2023-05-24", deps: ["A"] })]));
    const before = st().doc;
    const r = st().dispatch({ type: "moveTask", id: "B", deltaDays: -2 });
    expect(r.ok).toBe(true);
    expect(st().doc).toEqual(before);
  });

  it("preview does not touch doc", () => {
    const loaded = loadSample();
    const alt = { ...loaded, project: { ...loaded.project, name: "preview" } };
    st().setPreview(alt);
    expect(st().doc).toBe(loaded);
    expect(selectDerived(st())).not.toBeNull();
    st().clearPreview();
    expect(st().preview).toBeNull();
    expect(st().doc).toBe(loaded);
  });

  it("addTask selects the new task and starts name editing", () => {
    loadSample();
    const r = st().dispatch({ type: "addTask", afterId: DEFINE_GOALS });
    expect(r.ok).toBe(true);
    expect(st().selectedId).toBe("N1");
    expect(st().editing).toEqual({ taskId: "N1", field: "name" });
    expect(selectSelectedTask(st())?.id).toBe("N1");
  });

  it("indent into a collapsed parent expands it", () => {
    show(
      mkDoc([
        task({ id: "P" }),
        task({ id: "C", parentId: "P", start: "2023-05-22" }),
        task({ id: "X", start: "2023-05-22" }),
      ]),
    );
    st().toggleCollapsed("P");
    expect(st().doc!.view?.collapsedTaskIds).toContain("P");
    expect(selectVisibleRowIds(st())).toEqual(["P", "X"]);
    const r = st().dispatch({ type: "indent", id: "X" });
    expect(r.ok).toBe(true);
    expect(st().doc!.view?.collapsedTaskIds).not.toContain("P");
    expect(selectVisibleRowIds(st())).toEqual(["P", "C", "X"]);
    expect(loadView("S1").collapsedTaskIds).not.toContain("P"); // localStorage にも反映
  });

  it("failing command leaves state untouched", () => {
    loadSample();
    const before = st().doc;
    const r = st().dispatch({ type: "indent", id: "b8f04324-e69c-43b3-8436-d6c3b52b5083" });
    expect(r.ok).toBe(false);
    expect(st().doc).toBe(before);
  });

  it("dispatch clears the drag preview", () => {
    const loaded = loadSample();
    st().setPreview(loaded);
    expect(st().preview).not.toBeNull();
    st().dispatch({ type: "setName", id: DEFINE_GOALS, name: "x" });
    expect(st().preview).toBeNull();
  });

  it("selected task / dependency that vanish are dropped", () => {
    show(mkDoc([task({ id: "A", start: "2023-05-22" }), task({ id: "B", start: "2023-05-29" })]));
    st().dispatch({ type: "addDependency", succId: "B", predId: "A" });
    st().selectDependency({ succId: "B", predId: "A" });
    st().dispatch({ type: "removeDependency", succId: "B", predId: "A" });
    expect(st().selectedDependency).toBeNull();
    st().select("A");
    st().dispatch({ type: "deleteTask", id: "A" });
    expect(st().selectedId).not.toBe("A");
    expect(st().doc!.tasks.some((t) => t.id === "A")).toBe(false);
  });
});

describe("view (local only)", () => {
  it("applySnapshot starts from the saved view of that schedule id", () => {
    saveView("S1", { zoom: "month", collapsedTaskIds: [] });
    show(mkDoc([task({ id: "A", start: "2023-05-22" })]), "S1");
    expect(st().doc!.view?.zoom).toBe("month");
    show(mkDoc([task({ id: "A", start: "2023-05-22" })]), "S2");
    expect(st().doc!.view?.zoom).toBe("day");
  });

  it("setZoom / toggleCollapsed persist per schedule id", () => {
    show(mkDoc([task({ id: "P" }), task({ id: "C", parentId: "P", start: "2023-05-22" })]), "S9");
    st().setZoom("week");
    st().toggleCollapsed("P");
    expect(loadView("S9")).toEqual({ zoom: "week", collapsedTaskIds: ["P"] });
    expect(loadView("other")).toEqual({ zoom: "day", collapsedTaskIds: [] });
  });

  it("collapsed ids of tasks that no longer have children are discarded on load", () => {
    saveView("S1", { zoom: "day", collapsedTaskIds: ["gone", "A"] });
    show(mkDoc([task({ id: "A", start: "2023-05-22" })]), "S1");
    expect(st().doc!.view?.collapsedTaskIds).toEqual([]);
  });

  it("corrupt localStorage falls back to defaults", () => {
    localStorage.setItem("schedule:view:S1", "{not json");
    show(mkDoc([task({ id: "A", start: "2023-05-22" })]), "S1");
    expect(st().doc!.view).toEqual({ zoom: "day", collapsedTaskIds: [] });
  });

  it("collapseAll / expandAll without a change keep the doc reference", () => {
    loadSample();
    const d0 = st().doc;
    st().expandAll();
    expect(st().doc).toBe(d0);
    st().collapseAll();
    expect(st().doc).not.toBe(d0);
    const d1 = st().doc;
    st().collapseAll();
    expect(st().doc).toBe(d1);
  });
});

describe("selectors", () => {
  it("are reference stable and respect collapse", () => {
    loadSample();
    const rows1 = selectVisibleRowIds(st());
    expect(selectVisibleRowIds(st())).toBe(rows1);
    expect(selectDerived(st())).toBe(selectDerived(st()));
    expect(selectViolations(st())).toBe(selectViolations(st()));
    expect(rows1).toHaveLength(31);
    st().toggleCollapsed("1a95d41c-85fd-4bdf-af7a-0879532e40cc");
    expect(selectVisibleRowIds(st())).toHaveLength(26);
  });

  it("visibleAncestorOf returns the outermost collapsed ancestor", () => {
    show(
      mkDoc([
        task({ id: "P" }),
        task({ id: "Q", parentId: "P" }),
        task({ id: "L", parentId: "Q", start: "2023-05-22" }),
        task({ id: "Z", start: "2023-05-22" }),
      ]),
    );
    const d = () => st().doc!;
    expect(visibleAncestorOf(d(), "L")).toBe("L");
    st().toggleCollapsed("Q");
    expect(visibleAncestorOf(d(), "L")).toBe("Q");
    st().toggleCollapsed("P");
    expect(visibleAncestorOf(d(), "L")).toBe("P");
    expect(visibleAncestorOf(d(), "P")).toBe("P");
    expect(visibleAncestorOf(d(), "Z")).toBe("Z");
  });
});

describe("store extras", () => {
  it("loadCount increases on every load", () => {
    const n = st().loadCount;
    loadSample();
    expect(st().loadCount).toBe(n + 1);
    loadSample();
    expect(st().loadCount).toBe(n + 2);
  });
});
