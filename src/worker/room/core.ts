import type { GanttDocument } from "../../shared/model/types";
import {
  CLOSE_BAD_MESSAGE,
  CLOSE_DELETED,
  CLOSE_TOO_LARGE,
  CLOSE_UNAUTHORIZED,
  MAX_ID_LENGTH,
  MAX_MESSAGES_PER_SECOND,
  MAX_MESSAGE_BYTES,
  MAX_SELECTED_IDS,
  PRESENCE_COLORS,
  type PresenceUser,
  type RejectReason,
  type ServerMessage,
} from "../../shared/protocol";
import { applyCommandToDoc, type ApplyFailure, type CommandContextInput } from "../schedules/apply";
import type { VersionKind } from "../schedules/versions";
import { MAX_ASSIGNEES } from "../../shared/engine";

/**
 * Durable Object (ScheduleRoom) のロジック。WebSocket と D1 を deps / RoomSocket で差し替えられるので
 * workerd なしで単体テストできる。
 *
 * - スケジュール doc への書き込みはすべてここを通る (単一の直列化点)。コマンドは mutex で 1 本ずつ処理する
 *   (webSocketMessage は await をまたいで並行に呼ばれうるため)。
 * - 順序: 現在の doc に適用 -> D1 保存 -> 成功後に配信。保存に失敗したらキャッシュを捨ててエラーを返す。
 * - 状態は (a) メモリのキャッシュ (捨てても D1 から復元できる) と (b) 各 WebSocket の attachment (ハイバネーション
 *   をまたぐ) だけ。タイマー・アラームは使わない (アイドル時に課金されない)。
 */

/** Worker (GET /api/schedules/:id/ws) が検証済みの値を載せて DO へ渡すヘッダー。クライアントの同名ヘッダーは Worker が捨てる。 */
export const ROOM_USER_HEADER = "x-room-user";

export interface RoomUserInfo {
  scheduleId: string;
  userId: string;
  email: string;
  name: string;
  picture: string | null;
  sessionId: string;
  local: boolean;
}

/** WebSocket ごとに serializeAttachment で保持する情報 (16KB 未満)。 */
export interface Attachment {
  scheduleId: string;
  connId: string;
  userId: string;
  email: string;
  name: string;
  picture: string | null;
  /** セッション ID (Cookie 値の SHA-256)。権限再判定でログアウト・期限切れを検出する。 */
  sessionId: string;
  /** 接続時の hostname が localhost 系か (開発用ログインの再判定に使う)。 */
  local: boolean;
  /** 最後に権限を確認した時刻 (ms)。 */
  checkedAt: number;
  color: string;
  selectedTaskIds: string[];
}

