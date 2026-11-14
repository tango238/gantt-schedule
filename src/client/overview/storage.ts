import type { TaskStatus, Zoom } from "../../shared/model/types";
import { DEFAULT_PANE_HEIGHT } from "../ai/paneSize";

/** 全体スケジュールに出すプロジェクト (スケジュール) の ID (ブラウザごと)。 */
export const SELECTION_KEY = "schedule.overview.v1";
/** 全体スケジュールの表示状態 (高さ・ズーム・期間/工数・折りたたみ)。 */
export const VIEW_KEY = "schedule.overview.view.v1";

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function loadSelection(): string[] {
  const v = read(SELECTION_KEY) as { ids?: unknown } | null;
  return [...new Set(strings(v?.ids))];
}
export function saveSelection(ids: readonly string[]): void {
  write(SELECTION_KEY, { ids: [...new Set(ids)] });
}
/** 存在するスケジュールの ID だけ残す (順序は保つ)。 */
export function pruneIds(ids: readonly string[], existing: ReadonlySet<string>): string[] {
  return ids.filter((id) => existing.has(id));
}

export interface OverviewView {
  zoom: Zoom;
  valueColumn: "duration" | "hours";
  height: number;
  /** 折りたたんだ行のキー (プロジェクト = スケジュール ID、それ以外 = `<スケジュール ID>:<小文字のタスク ID>`)。 */
  collapsed: string[];
  /** 担当者の絞り込み (ユーザー ID。"" = 担当なし)。空 = 絞り込まない。 */
  assignees: string[];
  /** 状況の絞り込み。空 = 絞り込まない。 */
  statuses: TaskStatus[];
}
export const STATUSES: readonly TaskStatus[] = ["todo", "doing", "done"];
export const DEFAULT_VIEW: OverviewView = {
  zoom: "week",
  valueColumn: "duration",
  height: DEFAULT_PANE_HEIGHT,
  collapsed: [],
  assignees: [],
  statuses: [],
};

export function loadView(): OverviewView {
  const v = read(VIEW_KEY) as Partial<Record<keyof OverviewView, unknown>> | null;
  if (v === null || typeof v !== "object") return { ...DEFAULT_VIEW };
  return {
    zoom: v.zoom === "day" || v.zoom === "week" || v.zoom === "month" ? v.zoom : DEFAULT_VIEW.zoom,
    valueColumn: v.valueColumn === "hours" ? "hours" : "duration",
    height: typeof v.height === "number" && Number.isFinite(v.height) ? v.height : DEFAULT_VIEW.height,
    collapsed: strings(v.collapsed),
    assignees: [...new Set(strings(v.assignees))],
    statuses: STATUSES.filter((x) => strings(v.statuses).includes(x)),
  };
}
export function saveView(view: OverviewView): void {
  write(VIEW_KEY, view);
}
/** 存在しないスケジュールの折りたたみを捨てる。 */
export function pruneCollapsed(keys: readonly string[], existing: ReadonlySet<string>): string[] {
  return keys.filter((k) => {
    const i = k.indexOf(":");
    return existing.has(i < 0 ? k : k.slice(0, i));
  });
}

/** 保存済みの表示状態から、存在しないスケジュールの折りたたみを捨てて保存し直す (変わらなければ書かない)。 */
export function pruneStoredCollapsed(existing: ReadonlySet<string>): void {
  const v = loadView();
  const kept = pruneCollapsed(v.collapsed, existing);
  if (kept.length !== v.collapsed.length) saveView({ ...v, collapsed: kept });
}
