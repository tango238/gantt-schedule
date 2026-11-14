import type { Command } from "../../shared/engine";
import type { GanttDocument } from "../../shared/model/types";
import type { PresenceUser, RejectReason, ServerMessage } from "../../shared/protocol";

export type { PresenceUser, RejectReason };

/** サーバーが正とする状態 (GET /api/schedules/:id)。doc には view を含まない。 */
export interface ScheduleSnapshot {
  id: string;
  name: string;
  rev: number;
  doc: GanttDocument;
  updatedAt: number;
  updatedBy: { name: string; email: string };
  /** ログイン中のユーザーのお気に入りか (doc・WebSocket には載らない)。 */
  favorite?: boolean;
}

export type LoadOutcome =
  | { kind: "ok"; snapshot: ScheduleSnapshot }
  | { kind: "notfound" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

/** サーバーが実行コンテキストとして採用する値 (楽観的適用と同じ結果にするため)。 */
export interface CommandContextInput {
  today: string;
  /** ローカル適用で生成した ID (生成順)。 */
  ids: string[];
  defaultTaskName: string;
  defaultCategoryName: string;
  defaultMilestoneName: string;
}

/** 送信済み・送信待ちで、まだサーバーの update に含まれていないコマンド。 */
export interface PendingCommand {
  reqId: number;
  command: Command;
  context: CommandContextInput;
  /** ack で受け取った rev。serverRev がこれに届くまで残す (通常は update が先に届くので使われない)。 */
  ackedRev?: number;
}

/**
 * 接続の段階。
 * - connecting: 初回の接続・読み込み中
 * - live: 同期済み。編集できる
 * - reconnecting: 切断された。読み取り専用で再接続を試みている
 * - resyncing: 接続は生きているが doc を取り直している (欠番・reset)。読み取り専用
 * - notfound / deleted / unauthorized / error: 終了状態
 */
export type SyncPhase =
  | "connecting"
  | "live"
  | "reconnecting"
  | "resyncing"
  | "notfound"
  | "deleted"
  | "unauthorized"
  | "error";

/** WebSocket 1 本分の入出力。Session が世代管理する。 */
export interface TransportHandlers {
  onMessage(msg: ServerMessage): void;
  /** 切断 (サーバーからの close、エラー、ハートビート切れ)。opened = 一度でも open したか。 */
  onClose(info: { code: number; opened: boolean }): void;
}

export interface Transport {
  /** 新しい接続を開く (前の接続は閉じる)。 */
  connect(h: TransportHandlers): void;
  /** 送信。送れなければ false。 */
  send(text: string): boolean;
  /** 生きているか確認する (ping を送り、応答が無ければ onClose)。 */
  check(): void;
  close(): void;
}

export interface SessionHandlers {
  /** 表示すべき doc (サーバー確定 + 未確定コマンド。view なし)。 */
  onDoc(r: { doc: GanttDocument; rev: number; cause: "load" | "sync" | "remote" | "local" }): void;
  onStatus(r: { phase: SyncPhase; pending: number }): void;
  onPresence(r: { users: PresenceUser[]; selfConnId: string | null }): void;
  /** 未確定コマンドを破棄した (切断・再取得)。 */
  onDropped(count: number): void;
  /** サーバーがコマンドを拒否した。 */
  onRejected(r: { reason: RejectReason; code?: string; params?: Record<string, string | number> }): void;
  /** 他のユーザーの変更が自分の未確定コマンドと衝突して、コマンドがローカルで適用できなくなった。 */
  onConflictDropped(count: number): void;
  onUnauthorized(): void;
  /** タスクのコメントが変わった (本文は載らない。件数と開いている一覧を取り直す)。 */
  onCommentsChanged?(taskId: string): void;
  /** バージョン復元で doc が置き換わった (reset に載る)。自分が行った復元もここに届く。selfUserId は hello で知らされた自分の userId。 */
  onRestored?(r: { by: { userId: string; name: string }; versionName: string; selfUserId: string | null }): void;
}
