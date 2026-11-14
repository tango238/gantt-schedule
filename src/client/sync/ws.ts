import { PING_TEXT, PONG_TEXT, type ServerMessage } from "../../shared/protocol";
import { noteFavorite } from "../favorites/favoriteStore";
import type { LoadOutcome, ScheduleSnapshot, Transport, TransportHandlers } from "./types";

/** GET /api/schedules/:id (初期同期・再同期用。doc は WebSocket では送らない)。 */
export async function fetchSnapshot(scheduleId: string): Promise<LoadOutcome> {
  try {
    const res = await fetch(`/api/schedules/${encodeURIComponent(scheduleId)}`, { cache: "no-store" });
    if (res.status === 404) return { kind: "notfound" };
    if (res.status === 401) return { kind: "unauthorized" };
    if (!res.ok) return { kind: "error", message: `HTTP ${res.status}` };
    const snapshot = (await res.json()) as ScheduleSnapshot;
    noteFavorite(scheduleId, snapshot.favorite === true);
    return { kind: "ok", snapshot };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export const PING_INTERVAL_MS = 20_000;
export const PONG_TIMEOUT_MS = 8_000;
export const CHECK_TIMEOUT_MS = 4_000;

/**
 * ブラウザの WebSocket を使う Transport。ハートビート (テキスト "ping" -> "pong") で
 * オフライン等の死んだ接続を検出する。ping はサーバーの DO を起こさず、ランタイムが自動応答する。
 */
export function createWsTransport(scheduleId: string): Transport {
  let ws: WebSocket | null = null;
  let handlers: TransportHandlers | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (pingTimer !== null) clearInterval(pingTimer);
    if (pongTimer !== null) clearTimeout(pongTimer);
    pingTimer = pongTimer = null;
  };

  const detach = () => {
    clearTimers();
    const old = ws;
    ws = null;
    handlers = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try {
        old.close();
      } catch {
        /* already closed */
      }
    }
  };

  const ping = (timeoutMs: number) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(PING_TEXT);
    } catch {
      return;
    }
    if (pongTimer !== null) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => dead(1006), timeoutMs);
  };

  /** 接続が死んでいる: 閉じた通知を上げる。 */
  const dead = (code: number) => {
    const h = handlers;
    const opened = ws?.readyState === WebSocket.OPEN || openedFlag;
    detach();
    h?.onClose({ code, opened });
  };
  let openedFlag = false;

  return {
    connect(h) {
      detach();
      openedFlag = false;
      handlers = h;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const sock = new WebSocket(`${proto}//${location.host}/api/schedules/${encodeURIComponent(scheduleId)}/ws`);
      ws = sock;
      sock.onopen = () => {
        openedFlag = true;
        pingTimer = setInterval(() => ping(PONG_TIMEOUT_MS), PING_INTERVAL_MS);
      };
      sock.onmessage = (ev) => {
        // 何か届いたら生きている。
        if (pongTimer !== null) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
        if (typeof ev.data !== "string" || ev.data === PONG_TEXT) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data) as ServerMessage;
        } catch {
          return;
        }
        handlers?.onMessage(msg);
      };
      sock.onclose = (ev) => dead(ev.code);
      sock.onerror = () => {
        /* onclose が続く */
      };
    },
    send(text) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(text);
        return true;
      } catch {
        return false;
      }
    },
    check() {
      ping(CHECK_TIMEOUT_MS);
    },
    close() {
      detach();
    },
  };
}
