import type { GanttDocument, Zoom } from "../../shared/model/types";

/**
 * view (ズーム・折りたたみ) は共有ドキュメントに含めず、このブラウザの localStorage に
 * スケジュール ID 別で保存する。localStorage が使えない環境でも例外にしない。
 */
type View = NonNullable<GanttDocument["view"]>;

const key = (scheduleId: string) => `schedule:view:${scheduleId}`;
export const DEFAULT_VIEW: View = { zoom: "day", collapsedTaskIds: [] };
const ZOOMS: readonly Zoom[] = ["day", "week", "month"];

export function loadView(scheduleId: string): View {
  try {
    const raw = localStorage.getItem(key(scheduleId));
    if (raw === null) return { ...DEFAULT_VIEW, collapsedTaskIds: [] };
    const v = JSON.parse(raw) as { zoom?: unknown; collapsedTaskIds?: unknown };
    return {
      zoom: ZOOMS.includes(v.zoom as Zoom) ? (v.zoom as Zoom) : "day",
      collapsedTaskIds: Array.isArray(v.collapsedTaskIds)
        ? v.collapsedTaskIds.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return { ...DEFAULT_VIEW, collapsedTaskIds: [] };
  }
}

export function saveView(scheduleId: string, view: View): void {
  try {
    localStorage.setItem(key(scheduleId), JSON.stringify({ zoom: view.zoom ?? "day", collapsedTaskIds: view.collapsedTaskIds ?? [] }));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}