export interface RoomSocket {
  readonly att: Attachment;
  setAtt(patch: Partial<Attachment>): void;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface RoomDeps {
  /** D1 から現在の doc と rev。無い・削除済みは null。 */
  loadDoc(scheduleId: string): Promise<{ doc: GanttDocument; rev: number } | null>;
  loadRev(scheduleId: string): Promise<number | null>;
  /** rev が expectedRev のときだけ保存 (rev+1)。違えば "conflict"。 */
  saveDoc(
    scheduleId: string,
    expectedRev: number,
    userId: string,
    json: string,
    name: string,
    now: number,
  ): Promise<"ok" | "conflict">;
  /** 現在の doc を写したバージョンを作る (D1 上で INSERT..SELECT)。スケジュールが無ければ null。 */
  createVersion(
    scheduleId: string,
    v: { name: string; kind: "manual" | "auto"; userId: string; now: number },
  ): Promise<{ id: string; created: boolean } | null>;
  /** 復元対象のバージョン (名前と doc の JSON)。無ければ null。 */
  loadVersion(scheduleId: string, versionId: string): Promise<{ name: string; doc: string } | null>;
  /** rev が expectedRev のときだけ、現在 doc を自動バージョンに保存して json で置き換える (1 バッチ)。 */
  restoreDoc(p: {
    scheduleId: string;
    expectedRev: number;
    userId: string;
    json: string;
    name: string;
    now: number;
    autoName: string;
  }): Promise<"ok" | "conflict">;
  /** 最後にバージョン復元で進めた rev (DO のストレージ。無ければ 0)。ハイバネーションで消えない。 */
  loadResetRev(): Promise<number>;
  saveResetRev(rev: number): Promise<void>;
  /** ids のうち users 表に無いもの (setAssignees の実在確認)。 */
  missingUsers(ids: string[]): Promise<string[]>;
  /** 接続の権限を再判定する (ユーザー・セッション・許可)。許可されなければ false。 */
  recheck(att: Attachment): Promise<boolean>;
  now(): number;
}

/** 権限の再確認間隔。 */
export const RECHECK_MS = 60_000;
const MAX_SAVE_ATTEMPTS = 3;

const REASON_BY_FAILURE: Record<ApplyFailure["error"], RejectReason> = {
  invalid_command: "bad_request",
  command_rejected: "command",
  invalid_document: "document",
  too_large: "too_large",
};

/** setAssignees の userIds (形が正しいときだけ)。それ以外は null。 */
function assigneeIdsOf(command: unknown): string[] | null {
  if (command === null || typeof command !== "object") return null;
  const c = command as { type?: unknown; userIds?: unknown };
  if (c.type !== "setAssignees" || !Array.isArray(c.userIds)) return null;
  if (c.userIds.length > MAX_ASSIGNEES * 2) return null;
  return c.userIds.every((u) => typeof u === "string" && u.length > 0 && u.length <= 64) ? (c.userIds as string[]) : null;
}

export interface VersionActor {
  userId: string;
  name: string;
}
export type CreateVersionResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; status: 404; error: "not_found" };
export type RestoreResult =
  | { ok: true; changed: boolean; rev: number }
  | { ok: false; status: 404; error: "not_found" }
  | { ok: false; status: 409; error: "conflict" }
  | ApplyFailure;

/** 「<label> 2026-11-12 14:03」(日本時間)。 */
export function autoVersionName(label: string, nowMs: number): string {
  const d = new Date(nowMs + 9 * 3600_000).toISOString(); // JST = UTC+9
  return `${label} ${d.slice(0, 10)} ${d.slice(11, 16)}`;
}

