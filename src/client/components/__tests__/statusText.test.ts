import { describe, expect, it } from "vitest";
import sample from "../../../../schema/examples/sample.json";
import { loadDocument, formatDuration } from "../../../shared/engine";
import type { GanttDocument } from "../../../shared/model/types";
import { calendarOf, derivedOf } from "../../store/selectors";
import { statusTexts } from "../statusText";

function load(): GanttDocument {
  const r = loadDocument(structuredClone(sample) as unknown as GanttDocument);
  if (!r.ok) throw new Error("sample failed to load");
  return r.doc;
}

const TODAY = "2023-05-22";

describe("statusTexts(sample)", () => {
  const doc = load();
  const derived = derivedOf(doc);
  const wc = calendarOf(doc);

  it("counts tasks, hours and duration", () => {
    const s = statusTexts(doc, derived, wc, null, TODAY);
    const leafHours = doc.tasks
      .filter((x) => !doc.tasks.some((c) => c.parentId === x.id))
      .reduce((a, x) => a + (x.hours ?? 0), 0);
    expect(s.tasks).toBe("タスク: 31");
    expect(s.hours).toBe(`工数: ${leafHours}h`);
    expect(s.hours).toBe("工数: 214h");
    expect(s.duration).toBe("期間: 2w");
    expect(s.selectionName).toBe("");
    expect(s.selectionRange).toBe("");
  });

  it("進捗は表示しない (廃止)", () => {
    const s = statusTexts(doc, derived, wc, null, TODAY);
    expect(Object.keys(s)).not.toContain("progress");
  });

  it("describes the selected task", () => {
    const first = doc.tasks[0]!;
    const s = statusTexts(doc, derived, wc, first.id, TODAY);
    const d = derived.byId.get(first.id.toLowerCase())!;
    expect(s.selectionName).toBe(first.name);
    expect(s.selectionRange).toBe(
      `${d.start.replace(/-/g, "/")} – ${d.end.replace(/-/g, "/")} (${formatDuration(d.durationDays, wc)})`,
    );
  });

  it("shows '-' for hours when no task has hours, and handles an empty project", () => {
    const empty: GanttDocument = { version: 1, project: { name: "x" }, tasks: [] };
    const s = statusTexts(empty, derivedOf(empty), calendarOf(empty), null, TODAY);
    expect(s.tasks).toBe("タスク: 0");
    expect(s.hours).toBe("工数: -");
    expect(s.duration).toBe("期間: -");
    expect(s.overdue).toBe("エラー: 0 件");
  });
});

describe("statusTexts: カテゴリ", () => {
  it("カテゴリはタスク数・期間・工数に含まれず、選択時の期間は空", () => {
    const base = load();
    const doc: GanttDocument = {
      ...base,
      tasks: [{ id: "cat-1", kind: "category", parentId: null, name: "見出し", resourceIds: [], dependencies: [] }, ...base.tasks],
    };
    const s = statusTexts(doc, derivedOf(doc), calendarOf(doc), "cat-1", TODAY);
    expect(s.tasks).toBe("タスク: 31");
    expect(s.hours).toBe("工数: 214h");
    expect(s.duration).toBe("期間: 2w");
    expect(s.selectionName).toBe("見出し");
    expect(s.selectionRange).toBe("");
  });
});

describe("statusTexts: マイルストーン・期限超過", () => {
  const mk = (): GanttDocument => ({
    version: 1,
    project: { name: "x" },
    tasks: [
      { id: "m1", kind: "milestone", parentId: null, name: "M", start: "2023-01-01", end: "2023-01-01", resourceIds: [], dependencies: [] },
      { id: "a", parentId: null, name: "A", start: "2023-05-20", end: "2023-05-21", hours: 5, resourceIds: [], dependencies: [] },
      { id: "b", parentId: null, name: "B", start: "2023-05-20", end: "2023-05-21", status: "done", resourceIds: [], dependencies: [] },
      { id: "c", parentId: null, name: "C", start: "2023-05-22", end: "2023-05-22", resourceIds: [], dependencies: [] },
    ],
  });
  it("マイルストーンはタスク数・期間・工数に含めない。選択時は日付だけ", () => {
    const doc = mk();
    const s = statusTexts(doc, derivedOf(doc), calendarOf(doc), "m1", TODAY);
    expect(s.tasks).toBe("タスク: 3");
    expect(s.hours).toBe("工数: 5h");
    expect(s.duration).toBe("期間: 3d"); // 5/20 - 5/22 (マイルストーンの 1/1 は含めない)
    expect(s.selectionRange).toBe("2023/01/01");
  });
  it("期限超過の件数: 未着手で開始日超過 (a) だけ。完了 (b)・今日が期限 (c)・マイルストーンは数えない", () => {
    const doc = mk();
    const s = statusTexts(doc, derivedOf(doc), calendarOf(doc), null, TODAY);
    expect(s.overdueCount).toBe(1);
    expect(s.overdue).toBe("エラー: 1 件");
  });
});
