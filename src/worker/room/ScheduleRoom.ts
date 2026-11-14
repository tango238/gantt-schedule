import { DurableObject } from "cloudflare:workers";
import { CLOSE_BAD_MESSAGE, PING_TEXT, PONG_TEXT } from "../../shared/protocol";
import type { Env } from "../env";
import { lookupSession } from "../auth/session";
import { missingUserIds } from "../users/repo";
import { loadDocAndRev, loadRev, saveDocAtRev } from "../schedules/repo";
import {
  createVersion,
  loadVersionDoc,
  restoreDocWithAutoVersion,
  type VersionKind,
  type VersionsDb,
} from "../schedules/versions";
import {
  RoomCore,
  ROOM_USER_HEADER,
  type Attachment,
  type CreateVersionResult,
  type RestoreResult,
  type RoomDeps,
  type RoomSocket,
  type RoomUserInfo,
  type VersionActor,
} from "./core";

const MAX_NAME = 100;
/** 最後に復元で進めた rev (ハイバネーション・退避をまたいで保持する)。 */
const RESET_REV_KEY = "resetRev";
const MAX_PICTURE = 500;

function wrap(ws: WebSocket): RoomSocket {
  return {
    get att() {
      return ws.deserializeAttachment() as Attachment;
    },
    setAtt(patch) {
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment), ...patch });
    },
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, reason),
  };
}

/**
 * スケジュール 1 個につき 1 インスタンス (idFromName(scheduleId))。WebSocket Hibernation API を使うので、
 * メッセージが無い間はメモリから退避され課金されない (タイマー・アラームは使わない)。
 */
export class ScheduleRoom extends DurableObject<Env> {
  private readonly core: RoomCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // ping/pong は DO を起こさずランタイムが自動応答する。
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));
    const vdb = env.DB as unknown as VersionsDb;
    const deps: RoomDeps = {
      loadDoc: (id) => loadDocAndRev(env.DB, id),
      loadRev: (id) => loadRev(env.DB, id),
      saveDoc: (id, rev, userId, json, name, now) => saveDocAtRev(env.DB, id, rev, userId, json, name, now),
      createVersion: (id, v) => createVersion(vdb, { scheduleId: id, ...v }),
      loadVersion: (id, versionId) => loadVersionDoc(vdb, id, versionId),
      restoreDoc: (p) => restoreDocWithAutoVersion(vdb, p),
      loadResetRev: async () => (await ctx.storage.get<number>(RESET_REV_KEY)) ?? 0,
      saveResetRev: (rev) => ctx.storage.put(RESET_REV_KEY, rev),
      missingUsers: (ids) => missingUserIds(env.DB, ids),
      recheck: async (att) => {
        const dev = att.local ? env.DEV_LOGIN_EMAIL : undefined;
        const user = await lookupSession(env, att.sessionId, dev);
        return user !== null && user.id === att.userId;
      },
      now: () => Date.now(),
    };
    this.core = new RoomCore(deps, () => this.ctx.getWebSockets().map(wrap));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    let info: RoomUserInfo;
    try {
      info = JSON.parse(decodeURIComponent(request.headers.get(ROOM_USER_HEADER) ?? "")) as RoomUserInfo;
      if (typeof info.scheduleId !== "string" || typeof info.userId !== "string" || typeof info.sessionId !== "string") throw new Error();
    } catch {
      return new Response("forbidden", { status: 403 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const existing = this.ctx.getWebSockets().map((w) => (w.deserializeAttachment() as Attachment));
    const att: Attachment = {
      scheduleId: info.scheduleId,
      connId: crypto.randomUUID(),
      userId: info.userId,
      email: String(info.email),
      name: String(info.name).slice(0, MAX_NAME),
      picture: typeof info.picture === "string" ? info.picture.slice(0, MAX_PICTURE) : null,
      sessionId: info.sessionId,
      local: info.local === true,
      checkedAt: Date.now(),
      color: this.core.pickColor(existing),
      selectedTaskIds: [],
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(att);
    // hello は 101 応答の前に積む (クライアントの onopen の後に届く)。
    await this.core.onConnect(wrap(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this.core.onMessage(wrap(ws), message);
    } catch (e) {
      console.error("room: message failed", e);
      try {
        ws.close(CLOSE_BAD_MESSAGE, "error");
      } catch {
        /* closed */
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const connId = (ws.deserializeAttachment() as Attachment | null)?.connId;
    // compatibility_date >= 2026-04-07 ではランタイムが Close に自動応答する。
    void code;
    if (connId) this.core.onClose(connId);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("room: websocket error", error);
    const connId = (ws.deserializeAttachment() as Attachment | null)?.connId;
    if (connId) this.core.onClose(connId);
  }

  // ---- Worker (HTTP ルート) から呼ぶ RPC ----

  /** スケジュールが論理削除された。 */
  async deleted(): Promise<void> {
    await this.core.onDeleted();
  }

  /** タスクのコメントが変わった (コメント API から)。接続中の全員へ配信する。ハイバネーションのまま起こされ、すぐ戻る。 */
  async commentsChanged(taskId: string): Promise<void> {
    this.core.onCommentsChanged(taskId);
  }

  /** 現在の確定 doc をバージョンとして保存する (コマンドの処理と直列化される)。kind="auto" は直前の自動と同一内容なら作らない。 */
  async createVersion(
    actor: VersionActor,
    scheduleId: string,
    input: { name: string; kind: VersionKind },
  ): Promise<CreateVersionResult> {
    return this.core.createVersion(actor, scheduleId, input);
  }

  /** バージョンへ戻す。成功すると接続中の全クライアントへ reset が配信される。 */
  async restoreVersion(actor: VersionActor, scheduleId: string, versionId: string): Promise<RestoreResult> {
    return this.core.restoreVersion(actor, scheduleId, versionId);
  }
}
