import type { Command } from "../../shared/engine";
import type { GanttDocument } from "../../shared/model/types";
import { CLOSE_DELETED, CLOSE_UNAUTHORIZED, type ClientMessage, type ServerMessage } from "../../shared/protocol";
import { SyncModel } from "./model";
import type {
  CommandContextInput,
  LoadOutcome,
  SessionHandlers,
  SyncPhase,
  Transport,
} from "./types";

export interface SessionDeps {
  transport: Transport;
  /** GET /api/schedules/:id */
  loadSnapshot(): Promise<LoadOutcome>;
  /** テスト用に差し替え可能なタイマー。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  random?: () => number;
}

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 15_000;

/** 再接続の待ち時間 (指数バックオフ + ジッター)。attempt は 0 から。 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.5 + random() * 0.5));
}

/**
 * 1 つのスケジュールの同期セッション: WebSocket の接続・再接続、初期同期、状態モデル (SyncModel) の更新、
 * 切断時の読み取り専用化。ストアとは SessionHandlers でだけ繋がる。
 */
export class SyncSession {
  readonly model = new SyncModel();
  phase: SyncPhase = "connecting";
  private everLive = false;
  private gen = 0;
  private syncGen = 0;
  /** hello 前・スナップショット取得中に届いた update。 */
  private buffer: Extract<ServerMessage, { type: "update" }>[] = [];
  /** true の間、update は適用せず buffer に積む (接続直後〜スナップショット適用まで)。 */
  private buffering = true;
  /** スナップショット取得中か。 */
  private fetching = false;
  /** 取得中に reset / 欠番が来た: 今の取得が終わったらもう一度取り直す。 */
  private again = false;
  private attempt = 0;
  private timer: unknown = null;
  private closed = false;
  private selection: string[] = [];
  private selfConnId: string | null = null;
  private selfUserId: string | null = null;
  private settle!: () => void;
  private settled = false;
  private readonly firstSettle: Promise<void>;
  private lastSentSelection: string | null = null;

  constructor(
    private readonly deps: SessionDeps,
    private readonly h: SessionHandlers,
  ) {
    this.firstSettle = new Promise<void>((r) => (this.settle = r));
  }

  get pendingCount(): number {
    return this.model.pending.length;
  }
  get live(): boolean {
    return this.phase === "live";
  }

  /** 接続を開始する。最初の状態 (live / notfound / error ...) が決まったら解決する。 */
  start(): Promise<void> {
    // 接続は 1 tick 遅らせる: React の StrictMode (開発) は effect を mount -> cleanup -> mount と同期的に二重実行する。
    // すぐ張って即閉じると、ハンドシェイク途中で中断された WebSocket がサーバー側で閉じ通知を受けずに残ることがある。
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, 0);
    return this.firstSettle;
  }

  /** 以降ハンドラを呼ばず、接続を閉じる。 */
  close(): void {
    this.closed = true;
    this.gen++;
    this.syncGen++;
    this.cancelTimer();
    this.deps.transport.close();
    this.settleFirst();
  }

  /** コマンドを送る。表示 doc はストアが適用済み。live でなければ false (呼び出し側が止める)。 */
  submit(command: Command, context: CommandContextInput): boolean {
    if (this.phase !== "live" || !this.model.ready) return false;
    const p = this.model.add(command, context);
    this.deps.transport.send(JSON.stringify({ type: "command", reqId: p.reqId, baseRev: this.model.serverRev, command, context } satisfies ClientMessage));
    this.emitStatus();
    return true;
  }

  /** 自分の選択中タスクを知らせる (live でなければ、接続できたときに送る)。 */
  setSelection(ids: string[]): void {
    this.selection = ids;
    this.sendPresence();
  }

  /** タブの復帰・オンライン復帰: 再接続待ちなら今すぐ再接続し、live なら生存確認する。 */
  nudge(): void {
    if (this.closed) return;
    if (this.phase === "reconnecting") {
      if (this.timer !== null) {
        this.cancelTimer();
        this.connect();
      }
    } else if (this.phase === "live") {
      this.deps.transport.check();
    }
  }

