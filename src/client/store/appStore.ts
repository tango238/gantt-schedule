import { produce } from "immer";
import { create } from "zustand";
import {
  buildTreeIndex,
  collapseAll as collapseAllView,
  deepEqual,
  executeCommand,
  expandAll as expandAllView,
  getChildren,
  revealTask,
  toggleCollapsed as toggleCollapsedView,
  type Command,
  type CommandContext,
  type CommandErr,
  type CommandOk,
} from "../../shared/engine";
import { todayIso } from "../../shared/model/date";
import { idKey, newId } from "../../shared/model/id";
import type { GanttDocument, Zoom } from "../../shared/model/types";
import { t } from "../i18n";
import { showToast } from "../components/uiStore";
import {
  SyncSession,
  createWsTransport,
  fetchSnapshot,
  type PresenceUser,
  type ScheduleSnapshot,
  type SessionHandlers,
  type SyncPhase,
} from "../sync";
import { loadView, saveView } from "./viewStorage";
import { loadCounts, onCommentsChanged, reloadCurrentComments, resetComments } from "../comments/commentsStore";
import { loadUsers } from "../users/usersStore";

export type EditingState = { taskId: string; field: "name" | "duration" | "hours" } | null;
export type CommandResult = CommandOk | CommandErr;
export type SaveStatus = "idle" | "saving" | "saved" | "reconnecting" | "error";
export type LoadStatus = "idle" | "loading" | "ready" | "notfound" | "deleted" | "error";

type View = NonNullable<GanttDocument["view"]>;

/** 過去のバージョンを読み取り専用で表示している間の状態。 */
export interface ViewingState {
  versionId: string;
  name: string;
  kind: "manual" | "auto";
  createdAt: number;
  /**
   * 表示を始める前の「現在のスケジュール」(同期が確定させた doc + 未確定コマンド。view なし) と rev。
   * 表示中も他者の update は同期セッションが受け取り続け、ここに反映される (閲覧中の doc は変わらない)。
   * 戻ると、これが画面に出る。
   */
  liveServerDoc: GanttDocument;
  liveRev: number;
  /** 表示前の view (ズーム・折りたたみ)。表示中の変更はその間だけのもので、戻ると元に戻る (localStorage にも書かない)。 */
  liveView: View | undefined;
}

export interface AppState {
  scheduleId: string | null;
  loadStatus: LoadStatus;
  /** サーバーが確定した最新の rev。 */
  rev: number;
  /** 送信待ち・送信中のコマンド数。 */
  pending: number;
  /**
   * 未確定コマンドがサーバーに反映されなかった可能性のある出来事 (拒否・競合による破棄・切断・取り直し) の累計。
   * 値が増えたら、その間に送ったコマンドの一部は確定していない (AI の適用が結果の確認に使う)。
   */
  syncLoss: number;
  saveStatus: SaveStatus;
  /** 同期の段階。session が無いとき (テスト・未接続) は "idle"。 */
  syncPhase: SyncPhase | "idle";
  /** 読み取り専用 (接続が live でない)。全てのコマンド発行経路はこれで止まる。 */
  readOnly: boolean;
  /** 接続中のユーザー (自分の接続を含む)。 */
  presence: PresenceUser[];
  /** 自分の接続 ID (presence の中の自分を見分ける)。 */
  selfConnId: string | null;
  /**
   * 画面に表示する doc。サーバー確定分 + 未確定の楽観的更新。doc.view はこのブラウザ専用
   * (サーバーには送らず localStorage に保存する)。
   */
  doc: GanttDocument | null;
  /**
   * 過去のバージョンを表示中なら、その情報。表示中は `doc` がそのバージョンの内容 (+ このブラウザの view) になり、
   * readOnly が true なのでコマンドは一切発行されない。
   */
  viewing: ViewingState | null;
  /** Transient document shown while dragging. Never committed. */
  preview: GanttDocument | null;
  selectedId: string | null;
  selectedDependency: { succId: string; predId: string } | null;
  editing: EditingState;
  valueColumn: "duration" | "hours";
  sidePanelOpen: boolean;
  sidePanelTab: "project" | "tasks";
  /** Incremented on every load (lets the view reset its scroll position per load). */
  loadCount: number;

