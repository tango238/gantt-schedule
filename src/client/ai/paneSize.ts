export const MIN_PANE_HEIGHT = 140;
export const DEFAULT_PANE_HEIGHT = 280;
/** ヘッダー + 帯 + ツールバー + ステータスバーの合計の目安。 */
const CHROME_HEIGHT = 48 + 40 + 24;
/** ペインを開いてもガント領域に残す最小の高さ。 */
export const MIN_CHART_HEIGHT = 160;

export const maxPaneHeight = (windowHeight: number): number => windowHeight - CHROME_HEIGHT - MIN_CHART_HEIGHT;

/** [MIN, window - 余白] に収める。ウィンドウが小さすぎるときは最小値を優先する。 */
export function clampPaneHeight(h: number, windowHeight: number): number {
  const v = Number.isFinite(h) ? h : DEFAULT_PANE_HEIGHT;
  return Math.round(Math.max(MIN_PANE_HEIGHT, Math.min(v, maxPaneHeight(windowHeight))));
}

export const PANE_STORAGE_KEY = "schedule.ai.pane.v1";

export interface PaneState {
  open: boolean;
  height: number;
}

export function loadPaneState(): PaneState {
  try {
    const raw = localStorage.getItem(PANE_STORAGE_KEY);
    if (raw === null) return { open: false, height: DEFAULT_PANE_HEIGHT };
    const v = JSON.parse(raw) as { open?: unknown; height?: unknown };
    return {
      open: v.open === true,
      height: typeof v.height === "number" && Number.isFinite(v.height) ? v.height : DEFAULT_PANE_HEIGHT,
    };
  } catch {
    return { open: false, height: DEFAULT_PANE_HEIGHT };
  }
}

export function savePaneState(s: PaneState): void {
  try {
    localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}