  /** ブラウザが offline になった: 生きている接続を待たずに切断扱いにする。 */
  goOffline(): void {
    if (this.closed || (this.phase !== "live" && this.phase !== "resyncing")) return;
    this.onTransportClosed(this.gen, { code: 1006, opened: true });
  }

  // ---- 接続 ----

  private connect(): void {
    if (this.closed) return;
    const gen = ++this.gen;
    this.syncGen++;
    this.buffering = true;
    this.fetching = false;
    this.again = false;
    this.buffer = [];
    this.deps.transport.connect({
      onMessage: (m) => {
        if (gen === this.gen && !this.closed) this.onMessage(m);
      },
      onClose: (info) => {
        if (gen === this.gen && !this.closed) this.onTransportClosed(gen, info);
      },
    });
  }

  private setPhase(phase: SyncPhase): void {
    this.phase = phase;
    this.emitStatus();
  }
  private emitStatus(): void {
    this.h.onStatus({ phase: this.phase, pending: this.model.pending.length });
  }
  private settleFirst(): void {
    if (!this.settled) {
      this.settled = true;
      this.settle();
    }
  }

  private onTransportClosed(gen: number, info: { code: number; opened: boolean }): void {
    if (gen !== this.gen) return;
    this.gen++; // この接続からの以降のイベントを無視
    this.syncGen++;
    this.fetching = false;
    this.deps.transport.close();
    if (info.code === CLOSE_UNAUTHORIZED) return this.terminate("unauthorized");
    if (info.code === CLOSE_DELETED) return this.terminate(this.everLive ? "deleted" : "notfound");

    if (!info.opened) {
      // ハンドシェイクの失敗 (ブラウザには 401 / 403 / 404 の区別が見えない): HTTP で理由を確かめる。
      // live だった接続の再接続でも同じ (オフライン中に削除された・セッションが失効した場合に永久に再接続を続けない)。
      const sg = ++this.syncGen;
      void this.deps.loadSnapshot().then((out) => {
        if (sg !== this.syncGen || this.closed) return;
        if (out.kind === "notfound") this.terminate(this.everLive ? "deleted" : "notfound");
        else if (out.kind === "unauthorized") this.terminate("unauthorized");
        else if (this.everLive) this.dropAndReconnect(); // 通信できない・一時的な失敗: バックオフで再接続
        else this.terminate("error");
      });
      return;
    }
    if (!this.everLive) return this.terminate("error");
    this.dropAndReconnect();
  }

  private terminate(phase: "unauthorized" | "notfound" | "deleted" | "error"): void {
    this.cancelTimer();
    this.gen++;
    this.syncGen++;
    this.deps.transport.close();
    this.model.dropPending();
    this.setPhase(phase);
    if (phase === "unauthorized") this.h.onUnauthorized();
    this.settleFirst();
  }

