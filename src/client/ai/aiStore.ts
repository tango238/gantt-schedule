import { create } from "zustand";
import type { GanttDocument } from "../../shared/model/types";
import { clampPaneHeight, loadPaneState, savePaneState } from "./paneSize";
import type { Diff } from "./plan";
import type { AiOp } from "./ops";
import { loadSettings, saveSettings, type AiSettings } from "./settings";

export type ProposalState =
  | "pending" // 適用待ち
  | "applying"
  | "superseded" // 新しい変更案に置き換えられた
  | "applied"
  | "partial" // 途中で止まった
  | "discarded"
  | "stale" // 他の編集で前提が変わり適用できなかった
  | "failed"; // 自動バージョンの作成失敗などで中止

export interface Proposal {
  ops: AiOp[];
  diff: Diff;
  /** プレビューの基にした doc (view なし)。適用時に現在の doc と同一か確かめる。 */
  before: GanttDocument;
  state: ProposalState;
  /** 適用待ちのままの注記 (作り直した・自動バージョンに失敗した、など)。 */
  notice?: string;
  /** 適用結果などの補足 (表示用)。 */
  detail?: string;
}

export type AiMessage =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; /** プロバイダーが返した生のテキスト (会話履歴用) */ raw: string; proposal?: Proposal }
  | { id: number; kind: "error"; text: string }
  | { id: number; kind: "notice"; text: string };

export type AiStatus = "idle" | "thinking" | "validating" | "applying";

export interface AiState {
  open: boolean;
  height: number;
  settings: AiSettings;
  settingsOpen: boolean;
  messages: AiMessage[];
  status: AiStatus;
  /** ペインを開いたときに入力欄へフォーカスを移すためのカウンター。 */
  focusTick: number;

  setOpen(open: boolean): void;
  toggle(): void;
  /** 高さを (表示のために) 変える。保存はしない。 */
  setHeight(h: number): void;
  /** 現在の高さを保存する (ドラッグの終了・キー操作)。 */
  commitHeight(): void;
  openSettings(): void;
  closeSettings(): void;
  /** 設定を保存して反映する。保存できなければ false。 */
  updateSettings(s: AiSettings): boolean;
  setStatus(s: AiStatus): void;
  push(m: AiMessage): void;
  patchProposal(id: number, patch: Partial<Proposal>): void;
}

let nextId = 1;
export const nextMessageId = (): number => nextId++;

const windowHeight = (): number => (typeof window === "undefined" ? 900 : window.innerHeight);

function initial() {
  const p = loadPaneState();
  // 高さは保存値のまま持つ。ウィンドウに収めるのは表示のときだけ (小さいウィンドウで開いても保存値を壊さない)。
  return { open: p.open, height: p.height, settings: loadSettings() };
}

export const useAiStore = create<AiState>()((set, get) => ({
  ...initial(),
  settingsOpen: false,
  messages: [],
  status: "idle",
  focusTick: 0,

  setOpen(open) {
    set((s) => ({ open, focusTick: open ? s.focusTick + 1 : s.focusTick }));
    savePaneState({ open, height: get().height });
  },
  toggle() {
    get().setOpen(!get().open);
  },
  setHeight(h) {
    set({ height: clampPaneHeight(h, windowHeight()) });
  },
  commitHeight() {
    savePaneState({ open: get().open, height: get().height });
  },
  openSettings() {
    set({ settingsOpen: true });
  },
  closeSettings() {
    set({ settingsOpen: false });
  },
  updateSettings(s) {
    const ok = saveSettings(s);
    set({ settings: s });
    return ok;
  },
  setStatus(status) {
    set({ status });
  },
  push(m) {
    set((s) => ({ messages: [...s.messages, m] }));
  },
  patchProposal(id, patch) {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id && m.kind === "assistant" && m.proposal ? { ...m, proposal: { ...m.proposal, ...patch } } : m)),
    }));
  },
}));

export function resetAiStoreForTest(): void {
  useAiStore.setState({ ...initial(), settingsOpen: false, messages: [], status: "idle", focusTick: 0 });
}
