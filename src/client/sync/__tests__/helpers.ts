import { executeCommand, type CommandContext } from "../../../shared/engine";
import type { GanttDocument } from "../../../shared/model/types";
import type { ClientMessage, PresenceUser, ServerMessage } from "../../../shared/protocol";
import { SyncSession } from "../session";
import type { LoadOutcome, SessionHandlers, Transport, TransportHandlers } from "../types";

/** サーバー (DO) を模したもの: doc と rev を持ち、コマンドを engine で適用して update / ack / reject を配信する。 */
export class FakeServer {
  doc: GanttDocument;
  rev = 0;
  transports: FakeTransport[] = [];
  /** true の間は接続が失敗する。 */
  down = false;
  snapshotOutcome: "ok" | "notfound" | "unauthorized" | "error" = "ok";
  snapshotGate: Promise<void> | null = null;
  snapshotCalls = 0;
  helloPresence: PresenceUser[] = [];
  constructor(doc: GanttDocument) {
    const { view: _v, ...rest } = doc;
    this.doc = rest as GanttDocument;
  }
  transport(): FakeTransport {
    const t = new FakeTransport(this);
    this.transports.push(t);
    return t;
  }
  get live(): FakeTransport | undefined {
    return this.transports.at(-1);
  }
  async loadSnapshot(): Promise<LoadOutcome> {
    this.snapshotCalls++;
    // 要求時点の状態を返す (ゲートで待っている間にサーバーが進んでも、古い結果が返る = 実際の HTTP と同じ)
    const outcome = this.snapshotOutcome;
    const snap = { id: "S1", name: "x", rev: this.rev, doc: structuredClone(this.doc), updatedAt: 0, updatedBy: { name: "", email: "" } };
    if (this.snapshotGate) await this.snapshotGate;
    if (outcome !== "ok") {
      return outcome === "error" ? { kind: "error", message: "x" } : { kind: outcome };
    }
    return { kind: "ok", snapshot: snap };
  }
  /** 他のユーザーの操作 (または自分以外の接続からのコマンド) を適用して全員へ配信する。 */
  external(command: Parameters<typeof executeCommand>[1], by = { userId: "u2", name: "他の人" }): number {
    const r = executeCommand(this.doc, command, { today: "2023-05-22", defaultTaskName: "n", defaultCategoryName: "c", defaultMilestoneName: "m", newId: () => crypto.randomUUID() });
    if (!r.ok) throw new Error("external command failed: " + r.code);
    this.doc = r.doc;
    this.rev++;
    for (const t of this.transports) t.deliver({ type: "update", rev: this.rev, patches: r.patches, by });
    return this.rev;
  }
  handle(from: FakeTransport, msg: ClientMessage): void {
    if (msg.type !== "command") return;
    const ctx = msg.context as { today: string; ids: string[]; defaultTaskName: string; defaultCategoryName: string };
    const ids = [...ctx.ids];
    const c: CommandContext = { today: ctx.today, defaultTaskName: ctx.defaultTaskName, defaultCategoryName: ctx.defaultCategoryName, defaultMilestoneName: "m", newId: () => ids.shift()! };
    const r = executeCommand(this.doc, msg.command as Parameters<typeof executeCommand>[1], c);
    if (!r.ok) {
      from.deliver({ type: "reject", reqId: msg.reqId, reason: "command", error: "command_rejected", code: r.code });
      return;
    }
    if (r.patches.length === 0) {
      from.deliver({ type: "ack", reqId: msg.reqId, rev: this.rev });
      return;
    }
    this.doc = r.doc;
    this.rev++;
    for (const t of this.transports) {
      t.deliver({ type: "update", rev: this.rev, patches: r.patches, by: { userId: "u1", name: "me" }, ...(t === from ? { reqId: msg.reqId } : {}) });
    }
    from.deliver({ type: "ack", reqId: msg.reqId, rev: this.rev });
  }
}

export class FakeTransport implements Transport {
  handlers: TransportHandlers | null = null;
  open = false;
  sent: ClientMessage[] = [];
  /** true の間はサーバーからのメッセージを溜める (flush で配信)。 */
  paused = false;
  outbox: ServerMessage[] = [];
  checks = 0;
  /** true の間はクライアントからの送信をサーバーへ渡さず溜める (releaseUpstream で処理)。 */
  holdUpstream = false;
  held: ClientMessage[] = [];
  closedByClient = false;
  constructor(private server: FakeServer) {}
  connect(h: TransportHandlers): void {
    this.handlers = h;
    this.open = false;
    this.closedByClient = false;
    this.server.transports = this.server.transports.filter((t) => t !== this);
    this.server.transports.push(this);
    queueMicrotask(() => {
      if (this.handlers !== h) return;
      if (this.server.down) {
        h.onClose({ code: 1006, opened: false });
        return;
      }
      this.open = true;
      h.onMessage({
        type: "hello",
        you: { connId: "c1", userId: "u1", color: "#e6194b" },
        presence: this.server.helloPresence,
      });
    });
  }
  send(text: string): boolean {
    if (!this.open) return false;
    const msg = JSON.parse(text) as ClientMessage;
    this.sent.push(msg);
    if (this.holdUpstream) this.held.push(msg);
    else this.server.handle(this, msg);
    return true;
  }
  releaseUpstream(): void {
    this.holdUpstream = false;
    const held = this.held;
    this.held = [];
    for (const m of held) this.server.handle(this, m);
  }
  check(): void {
    this.checks++;
  }
  close(): void {
    this.open = false;
    this.closedByClient = true;
  }
  deliver(msg: ServerMessage): void {
    if (!this.open) return;
    if (this.paused) this.outbox.push(msg);
    else this.handlers?.onMessage(msg);
  }
  flush(): void {
    const box = this.outbox;
    this.outbox = [];
    for (const m of box) this.handlers?.onMessage(m);
  }
  /** サーバー側の切断 / ネットワーク断。 */
  drop(code = 1006): void {
    this.open = false;
    this.handlers?.onClose({ code, opened: true });
  }
}

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
export async function until(f: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !f(); i++) await tick();
  if (!f()) throw new Error("timeout");
}

/** 手動で進められるタイマー付きの SyncSession を作る。 */
export function makeSession(server: FakeServer, h: SessionHandlers) {
  const timers: Array<{ fn: () => void; ms: number; id: number; live: boolean }> = [];
  const transport = server.transport();
  const session = new SyncSession(
    {
      transport,
      loadSnapshot: () => server.loadSnapshot(),
      setTimer: (fn, ms) => {
        const t = { fn, ms, id: timers.length, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        (t as { live: boolean }).live = false;
      },
      random: () => 1,
    },
    h,
  );
  return {
    session,
    transport,
    timers,
    fire(): number | null {
      const t = timers.filter((x) => x.live).at(-1);
      if (!t) return null;
      t.live = false;
      t.fn();
      return t.ms;
    },
  };
}
