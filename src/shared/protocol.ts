import type { Patch } from "immer";

/**
 * 同時編集の WebSocket メッセージ (JSON テキスト)。クライアント (src/client/sync) と
 * Durable Object (src/worker/room) の両方が import する。
 *
 * 接続: GET /api/schedules/:id/ws (Upgrade)。
 * 1. サーバー -> hello {you, presence}。doc も rev も載せない: クライアントは hello を受けたら GET /api/schedules/:id で
 *    doc と rev を取得し、その rev より新しい update だけを適用する (欠番があれば取り直す)。
 * 2. クライアント -> command {reqId, command, context}。サーバーは到着順に 1 本ずつ適用する。
 *    成功 (変更あり): 全員へ update (送信者へは reqId 付き) の後、送信者へ ack。
 *    変更なし: 送信者へ ack のみ。失敗: 送信者へ reject。
 * 3. presence は双方向 (クライアントは自分の選択、サーバーは全接続の一覧)。
 * 4. (コメントの変更は HTTP API が Durable Object へ RPC で通知し、DO が全接続へ comments を配信する。クライアントからは送れない)
 * 5. ping/pong はテキスト "ping" / "pong" (setWebSocketAutoResponse。DO を起こさない)。
 */

/** DO が使う WebSocket の close code (4000 番台はアプリ用)。 */
export const CLOSE_BAD_MESSAGE = 4400;
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_DELETED = 4404;
export const CLOSE_TOO_LARGE = 1009;

export const PING_TEXT = "ping";
export const PONG_TEXT = "pong";

/**
 * 1 メッセージの上限 (UTF-8 バイト数)。通常のコマンドは数百バイト〜数 KB。
 * 大きな doc の置換 (replaceDocument / 段階 4 の復元 / 段階 5 の AI 適用) は WebSocket では送らず、HTTP 経由にすること。
 */
export const MAX_MESSAGE_BYTES = 256 * 1024;
/** 1 接続あたりの受信レート上限 (1 秒あたり)。超えた分は黙って破棄する。 */
export const MAX_MESSAGES_PER_SECOND = 20;
export const MAX_SELECTED_IDS = 50;
export const MAX_ID_LENGTH = 64;

export type RejectReason = "stale" | "command" | "document" | "too_large" | "bad_request" | "server_error";

export interface PresenceUser {
  /** 接続ごとの ID (同一ユーザーの複数タブは別接続)。 */
  connId: string;
  userId: string;
  name: string;
  picture: string | null;
  /** 接続ごとの色 (#rrggbb)。 */
  color: string;
  selectedTaskIds: string[];
}

export interface UpdateBy {
  userId: string;
  name: string;
}

export type ClientMessage =
  /**
   * baseRev は送信時点でクライアントが持っていた確定 rev (必須)。バージョン復元より前の rev なら、
   * 復元後の doc に古い操作が適用されないよう reason "stale" で拒否される (クライアントは reset で既に捨てている)。
   */
  | { type: "command"; reqId: number; baseRev: number; command: unknown; context?: unknown }
  | { type: "presence"; selectedTaskIds: string[] };

export type ServerMessage =
  | { type: "hello"; you: { connId: string; userId: string; color: string }; presence: PresenceUser[] }
  | { type: "update"; rev: number; patches: Patch[]; by: UpdateBy; reqId?: number }
  | { type: "ack"; reqId: number; rev: number }
  | {
      type: "reject";
      reqId: number;
      reason: RejectReason;
      error: string;
      code?: string;
      params?: Record<string, string | number>;
    }
  | { type: "presence"; users: PresenceUser[] }
  /**
   * doc が別経路で置き換わった。クライアントは doc を取り直す。
   * restored があればバージョン復元によるもの (巨大な patches を配信しない代わりに reset で取り直させる)。
   */
  | { type: "reset"; rev: number; restored?: { by: UpdateBy; versionName: string } }
  /** スケジュールが削除された。この後サーバーが 4404 で切断する。 */
  | { type: "deleted" }
  /**
   * そのタスクのコメントが作成・編集・削除された。本文は載せない (クライアントは件数と、開いていれば一覧を HTTP で取り直す)。
   * 古いクライアントは未知の type を無視する (src/client/sync/session.ts の switch に default が無い)。
   */
  | { type: "comments"; taskId: string };

export const PRESENCE_COLORS = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#008080",
  "#c2185b",
  "#795548",
] as const;