  /** スケジュールを開く (読み込み + 同期の開始)。 */
  openSchedule(id: string): Promise<void>;
  /** 画面を離れる (接続を閉じる)。 */
  closeSchedule(): void;
  /** バージョンの内容を読み取り専用で表示する (現在のスケジュールの内容は裏で同期され続ける)。 */
  enterViewing(v: { id: string; name: string; kind: "manual" | "auto"; createdAt: number; doc: GanttDocument }): void;
  /** バージョンの表示をやめて、最新の現在のスケジュールに戻る。 */
  exitViewing(): void;
  /** サーバーのスナップショットを表示状態にする (openSchedule / テスト用)。接続は張らない。 */
  applySnapshot(snapshot: Pick<ScheduleSnapshot, "id" | "rev" | "doc">): void;
  dispatch(cmd: Command): CommandResult;
  setPreview(doc: GanttDocument): void;
  clearPreview(): void;
  setZoom(z: Zoom): void;
  toggleCollapsed(id: string): void;
  expandAll(): void;
  collapseAll(): void;

  select(id: string | null): void;
  selectDependency(dep: { succId: string; predId: string } | null): void;
  setEditing(e: EditingState): void;
  setValueColumn(c: "duration" | "hours"): void;
  setSidePanelOpen(open: boolean): void;
  setSidePanelTab(tab: "project" | "tasks"): void;
}

// ---------------------------------------------------------------------------
// Command context (injectable for tests)
// ---------------------------------------------------------------------------

let ctxOverride: Partial<CommandContext> | null = null;

/** Override parts of the command context (id generator, today, default name). Pass null to reset. */
export function setCommandContextOverride(o: Partial<CommandContext> | null): void {
  ctxOverride = o;
}