export class RoomCore {
  private cache: { doc: GanttDocument; rev: number } | null = null;
  /** 最後に復元で進めた rev (null = 未読み込み)。 */
  private resetRevMem: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** 接続ごとの受信レート (メモリのみ。ハイバネーションで消えてよい)。 */
  private rate = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly deps: RoomDeps,
    private readonly sockets: () => RoomSocket[],
  ) {}

  /** テスト用。 */
  get cachedRev(): number | null {
    return this.cache?.rev ?? null;
  }

  /** 1 件ずつ順番に実行する。前の処理が失敗しても次は動く。 */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---- 接続 ----

  /** 新しい接続の色。使われていない色を優先し、全部使われていれば一番少ない色。 */
  pickColor(existing: readonly Attachment[]): string {
    const count = new Map<string, number>(PRESENCE_COLORS.map((c) => [c, 0]));
    for (const a of existing) count.set(a.color, (count.get(a.color) ?? 0) + 1);
    let best: string = PRESENCE_COLORS[0];
    for (const c of PRESENCE_COLORS) if ((count.get(c) ?? 0) < (count.get(best) ?? 0)) best = c;
    return best;
  }

  /**
   * accept 済みの接続に hello を送り、全員へ新しいプレゼンスを配信する。
   * hello に rev は載せない (クライアントは HTTP で取得した doc の rev を使うので、D1 を読む必要がない)。
   * スケジュールの存在は Worker が接続前に確認済み。接続直後に削除された場合は、次のコマンドで検出される。
   */
  async onConnect(sock: RoomSocket): Promise<void> {
    const a = sock.att;
    this.sendTo(sock, {
      type: "hello",
      you: { connId: a.connId, userId: a.userId, color: a.color },
      presence: this.presence(),
    });
    this.broadcastPresence();
  }

  onClose(connId: string): void {
    this.rate.delete(connId);
    this.broadcastPresence(connId);
  }

  // ---- 受信 ----

  async onMessage(sock: RoomSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") {
      sock.close(CLOSE_BAD_MESSAGE, "binary not supported");
      return;
    }
    // バイト数で判定する (UTF-16 の length が小さくても UTF-8 では 3 倍になりうる)。
    if (data.length > MAX_MESSAGE_BYTES || (data.length * 3 > MAX_MESSAGE_BYTES && new TextEncoder().encode(data).length > MAX_MESSAGE_BYTES)) {
      sock.close(CLOSE_TOO_LARGE, "message too large");
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      sock.close(CLOSE_BAD_MESSAGE, "invalid json");
      return;
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      sock.close(CLOSE_BAD_MESSAGE, "invalid message");
      return;
    }
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case "command": {
        if (typeof m.reqId !== "number" || !Number.isSafeInteger(m.reqId) || m.reqId < 0) {
          sock.close(CLOSE_BAD_MESSAGE, "invalid reqId");
          return;
        }
        const reqId = m.reqId;
        const baseRev = typeof m.baseRev === "number" && Number.isSafeInteger(m.baseRev) && m.baseRev >= 0 ? m.baseRev : null;
        await this.serial(() => this.handleCommand(sock, reqId, baseRev, m.command, m.context));
        return;
      }
      case "presence": {
        const ids = m.selectedTaskIds;
        if (
          !Array.isArray(ids) ||
          ids.length > MAX_SELECTED_IDS ||
          !ids.every((x) => typeof x === "string" && x.length <= MAX_ID_LENGTH)
        ) {
          sock.close(CLOSE_BAD_MESSAGE, "invalid presence");
          return;
        }
        const next = ids as string[];
        const cur = sock.att.selectedTaskIds;
        if (next.length === cur.length && next.every((x, i) => x === cur[i])) return; // 変化なし
        // 簡易レート制限は presence だけ。command を黙って捨てると送信側の未確定が残り続ける。
        if (this.overRate(sock.att.connId)) return;
        if ((await this.ensureAllowed(sock)) !== "ok") return;
        sock.setAtt({ selectedTaskIds: next });
        this.broadcastPresence();
        return;
      }
      default:
        // 未知の type は無視 (将来の拡張で古い接続を落とさない)。
        return;
    }
  }

  private overRate(connId: string): boolean {
    const now = this.deps.now();
    const r = this.rate.get(connId);
    if (!r || now - r.windowStart >= 1000) {
      this.rate.set(connId, { windowStart: now, count: 1 });
      return false;
    }
    r.count++;
    return r.count > MAX_MESSAGES_PER_SECOND;
  }

  // ---- 外部からの通知 ----

  /** スケジュールが論理削除された: 全接続へ通知して切断し、キャッシュを捨てる。 */
  async onDeleted(): Promise<void> {
    await this.serial(async () => this.disconnectAllDeleted());
  }

  /** serial の中から呼ぶ版 (onDeleted を serial 内から呼ぶと自分自身を待って止まる)。 */
  private disconnectAllDeleted(): void {
    this.cache = null;
    for (const s of this.sockets()) {
      this.sendTo(s, { type: "deleted" });
      s.close(CLOSE_DELETED, "deleted");
    }
  }

  /**
   * タスクのコメントが変わった (HTTP API からの通知)。接続中の全員へ comments を配信する。本文は載せない。
   * 状態を持たず、タイマーも使わない。権限の確認が古い接続には、送る前に再判定する (presence と同じ)。
   */
  onCommentsChanged(taskId: string): void {
    if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > MAX_ID_LENGTH) return;
    const msg: ServerMessage = { type: "comments", taskId };
    for (const s of this.sockets()) {
      if (!this.isStale(s)) {
        this.sendTo(s, msg);
        continue;
      }
      void this.ensureAllowed(s)
        .then((r) => {
          if (r === "ok") this.sendTo(s, msg);
        })
        .catch(() => undefined);
    }
  }

  private async getResetRev(): Promise<number> {
    if (this.resetRevMem === null) this.resetRevMem = await this.deps.loadResetRev();
    return this.resetRevMem;
  }
  private async setResetRev(rev: number): Promise<void> {
    this.resetRevMem = rev; // 保存に失敗してもメモリ上は有効 (次に DO が退避されるまで)
    try {
      await this.deps.saveResetRev(rev);
    } catch (e) {
      console.error("room: resetRev save failed", e);
    }
  }

  // ---- バージョン (doc を読み書きするので、コマンドと同じ直列化の中で行う) ----

  /** 現在の確定 doc をバージョンとして保存する。直前のコマンドの保存が終わってから、次のコマンドの前に写す。 */
  createVersion(actor: VersionActor, scheduleId: string, input: { name: string; kind: VersionKind }): Promise<CreateVersionResult> {
    return this.serial(async () => {
      const r = await this.deps.createVersion(scheduleId, { ...input, userId: actor.userId, now: this.deps.now() });
      return r === null ? { ok: false, status: 404, error: "not_found" } : { ok: true, ...r };
    });
  }

  /**
   * バージョンへ戻す: 現在の doc を自動バージョンに保存し、対象の doc を検証して現在の doc にし (rev+1)、
   * 全接続へ reset を配信する。対象が不正なら何も変えない。内容が現在と同一なら何もしない (changed:false)。
   */
  restoreVersion(actor: VersionActor, scheduleId: string, versionId: string): Promise<RestoreResult> {
    return this.serial(async () => {
      for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
        const ver = await this.deps.loadVersion(scheduleId, versionId);
        if (ver === null) return { ok: false, status: 404, error: "not_found" };
        let state = this.cache;
        if (state === null) {
          state = await this.deps.loadDoc(scheduleId);
          if (state === null) return { ok: false, status: 404, error: "not_found" };
          this.cache = state;
        }
        let target: unknown;
        try {
          target = JSON.parse(ver.doc);
        } catch {
          return { ok: false, status: 422, error: "invalid_document", kind: "schema", issues: [] };
        }
        const now = this.deps.now();
        const res = applyCommandToDoc(state.doc, { type: "replaceDocument", doc: target }, undefined, now);
        if (!res.ok) return res;
        if (!res.changed) return { ok: true, changed: false, rev: state.rev };

        const restored = { by: { userId: actor.userId, name: actor.name }, versionName: ver.name };
        let outcome: "ok" | "conflict";
        try {
          outcome = await this.deps.restoreDoc({
            scheduleId,
            expectedRev: state.rev,
            userId: actor.userId,
            json: res.json,
            name: res.name,
            now,
            autoName: autoVersionName("復元前の自動保存", now),
          });
        } catch (e) {
          // 例外でも commit 済みだったかもしれない (応答だけ失われた): D1 の rev を確かめる。
          this.cache = null;
          let cur: number | null = null;
          try {
            cur = await this.deps.loadRev(scheduleId);
          } catch {
            /* 確かめられない: 元の例外を伝える */
          }
          if (cur !== null && cur > state.rev) {
            await this.setResetRev(cur);
            if (cur === state.rev + 1) {
              this.cache = { doc: res.doc, rev: cur };
              this.broadcast({ type: "reset", rev: cur, restored });
              return { ok: true, changed: true, rev: cur };
            }
            this.broadcast({ type: "reset", rev: cur });
          }
          throw e;
        }
        if (outcome === "conflict") {
          this.cache = null;
          continue;
        }
        const rev = state.rev + 1;
        this.cache = { doc: res.doc, rev };
        await this.setResetRev(rev);
        this.broadcast({ type: "reset", rev, restored });
        return { ok: true, changed: true, rev };
      }
      this.cache = null;
      return { ok: false, status: 409, error: "conflict" };
    });
  }

  // ---- コマンド ----

  private async handleCommand(sock: RoomSocket, reqId: number, baseRev: number | null, command: unknown, context: unknown): Promise<void> {
    const scheduleId = sock.att.scheduleId;
    const reject = (reason: RejectReason, error: string, extra?: { code?: string; params?: Record<string, string | number> }) =>
      this.sendTo(sock, { type: "reject", reqId, reason, error, ...(extra?.code ? { code: extra.code } : {}), ...(extra?.params ? { params: extra.params } : {}) });

    const allowed = await this.ensureAllowed(sock);
    if (allowed === "denied") return; // 4401 で切断済み
    if (allowed === "error") {
      // 判定できなかった (D1 の一時エラー)。接続は維持するが、このコマンドは適用せず、応答する (クライアントの pending が残らないように)。
      reject("server_error", "recheck_failed");
      return;
    }

    // 復元より前の状態を見て作られたコマンドは適用しない (復元後の doc に古い操作が紛れ込むのを防ぐ)。
    // 送信側は reset で pending を捨てて取り直すので、拒否は黙って無視される。
    if (baseRev === null) {
      reject("bad_request", "baseRev required");
      return;
    }
    let resetRev: number;
    try {
      resetRev = await this.getResetRev();
    } catch (e) {
      console.error("room: resetRev load failed", e);
      reject("server_error", "load_failed");
      return;
    }
    if (baseRev < resetRev) {
      reject("stale", "stale_base");
      return;
    }

    const ctx =
      context !== null && typeof context === "object" && !Array.isArray(context) ? (context as CommandContextInput) : undefined;

    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
      let state = this.cache;
      if (state === null) {
        try {
          state = await this.deps.loadDoc(scheduleId);
        } catch (e) {
          console.error("room: load failed", e);
          reject("server_error", "load_failed");
          return;
        }
        if (state === null) {
          // 削除済み (論理削除の通知より先に到着した)。
          this.disconnectAllDeleted();
          return;
        }
        this.cache = state;
      }

      // setAssignees: 実在確認するのは「そのタスクの現在の担当に無い追加分」だけ (すでに未知の ID を持つタスクでも、
      // 外す・実在ユーザーを足す編集はできる)。engine は doc の中だけを見るので、サーバーが users 表で確かめる。
      // 形が不正なコマンドはここでは調べず、engine / apply の検証に任せる。
      const wanted = assigneeIdsOf(command);
      if (wanted !== null && wanted.length > 0) {
        const targetId = (command as { id?: unknown }).id;
        const target = typeof targetId === "string" ? state.doc.tasks.find((t) => t.id.toLowerCase() === targetId.toLowerCase()) : undefined;
        const have = new Set(target?.assigneeIds ?? []);
        const added = wanted.filter((u) => !have.has(u));
        if (added.length > 0) {
          let missing: string[];
          try {
            missing = await this.deps.missingUsers(added);
          } catch (e) {
            console.error("room: user check failed", e);
            reject("server_error", "user_check_failed");
            return;
          }
          if (missing.length > 0) {
            reject("command", "command_rejected", { code: "UNKNOWN_USER" });
            return;
          }
        }
      }

      const now = this.deps.now();
      const res = applyCommandToDoc(state.doc, command, ctx, now);
      if (!res.ok) {
        const { status: _s, ok: _ok, error, ...rest } = res;
        const extra: { code?: string; params?: Record<string, string | number> } = {};
        if ("code" in rest) {
          extra.code = rest.code;
          if (rest.params) extra.params = rest.params;
        }
        reject(REASON_BY_FAILURE[res.error], error, extra);
        return;
      }
      if (!res.changed) {
        this.sendTo(sock, { type: "ack", reqId, rev: state.rev });
        return;
      }

      let outcome: "ok" | "conflict";
      try {
        outcome = await this.deps.saveDoc(scheduleId, state.rev, sock.att.userId, res.json, res.name, now);
      } catch (e) {
        // D1 への書き込みが例外になったが、実際には書けていた可能性がある (応答だけ失われた場合)。
        // その場合 D1 は rev+1 に進んでいるのに誰にも配信していないので、キャッシュを捨てて D1 から読み直す。
        // 次のコマンドが成功すると配信される rev は D1 の rev+1 で、クライアントから見ると 1 つ欠番になり、
        // 全員が doc を取り直す (結果的に収束する)。書けていなければ何も起きない。
        console.error("room: save failed", e);
        this.cache = null;
        reject("server_error", "save_failed");
        return;
      }
      if (outcome === "conflict") {
        // D1 が自分の持つ rev と違う (外部の書き換え・削除): キャッシュを捨てて読み直し、やり直す。
        this.cache = null;
        continue;
      }

      const rev = state.rev + 1;
      this.cache = { doc: res.doc, rev };
      const by = { userId: sock.att.userId, name: sock.att.name };
      // 送信者には reqId 付きの update (これで未確定コマンドを置き換える) を送り、続けて ack。他の接続には reqId なし。
      // 権限の確認が古い (RECHECK_MS 超) 接続には、送る前に再判定する (不許可なら送らず切断)。
      const stale: RoomSocket[] = [];
      for (const s of this.sockets()) {
        const isSender = s.att.connId === sock.att.connId;
        if (!isSender && this.isStale(s)) {
          stale.push(s);
          continue;
        }
        this.sendTo(s, { type: "update", rev, patches: res.patches, by, ...(isSender ? { reqId } : {}) });
      }
      this.sendTo(sock, { type: "ack", reqId, rev });
      // 再判定は D1 を引くので、他の接続への配信・ack を遅らせないよう後で行う。mutex は保持したまま
      // 待つので、次のコマンドの update がこの update を追い越すことはない。
      await Promise.all(
        stale.map(async (s) => {
          if ((await this.ensureAllowed(s)) === "ok") this.sendTo(s, { type: "update", rev, patches: res.patches, by });
        }),
      );
      return;
    }
    // 競合が続いた (D1 が外部から書き換え続けられている)。
    this.cache = null;
    reject("server_error", "conflict");
  }

  // ---- 権限 ----

  private isStale(sock: RoomSocket): boolean {
    return this.deps.now() - sock.att.checkedAt >= RECHECK_MS;
  }

  /**
   * 最終確認から RECHECK_MS 以上経っていれば再判定する。
   * 不許可なら 4401 で切断して "denied"。判定自体が失敗したら (D1 の一時エラー) 切断せず "error"。
   */
  private async ensureAllowed(sock: RoomSocket): Promise<"ok" | "denied" | "error"> {
    if (!this.isStale(sock)) return "ok";
    let ok: boolean;
    try {
      ok = await this.deps.recheck(sock.att);
    } catch (e) {
      console.error("room: recheck failed", e);
      return "error";
    }
    if (!ok) {
      sock.close(CLOSE_UNAUTHORIZED, "unauthorized");
      this.broadcastPresence(sock.att.connId);
      return "denied";
    }
    sock.setAtt({ checkedAt: this.deps.now() });
    return "ok";
  }

  // ---- 配信 ----

  private sendTo(sock: RoomSocket, msg: ServerMessage): void {
    try {
      sock.send(JSON.stringify(msg));
    } catch {
      // 既に閉じている接続。
    }
  }

  private broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const s of this.sockets()) {
      try {
        s.send(text);
      } catch {
        /* closed */
      }
    }
  }

  /** 現在の接続一覧。excludeConnId の接続は除く (閉じつつある接続)。 */
  presence(excludeConnId?: string): PresenceUser[] {
    return this.sockets()
      .filter((s) => s.att.connId !== excludeConnId)
      .map((s) => ({
        connId: s.att.connId,
        userId: s.att.userId,
        name: s.att.name,
        picture: s.att.picture,
        color: s.att.color,
        selectedTaskIds: s.att.selectedTaskIds,
      }));
  }

  /**
   * 全員へプレゼンスを配信する。確認が古い接続には、送る前に再判定する (不許可なら送らず切断。判定が失敗したら
   * 今回は送らず接続は維持)。送る内容は送信時点の一覧で作る。
   */
  private broadcastPresence(excludeConnId?: string): void {
    for (const s of this.sockets()) {
      if (s.att.connId === excludeConnId) continue;
      if (!this.isStale(s)) {
        this.sendTo(s, { type: "presence", users: this.presence(excludeConnId) });
        continue;
      }
      void this.ensureAllowed(s)
        .then((r) => {
          if (r === "ok") this.sendTo(s, { type: "presence", users: this.presence(excludeConnId) });
        })
        .catch(() => undefined);
    }
  }
}
