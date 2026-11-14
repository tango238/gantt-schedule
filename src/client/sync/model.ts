import { applyPatches, type Patch } from "immer";
import { executeCommand, type Command, type CommandContext } from "../../shared/engine";
import { newId } from "../../shared/model/id";
import type { GanttDocument } from "../../shared/model/types";
import type { CommandContextInput, PendingCommand } from "./types";

export type UpdateResult = "applied" | "stale" | "gap";

/**
 * クライアントの状態モデル (純粋: 通信にも UI にも依存しない)。
 *
 * - serverDoc / serverRev: サーバー確定状態。update の patches を rev 順に適用して進める。
 * - pending: 自分が送った (または送る) コマンドで、まだ update に含まれていないもの。
 * - 画面に出す doc = serverDoc に pending を順に再適用したもの (rebuild)。他者の update が届いても
 *   自分の直近の操作は巻き戻らない。再適用で engine が拒否したコマンドは捨てる。
 */
export class SyncModel {
  serverDoc: GanttDocument | null = null;
  serverRev = 0;
  pending: PendingCommand[] = [];
  private nextReqId = 1;

  get ready(): boolean {
    return this.serverDoc !== null;
  }

  /** サーバーの状態で置き換える。未確定コマンドは破棄し、破棄したものを返す。 */
  reset(doc: GanttDocument, rev: number): PendingCommand[] {
    const dropped = this.pending;
    this.pending = [];
    this.serverDoc = doc;
    this.serverRev = rev;
    return dropped;
  }

  dropPending(): PendingCommand[] {
    const dropped = this.pending;
    this.pending = [];
    return dropped;
  }

  /** 新しいコマンドを未確定列に追加する。表示 doc は呼び出し側が既に適用済み。 */
  add(command: Command, context: CommandContextInput): PendingCommand {
    const p: PendingCommand = { reqId: this.nextReqId++, command, context };
    this.pending.push(p);
    return p;
  }

  /**
   * update を適用する。rev が連続していなければ "gap" (呼び出し側は doc を取り直す)、
   * 既に反映済みなら "stale"。reqId があれば (自分のコマンドの結果) 未確定列から外す。
   */
  applyUpdate(u: { rev: number; patches: Patch[]; reqId?: number }): UpdateResult {
    if (this.serverDoc === null) return "gap";
    if (u.rev <= this.serverRev) return "stale";
    if (u.rev !== this.serverRev + 1) return "gap";
    try {
      this.serverDoc = applyPatches(this.serverDoc, u.patches);
    } catch {
      return "gap";
    }
    this.serverRev = u.rev;
    if (u.reqId !== undefined) this.removePending(u.reqId);
    this.pending = this.pending.filter((p) => p.ackedRev === undefined || p.ackedRev > this.serverRev);
    return "applied";
  }

  /** ack: そのコマンドは処理済み。update が先に届いていればここで外れる。変更なしのコマンドも外れる。 */
  ack(reqId: number, rev: number): void {
    const p = this.pending.find((x) => x.reqId === reqId);
    if (!p) return;
    if (rev <= this.serverRev) this.removePending(reqId);
    else p.ackedRev = rev;
  }

  /** reject: サーバーがそのコマンドを拒否した。 */
  reject(reqId: number): boolean {
    return this.removePending(reqId);
  }

  private removePending(reqId: number): boolean {
    const n = this.pending.length;
    this.pending = this.pending.filter((p) => p.reqId !== reqId);
    return this.pending.length !== n;
  }

  /**
   * 表示用の doc を作る: serverDoc に pending を順に再適用する。
   * engine が拒否したコマンドは pending から外し、`dropped` で返す。
   */
  rebuild(): { doc: GanttDocument; dropped: PendingCommand[] } {
    if (this.serverDoc === null) throw new Error("model not ready");
    let doc = this.serverDoc;
    const dropped: PendingCommand[] = [];
    const kept: PendingCommand[] = [];
    for (const p of this.pending) {
      const ids = [...p.context.ids];
      const ctx: CommandContext = {
        today: p.context.today,
        defaultTaskName: p.context.defaultTaskName,
        defaultCategoryName: p.context.defaultCategoryName,
        defaultMilestoneName: p.context.defaultMilestoneName,
        newId: () => ids.shift() ?? newId(),
      };
      const res = executeCommand(doc, p.command, ctx);
      if (res.ok) {
        doc = res.doc;
        kept.push(p);
      } else {
        dropped.push(p);
      }
    }
    this.pending = kept;
    return { doc, dropped };
  }
}