/** ローカル適用用のコンテキスト。生成した ID を記録し、サーバーにも同じ ID を使わせる。 */
function makeCtx(): { ctx: CommandContext; ids: string[] } {
  const ids: string[] = [];
  const gen = ctxOverride?.newId ?? newId;
  return {
    ids,
    ctx: {
      today: todayIso(),
      defaultTaskName: t("task.defaultName"),
      defaultCategoryName: t("category.defaultName"),
      defaultMilestoneName: t("milestone.defaultName"),
      ...ctxOverride,
      newId: () => {
        const id = gen();
        ids.push(id);
        return id;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Sync session (1 つの開いているスケジュールにつき 1 つ)
// ---------------------------------------------------------------------------

/** テスト用に差し替えられる SyncSession の作り方。 */
export type SessionFactory = (id: string, handlers: SessionHandlers) => SyncSession;
const defaultSessionFactory: SessionFactory = (id, handlers) =>
  new SyncSession({ transport: createWsTransport(id), loadSnapshot: () => fetchSnapshot(id) }, handlers);
let sessionFactory: SessionFactory = defaultSessionFactory;
export function setSessionFactory(f: SessionFactory | null): void {
  sessionFactory = f ?? defaultSessionFactory;
}

/** この画面が復元を実行中 (HTTP 要求中) の数。その間に届く reset は自分の復元なので、通知を出さない。 */
let selfRestoreInFlight = 0;
export function markSelfRestore(on: boolean): void {
  selfRestoreInFlight = Math.max(0, selfRestoreInFlight + (on ? 1 : -1));
}

let session: { id: string; sync: SyncSession; stop: () => void } | null = null;

function taskExists(doc: GanttDocument, id: string): boolean {
  const k = idKey(id);
  return doc.tasks.some((t) => idKey(t.id) === k);
}

/** Drop selection / editing state that points at tasks which no longer exist. */
function sanitizeUi(s: AppState, doc: GanttDocument): Partial<AppState> {
  const out: Partial<AppState> = {};
  if (s.selectedId !== null && !taskExists(doc, s.selectedId)) out.selectedId = null;
  const dep = s.selectedDependency;
  if (dep !== null) {
    const succ = doc.tasks.find((t) => idKey(t.id) === idKey(dep.succId));
    const ok = succ?.dependencies?.some((d) => idKey(d.predecessorId) === idKey(dep.predId)) ?? false;
    if (!ok) out.selectedDependency = null;
  }
  if (s.editing !== null && !taskExists(doc, s.editing.taskId)) out.editing = null;
  return out;
}

const withoutView = (doc: GanttDocument): GanttDocument => {
  const { view: _v, ...rest } = doc;
  return rest as GanttDocument;
};

/** サーバーの doc (view なし) に、このブラウザの view を重ねる。存在しない/子のないタスクの折りたたみは捨てる。 */
function withLocalView(serverDoc: GanttDocument, view: View | undefined): GanttDocument {
  const base = serverDoc as GanttDocument;
  const v: View = view ?? { zoom: "day", collapsedTaskIds: [] };
  const ix = buildTreeIndex(base);
  const collapsed = (v.collapsedTaskIds ?? []).filter((id) => getChildren(ix, id).length > 0);
  return { ...base, view: { zoom: v.zoom ?? "day", collapsedTaskIds: collapsed } };
}

function persistView(view: View | undefined): void {
  const { scheduleId: id, viewing } = useAppStore.getState();
  if (viewing !== null) return; // バージョン表示中の view は保存しない
  if (id !== null && view) saveView(id, view);
}

/**
 * session が組み立てた doc (サーバー確定 + 未確定コマンド) を画面に反映する。内容が同じなら doc の参照を保つ
 * (ドラッグ中の中断や再描画を避ける)。ドラッグ中の preview は消さない (次の pointermove で作り直される)。
 */
function showServerDoc(serverDoc: GanttDocument, rev: number): void {
  const s = useAppStore.getState();
  if (s.doc === null) return;
  if (s.viewing !== null) {
    // バージョン表示中: 画面 (doc) は変えず、戻ったときに出す最新の内容だけ更新する。
    useAppStore.setState({ rev, viewing: { ...s.viewing, liveServerDoc: serverDoc, liveRev: rev } });
    return;
  }
  if (deepEqual(withoutView(s.doc), serverDoc)) {
    if (s.rev !== rev) useAppStore.setState({ rev });
    return;
  }
  const doc = withLocalView(serverDoc, s.doc.view);
  useAppStore.setState({ ...sanitizeUi(s, doc), doc, rev });
  persistView(doc.view);
}

function toastRejected(r: { reason: string; code?: string; params?: Record<string, string | number> }): void {
  if (r.reason === "command" && r.code) showToast("error", t(`error.engine.${r.code}`, r.params));
  else if (r.reason === "too_large") showToast("error", t("error.sync.tooLarge"));
  else if (r.reason === "server_error") showToast("error", t("error.sync.failed"));
  else showToast("error", t("error.sync.rejected"));
}

function bumpLoss(): void {
  useAppStore.setState((s) => ({ syncLoss: s.syncLoss + 1 }));
}

function makeHandlers(id: string): SessionHandlers {
  const set = useAppStore.setState;
  const live = () => useAppStore.getState().scheduleId === id;
  return {
    onDoc({ doc, rev, cause }) {
      if (!live()) return;
      if (cause === "load") {
        useAppStore.getState().applySnapshot({ id, rev, doc });
      } else {
        showServerDoc(doc, rev);
      }
    },
    onStatus({ phase, pending }) {
      if (!live()) return;
      const prev = useAppStore.getState();
      const readOnly = phase !== "live" || prev.viewing !== null;
      let saveStatus: SaveStatus = prev.saveStatus;
      if (phase === "reconnecting" || phase === "resyncing") saveStatus = "reconnecting";
      else if (phase === "live") {
        if (pending > 0) saveStatus = "saving";
        else if (prev.saveStatus === "saving" || prev.saveStatus === "reconnecting") saveStatus = "saved";
      }
      const patch: Partial<AppState> = { syncPhase: phase, readOnly, pending, saveStatus };
      if (phase !== "live" && prev.syncPhase === "live") patch.syncLoss = prev.syncLoss + 1;
      if (phase === "notfound" || phase === "deleted") {
        patch.loadStatus = phase;
        patch.editing = null;
        patch.preview = null;
      } else if (phase === "error") {
        if (prev.loadStatus === "loading") patch.loadStatus = "error";
      }
      if (readOnly) {
        patch.editing = null;
        patch.preview = null;
      }
      set(patch);
      if (phase === "live" && prev.syncPhase !== "live") {
        sendSelection();
        // 接続できていなかった間のコメントの変更を取り込む。
        void loadCounts();
        reloadCurrentComments();
      }
    },
    onCommentsChanged(taskId) {
      if (!live()) return;
      onCommentsChanged(taskId);
    },
    onPresence({ users, selfConnId }) {
      if (!live()) return;
      set({ presence: users, selfConnId });
    },
    onDropped(count) {
      if (!live()) return;
      bumpLoss();
      showToast("error", t("error.sync.dropped", { count }));
    },
    onConflictDropped() {
      if (!live()) return;
      bumpLoss();
      showToast("error", t("error.sync.conflictDropped"));
    },
    onRejected(r) {
      if (!live()) return;
      bumpLoss();
      toastRejected(r);
      if (r.reason === "server_error") set({ saveStatus: "error" });
    },
    onRestored({ by, versionName, selfUserId }) {
      if (!live()) return;
      // この画面が今まさに行っている復元は、操作した側が結果を知らせる。
      if (selfRestoreInFlight > 0) return;
      // 同じユーザーの別タブでの復元 (userId が自分で、この画面が行ったものではない) と他のユーザーの復元は通知する。
      if (by.userId === selfUserId) showToast("info", t("versions.restored", { name: versionName }));
      else showToast("info", t("versions.restoredBy", { user: by.name, name: versionName }));
    },
    onUnauthorized() {
      if (!live()) return;
      showToast("error", t("error.sync.sessionExpired"));
      setTimeout(() => window.location.reload(), 1200);
    },
  };
}

/** 自分の選択 (選択中のタスク) をプレゼンスとして送る。呼び出しは軽くデバウンスされる。 */
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
export const PRESENCE_DEBOUNCE_MS = 120;
function sendSelection(): void {
  if (!session) return;
  const { selectedId: id, viewing } = useAppStore.getState();
  // バージョン表示中の選択は過去の doc のタスクなので共有しない。
  session.sync.setSelection(id === null || viewing !== null ? [] : [id]);
}
function scheduleSendSelection(): void {
  if (presenceTimer !== null) clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    sendSelection();
  }, PRESENCE_DEBOUNCE_MS);
}

function closeSession(): void {
  if (presenceTimer !== null) clearTimeout(presenceTimer);
  presenceTimer = null;
  if (!session) return;
  session.stop();
  session.sync.close();
  session = null;
}

export const useAppStore = create<AppState>()((set, get) => ({
  scheduleId: null,
  loadStatus: "idle",
  rev: 0,
  pending: 0,
  syncLoss: 0,
  saveStatus: "idle",
  syncPhase: "idle",
  readOnly: false,
  presence: [],
  selfConnId: null,
  doc: null,
  viewing: null,
  preview: null,
  selectedId: null,
  selectedDependency: null,
  editing: null,
  valueColumn: "duration",
  sidePanelOpen: true,
  sidePanelTab: "tasks",
  loadCount: 0,

  async openSchedule(id) {
    closeSession();
    set({
      scheduleId: id,
      loadStatus: "loading",
      doc: null,
      viewing: null,
      preview: null,
      rev: 0,
      pending: 0,
      saveStatus: "idle",
      syncPhase: "connecting",
      readOnly: true,
      presence: [],
      selfConnId: null,
      selectedId: null,
      selectedDependency: null,
      editing: null,
    });
    resetComments(id);
    void loadUsers(true);
    const sync = sessionFactory(id, makeHandlers(id));
    // タブの復帰・オンライン復帰で接続を確認し、オフラインになったら即座に読み取り専用にする。
    const onVisible = () => {
      if (document.visibilityState === "visible") sync.nudge();
    };
    const onOnline = () => sync.nudge();
    const onOffline = () => sync.goOffline();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const stop = () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    session = { id, sync, stop };
    await sync.start();
  },

  closeSchedule() {
    closeSession();
    resetComments(null);
    set({
      scheduleId: null,
      loadStatus: "idle",
      doc: null,
      viewing: null,
      preview: null,
      pending: 0,
      saveStatus: "idle",
      syncPhase: "idle",
      readOnly: false,
      presence: [],
      selfConnId: null,
    });
  },

  enterViewing(v) {
    const s = get();
    if (s.doc === null) return;
    // 表示前の現在のスケジュールを退避する (既に別のバージョンを表示中なら、退避済みのものを引き継ぐ)。
    const live = s.viewing
      ? { liveServerDoc: s.viewing.liveServerDoc, liveRev: s.viewing.liveRev, liveView: s.viewing.liveView }
      : { liveServerDoc: withoutView(s.doc), liveRev: s.rev, liveView: s.doc.view };
    set({
      viewing: { versionId: v.id, name: v.name, kind: v.kind, createdAt: v.createdAt, ...live },
      doc: withLocalView(withoutView(v.doc), s.doc.view),
      readOnly: true,
      loadCount: s.loadCount + 1,
      preview: null,
      selectedId: null,
      selectedDependency: null,
      editing: null,
    });
  },

  exitViewing() {
    const s = get();
    if (s.viewing === null || s.doc === null) return;
    const doc = withLocalView(s.viewing.liveServerDoc, s.viewing.liveView);
    set({
      viewing: null,
      doc,
      rev: s.viewing.liveRev,
      readOnly: s.syncPhase !== "live" && s.syncPhase !== "idle",
      loadCount: s.loadCount + 1,
      preview: null,
      selectedId: null,
      selectedDependency: null,
      editing: null,
    });
    sendSelection();
  },

  applySnapshot(snapshot) {
    const doc = withLocalView(snapshot.doc, loadView(snapshot.id));
    set({
      loadCount: get().loadCount + 1,
      scheduleId: snapshot.id,
      loadStatus: "ready",
      rev: snapshot.rev,
      doc,
      viewing: null,
      preview: null,
      selectedId: null,
      selectedDependency: null,
      editing: null,
    });
  },

  dispatch(cmd) {
    const s = get();
    if (s.doc === null) return { ok: false, code: "TASK_NOT_FOUND" };
    // 接続が live でない間は全ての経路 (ドラッグ・インライン編集・サイドパネル・キーボード・ツールバー) がここで止まる。
    if (s.readOnly || s.viewing !== null) return { ok: false, code: "READ_ONLY" };
    const { ctx, ids } = makeCtx();
    const res = executeCommand(s.doc, cmd, ctx);
    if (!res.ok) return res;
    // 送れない状態 (live でない) なら、ローカルにも適用しない。
    if (res.patches.length > 0 && session !== null && !session.sync.live) return { ok: false, code: "READ_ONLY" };

    let doc = res.doc;
    if (res.reveal && res.reveal.length > 0) {
      const ix = buildTreeIndex(doc);
      let view = doc.view ?? { zoom: "day" as Zoom, collapsedTaskIds: [] };
      for (const id of res.reveal) view = revealTask(view, ix, id);
      if (view !== (doc.view ?? view)) {
        const v = view;
        doc = produce(doc, (d) => {
          d.view = v;
        });
        persistView(v);
      }
    }

    const patch: Partial<AppState> = { preview: null, doc };
    if (res.selection !== undefined) {
      patch.selectedId = res.selection;
      patch.selectedDependency = null;
    }
    if (res.editName && res.selection) {
      patch.editing = { taskId: res.selection, field: "name" };
    }
    set((cur) => ({ ...patch, ...sanitizeUi({ ...cur, ...patch }, doc) }));

    // 実質変更のあるコマンドだけをサーバーへ送る (view の変更は送らない)。
    if (res.patches.length > 0 && session !== null) {
      if (!session.sync.submit(cmd, { today: ctx.today, ids, defaultTaskName: ctx.defaultTaskName, defaultCategoryName: ctx.defaultCategoryName, defaultMilestoneName: ctx.defaultMilestoneName })) {
        // 事前確認と submit の間に状態が変わった場合の保険: ローカル適用を取り消す。
        set({ doc: s.doc, preview: null });
        return { ok: false, code: "READ_ONLY" };
      }
    }
    return res;
  },

  setPreview(doc) {
    set({ preview: doc });
  },
  clearPreview() {
    if (get().preview !== null) set({ preview: null });
  },

  setZoom(z) {
    const s = get();
    if (s.doc === null || s.doc.view?.zoom === z) return;
    applyView({ ...(s.doc.view ?? { collapsedTaskIds: [] }), zoom: z } as View);
  },

  toggleCollapsed(id) {
    const s = get();
    if (s.doc === null) return;
    applyView(toggleCollapsedView(s.doc.view ?? { zoom: "day", collapsedTaskIds: [] }, id));
  },
  expandAll() {
    const s = get();
    if (s.doc === null) return;
    applyView(expandAllView(s.doc.view ?? { zoom: "day", collapsedTaskIds: [] }));
  },
  collapseAll() {
    const s = get();
    if (s.doc === null) return;
    applyView(collapseAllView(s.doc.view ?? { zoom: "day", collapsedTaskIds: [] }, buildTreeIndex(s.doc)));
  },

  select(id) {
    set({ selectedId: id, selectedDependency: null });
  },
  selectDependency(dep) {
    set({ selectedDependency: dep, ...(dep ? { selectedId: null } : {}) });
  },
  setEditing(e) {
    if (e !== null && get().readOnly) return;
    set({ editing: e });
  },
  setValueColumn(c) {
    set({ valueColumn: c });
  },
  setSidePanelOpen(open) {
    set({ sidePanelOpen: open });
  },
  setSidePanelTab(tab) {
    set({ sidePanelTab: tab });
  },
}));

/** view の変更はローカルだけ (サーバーへは送らない)。localStorage に保存する。 */
function applyView(view: View): void {
  const s = useAppStore.getState();
  if (s.doc === null || view === s.doc.view) return;
  // Nothing actually changed (e.g. collapseAll when already collapsed).
  const before = new Set((s.doc.view?.collapsedTaskIds ?? []).map(idKey));
  const after = new Set((view.collapsedTaskIds ?? []).map(idKey));
  if (before.size === after.size && [...after].every((k) => before.has(k)) && s.doc.view?.zoom === view.zoom) {
    return;
  }
  useAppStore.setState({
    doc: produce(s.doc, (d) => {
      d.view = view;
    }),
  });
  persistView(view);
}

// 選択が変わったら (操作・コマンド結果・削除による解除のどれでも) プレゼンスを送る。
useAppStore.subscribe((s, prev) => {
  if (s.selectedId !== prev.selectedId) scheduleSendSelection();
});