  /** 切断: 未確定コマンドを破棄して読み取り専用にし、バックオフで再接続する。 */
  private dropAndReconnect(): void {
    const dropped = this.model.dropPending();
    if (this.model.ready) this.emitDoc("sync");
    if (dropped.length > 0) this.h.onDropped(dropped.length);
    this.setPhase("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.cancelTimer();
    const delay = backoffDelay(this.attempt++, this.deps.random);
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
  private cancelTimer(): void {
    if (this.timer !== null) {
      (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
  }

  // ---- 受信 ----

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case "hello":
        this.selfConnId = m.you.connId;
        this.selfUserId = m.you.userId;
        this.h.onPresence({ users: m.presence, selfConnId: this.selfConnId });
        this.beginSync();
        return;
      case "presence":
        this.h.onPresence({ users: m.users, selfConnId: this.selfConnId });
        return;
      case "update":
        if (this.buffering) this.buffer.push(m);
        else this.onUpdate(m);
        return;
      case "ack":
        this.model.ack(m.reqId, m.rev);
        this.emitStatus();
        return;
      case "reject": {
        if (this.model.reject(m.reqId)) {
          this.emitDoc("local");
          this.emitStatus();
        }
        // stale: 復元より前の状態で作った操作。reset で既に捨てているので何も表示しない。
        if (m.reason === "stale") return;
        this.h.onRejected({
          reason: m.reason,
          ...(m.code ? { code: m.code } : {}),
          ...(m.params ? { params: m.params } : {}),
        });
        return;
      }
      case "reset":
        if (m.restored) this.h.onRestored?.({ ...m.restored, selfUserId: this.selfUserId });
        if (this.fetching) this.again = true; // 取得中に来た: 終わったらもう一度取り直す (今の結果は古いかもしれない)
        else if (m.rev !== this.model.serverRev) this.beginSync();
        return;
      case "comments":
        this.h.onCommentsChanged?.(m.taskId);
        return;
      case "deleted":
        this.terminate(this.everLive ? "deleted" : "notfound");
        return;
    }
  }

  private onUpdate(u: Extract<ServerMessage, { type: "update" }>): void {
    const r = this.model.applyUpdate(u);
    if (r === "applied") {
      this.emitDoc("remote");
      this.emitStatus();
    } else if (r === "gap") {
      this.beginSync();
    }
  }

  /** doc を取り直す (hello 後・欠番・reset)。その間は読み取り専用で、未確定コマンドは破棄する。 */
  private beginSync(): void {
    if (this.fetching) {
      this.again = true;
      return;
    }
    this.fetching = true;
    this.buffering = true;
    this.buffer = [];
    const sg = ++this.syncGen;
    if (this.phase === "live") {
      const dropped = this.model.dropPending();
      if (dropped.length > 0) this.h.onDropped(dropped.length);
      this.setPhase("resyncing");
    }
    void this.deps.loadSnapshot().then((out) => {
      if (sg !== this.syncGen || this.closed) return;
      this.fetching = false;
      this.onSnapshot(out);
    });
  }

  private onSnapshot(out: LoadOutcome): void {
    if (out.kind === "notfound") return this.terminate(this.everLive ? "deleted" : "notfound");
    if (out.kind === "unauthorized") return this.terminate("unauthorized");
    if (out.kind === "error") {
      if (!this.everLive) return this.terminate("error");
      // 再接続の途中で取得に失敗: 接続を張り直す。
      this.buffering = true;
      this.deps.transport.close();
      this.gen++;
      this.dropAndReconnect();
      return;
    }
    if (this.again) {
      // 取得中に reset / 欠番が来た: この結果は古い可能性があるので捨てて取り直す。
      this.again = false;
      this.beginSync();
      return;
    }
    const dropped = this.model.reset(out.snapshot.doc, out.snapshot.rev);
    if (dropped.length > 0) this.h.onDropped(dropped.length);
    // 取得中に届いた update のうち、スナップショットより新しいものを rev 順に適用する。
    const buffered = this.buffer.sort((a, b) => a.rev - b.rev);
    this.buffer = [];
    this.buffering = false;
    for (const u of buffered) {
      const r = this.model.applyUpdate(u);
      if (r === "gap") return this.beginSync(); // 欠番: 取り直す
    }
    const first = !this.everLive;
    this.everLive = true;
    this.attempt = 0;
    this.emitDoc(first ? "load" : "sync");
    this.setPhase("live");
    this.lastSentSelection = null;
    this.sendPresence();
    this.settleFirst();
  }

  private emitDoc(cause: "load" | "sync" | "remote" | "local"): void {
    const { doc, dropped } = this.model.rebuild();
    this.h.onDoc({ doc, rev: this.model.serverRev, cause });
    if (dropped.length > 0) this.h.onConflictDropped(dropped.length);
  }

  private sendPresence(): void {
    if (this.phase !== "live") return;
    const key = JSON.stringify(this.selection);
    if (key === this.lastSentSelection) return;
    this.lastSentSelection = key;
    this.deps.transport.send(JSON.stringify({ type: "presence", selectedTaskIds: this.selection } satisfies ClientMessage));
  }

  /** テスト・デバッグ用: 現在のサーバー確定 doc。 */
  get serverDoc(): GanttDocument | null {
    return this.model.serverDoc;
  }
}
