import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../shared/engine";
import type { GanttDocument } from "../../shared/model/types";
import type { ServerMessage } from "../../shared/protocol";
import { stripView } from "../schedules/validate";
import { RECHECK_MS, RoomCore, type Attachment, type RoomDeps, type RoomSocket } from "./core";

const NOW0 = Date.UTC(2026, 10, 11, 12, 0, 0);

class FakeSocket implements RoomSocket {
  sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  att: Attachment;
  constructor(public room: Room, id: string, user = id) {
    this.att = {
      scheduleId: "S1",
      connId: id,
      userId: user,
      email: `${user}@example.com`,
      name: user,
      picture: null,
      sessionId: `sess-${id}`,
      local: false,
      checkedAt: room.t,
      color: room.core.pickColor(room.socks.map((s) => s.att)),
      selectedTaskIds: [],
    };
  }
  setAtt(p: Partial<Attachment>) {
    this.att = { ...this.att, ...p };
  }
  send(text: string) {
    if (this.closed) throw new Error("closed");
    this.sent.push(JSON.parse(text));
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.room.socks = this.room.socks.filter((s) => s !== this);
  }
  of<T extends ServerMessage["type"]>(type: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

class Room {
  t = NOW0;
  socks: FakeSocket[] = [];
  d1: { doc: GanttDocument; rev: number; by: string; name: string } | null;
  loads = 0;
  saves = 0;
  failSave = false;
  conflictOnce = false;
  allowed = true;
  rechecks = 0;
  /** users 表に居るユーザー ID。 */
  knownUsers = new Set(["alice", "bob"]);
  failUserCheck = false;
  /** バージョン表 (D1 の schedule_versions の代わり)。 */
  versions: { id: string; name: string; kind: string; doc: string; rev: number; by: string }[] = [];
  /** 設定すると saveDoc がこの Promise を待つ (コマンドの保存が途中の状態を作る)。 */
  saveGate: Promise<void> | null = null;
  restoreFails = false;
  /** 復元のコミット後に例外を返す (応答だけ失われた D1 を模す)。 */
  restoreCommitsThenThrows = false;
  /** DO のストレージ (resetRev)。RoomCore を作り直しても残る。 */
  storedResetRev = 0;
  core: RoomCore;
  constructor() {
    const doc = stripView(createEmptyDocument({ projectName: "P" })) as GanttDocument;
    this.d1 = { doc, rev: 3, by: "none", name: "P" };
    const deps: RoomDeps = {
      loadDoc: async () => {
        this.loads++;
        return this.d1 ? { doc: structuredClone(this.d1.doc), rev: this.d1.rev } : null;
      },
      loadRev: async () => this.d1?.rev ?? null,
      saveDoc: async (_id, expected, userId, json, name) => {
        this.saves++;
        if (this.saveGate) await this.saveGate;
        if (this.failSave) throw new Error("d1 down");
        if (this.conflictOnce) {
          this.conflictOnce = false;
          this.d1!.rev += 5; // 外部から書き換えられた
          return "conflict";
        }
        if (!this.d1 || this.d1.rev !== expected) return "conflict";
        this.d1 = { doc: JSON.parse(json), rev: expected + 1, by: userId, name };
        return "ok";
      },
      createVersion: async (_id, v) => {
        if (!this.d1) return null;
        const id = `V${this.versions.length + 1}`;
        this.versions.push({ id, name: v.name, kind: v.kind, doc: JSON.stringify(this.d1.doc), rev: this.d1.rev, by: v.userId });
        return { id, created: true };
      },
      loadVersion: async (_id, vid) => {
        const v = this.versions.find((x) => x.id === vid);
        return v ? { name: v.name, doc: v.doc } : null;
      },
      restoreDoc: async (p) => {
        if (this.restoreFails) throw new Error("d1 down");
        if (!this.d1 || this.d1.rev !== p.expectedRev) return "conflict";
        this.versions.push({ id: `V${this.versions.length + 1}`, name: p.autoName, kind: "auto", doc: JSON.stringify(this.d1.doc), rev: this.d1.rev, by: p.userId });
        this.d1 = { doc: JSON.parse(p.json), rev: p.expectedRev + 1, by: p.userId, name: p.name };
        if (this.restoreCommitsThenThrows) throw new Error("response lost");
        return "ok";
      },
      loadResetRev: async () => this.storedResetRev,
      saveResetRev: async (rev) => {
        this.storedResetRev = rev;
      },
      missingUsers: async (ids) => {
        if (this.failUserCheck) throw new Error("d1 down");
        return ids.filter((i) => !this.knownUsers.has(i));
      },
      recheck: async () => {
        this.rechecks++;
        return this.allowed;
      },
      now: () => this.t,
    };
    this.deps = deps;
    this.core = new RoomCore(deps, () => this.socks);
  }
  deps: RoomDeps;
  async join(id: string, user = id): Promise<FakeSocket> {
    const s = new FakeSocket(this, id, user);
    this.socks.push(s);
    await this.core.onConnect(s);
    return s;
  }
  /** baseRev 省略時は「今の D1 の rev を見ているクライアント」として送る。 */
  cmd(s: FakeSocket, reqId: number, command: unknown, context?: unknown, baseRev: number | null = this.d1?.rev ?? 0) {
    return this.core.onMessage(s, JSON.stringify({ type: "command", reqId, ...(baseRev === null ? {} : { baseRev }), command, context }));
  }
}
const addTask = { type: "addTask", afterId: null };

describe("RoomCore: 接続", () => {
  it("hello に rev と自分の接続情報、プレゼンスを載せる (doc は載せない)", async () => {
    const r = new Room();
    const a = await r.join("a");
    const hello = a.of("hello")[0]!;
    expect("rev" in hello).toBe(false); // クライアントは HTTP で取得した doc の rev を使う
    expect(r.loads).toBe(0); // 接続で D1 を読まない
    expect(hello.you.connId).toBe("a");
    expect(hello.presence.map((p) => p.connId)).toEqual(["a"]);
    expect("doc" in hello).toBe(false);
  });
  it("参加で全員へプレゼンスを配信し、接続ごとに違う色になる", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    expect(a.of("presence").at(-1)!.users.map((u) => u.connId)).toEqual(["a", "b"]);
    expect(new Set(b.of("presence").at(-1)!.users.map((u) => u.color)).size).toBe(2);
  });
  it("離脱で残りの接続へプレゼンスを配信する", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    r.socks = r.socks.filter((s) => s !== b);
    r.core.onClose("b");
    expect(a.of("presence").at(-1)!.users.map((u) => u.connId)).toEqual(["a"]);
  });
});

describe("RoomCore: プレゼンス", () => {
  it("選択の変更を全員へ配信し、attachment に保持する", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    await r.core.onMessage(a, JSON.stringify({ type: "presence", selectedTaskIds: ["T1"] }));
    expect(b.of("presence").at(-1)!.users.find((u) => u.connId === "a")!.selectedTaskIds).toEqual(["T1"]);
    expect(a.att.selectedTaskIds).toEqual(["T1"]);
  });
  it("不正な presence (配列でない・多すぎる・長すぎる) は 4400 で切断", async () => {
    for (const ids of ["x", Array(51).fill("a"), ["x".repeat(65)], [1]]) {
      const r = new Room();
      const a = await r.join("a");
      await r.core.onMessage(a, JSON.stringify({ type: "presence", selectedTaskIds: ids }));
      expect(a.closed?.code).toBe(4400);
    }
  });
});

describe("RoomCore: 入力制限", () => {
  it("内容が前回と同じ presence は配信しない", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    await r.core.onMessage(a, JSON.stringify({ type: "presence", selectedTaskIds: ["T1"] }));
    const n = b.of("presence").length;
    await r.core.onMessage(a, JSON.stringify({ type: "presence", selectedTaskIds: ["T1"] }));
    expect(b.of("presence")).toHaveLength(n);
  });
  it("1 秒あたり 20 メッセージを超えた分は黙って破棄する (切断しない)。1 秒後に再開", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    for (let i = 0; i < 30; i++) await r.core.onMessage(a, JSON.stringify({ type: "presence", selectedTaskIds: ["T" + i] }));
    expect(a.closed).toBeNull();
    expect(b.of("presence").at(-1)!.users.find((u) => u.connId === "a")!.selectedTaskIds).toEqual(["T19"]);
    r.t += 1000;
    await r.core.onMessage(a, JSON.stringify({ type: "presence", selectedTaskIds: ["after"] }));
    expect(b.of("presence").at(-1)!.users.find((u) => u.connId === "a")!.selectedTaskIds).toEqual(["after"]);
  });
  it("command はレート制限で捨てない (捨てると送信側の未確定が残り続ける)", async () => {
    const r = new Room();
    const a = await r.join("a");
    await Promise.all(Array.from({ length: 40 }, (_, i) => r.cmd(a, i + 1, addTask)));
    expect(a.of("ack").length + a.of("reject").length).toBe(40);
    expect(a.of("ack")).toHaveLength(40);
  });
  it("サイズはバイト数で判定する (256KB 超は 1009、日本語は 1 文字 3 バイト)", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.core.onMessage(a, "あ".repeat(90_000)); // length 90k < 256k だが UTF-8 では 270KB
    expect(a.closed?.code).toBe(1009);
  });
});

describe("RoomCore: 入力検証", () => {
  it("JSON でない・オブジェクトでない・バイナリは 4400、未知の type は無視、巨大は 1009", async () => {
    const r = new Room();
    for (const raw of ["{", "[]", "1"]) {
      const s = await r.join("x" + raw);
      await r.core.onMessage(s, raw);
      expect(s.closed?.code).toBe(4400);
    }
    const bin = await r.join("bin");
    await r.core.onMessage(bin, new ArrayBuffer(2));
    expect(bin.closed?.code).toBe(4400);
    const unk = await r.join("unk");
    await r.core.onMessage(unk, JSON.stringify({ type: "whatever" }));
    expect(unk.closed).toBeNull();
    const big = await r.join("big");
    await r.core.onMessage(big, "x".repeat(256 * 1024 + 1));
    expect(big.closed?.code).toBe(1009);
  });
  it("reqId が不正なら 4400", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.core.onMessage(a, JSON.stringify({ type: "command", reqId: "1", baseRev: 0, command: addTask }));
    expect(a.closed?.code).toBe(4400);
  });
});

describe("RoomCore: コマンド", () => {
  it("適用 -> D1 保存 -> 配信。送信者の update には reqId、他者には無く、続いて送信者に ack", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    await r.cmd(a, 7, addTask);
    expect(r.d1!.rev).toBe(4);
    expect(r.d1!.by).toBe("a");
    expect(r.d1!.doc.tasks).toHaveLength(1);
    const ua = a.of("update")[0]!;
    const ub = b.of("update")[0]!;
    expect(ua).toMatchObject({ rev: 4, reqId: 7, by: { userId: "a", name: "a" } });
    expect("reqId" in ub).toBe(false);
    expect(ub.patches.length).toBeGreaterThan(0);
    expect(a.of("ack")).toEqual([{ type: "ack", reqId: 7, rev: 4 }]);
    expect(b.of("ack")).toHaveLength(0);
    // update が ack より先
    expect(a.sent.findIndex((m) => m.type === "update")).toBeLessThan(a.sent.findIndex((m) => m.type === "ack"));
  });
  it("配信した patches をクライアント側の doc に適用すると D1 の doc と一致する", async () => {
    const { applyPatches } = await import("immer");
    const r = new Room();
    const a = await r.join("a");
    const before = structuredClone(r.d1!.doc);
    await r.cmd(a, 1, addTask);
    await r.cmd(a, 2, { type: "setProjectInfo", name: "改名" });
    let doc = before;
    for (const u of a.of("update")) doc = applyPatches(doc, u.patches);
    expect(doc).toEqual(r.d1!.doc);
    expect(r.d1!.name).toBe("改名");
  });
  it("同時に届いたコマンドは到着順に 1 本ずつ適用され、rev が欠けず、どちらの変更も残る", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    await Promise.all([
      r.cmd(a, 1, { type: "setProjectInfo", name: "A" }),
      r.cmd(b, 1, addTask),
      r.cmd(a, 2, addTask),
    ]);
    expect(r.d1!.rev).toBe(6);
    expect(r.d1!.doc.tasks).toHaveLength(2);
    expect(r.d1!.doc.project.name).toBe("A");
    expect(a.of("update").map((u) => u.rev)).toEqual([4, 5, 6]);
    expect(r.loads).toBe(1); // キャッシュを使う
  });
  it("実質変更なしは ack のみ (rev を上げず保存しない)", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.cmd(a, 1, { type: "rescheduleAll" });
    expect(r.saves).toBe(0);
    expect(a.of("ack")).toEqual([{ type: "ack", reqId: 1, rev: 3 }]);
    expect(a.of("update")).toHaveLength(0);
  });
  it("engine が拒否したら送信者にだけ reject (code 付き)、他者には何も送らない", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    await r.cmd(a, 1, { type: "deleteTask", id: "nope" });
    expect(a.of("reject")[0]).toMatchObject({ reqId: 1, reason: "command", code: "TASK_NOT_FOUND" });
    expect(b.sent.filter((m) => m.type !== "presence" && m.type !== "hello")).toHaveLength(0);
    expect(r.saves).toBe(0);
  });
  it("不正なコマンドは bad_request", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.cmd(a, 1, { type: "nope" });
    await r.cmd(a, 2, null);
    expect(a.of("reject").map((m) => m.reason)).toEqual(["bad_request", "bad_request"]);
  });
  it("D1 の保存に失敗したら配信せず、キャッシュを捨ててエラーを返し、次は D1 から読み直す", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    await r.cmd(a, 1, addTask); // キャッシュ作成
    r.failSave = true;
    await r.cmd(a, 2, addTask);
    expect(a.of("reject")[0]).toMatchObject({ reqId: 2, reason: "server_error" });
    expect(b.of("update")).toHaveLength(1);
    expect(r.core.cachedRev).toBeNull();
    r.failSave = false;
    const loads = r.loads;
    await r.cmd(a, 3, addTask);
    expect(r.loads).toBe(loads + 1);
    expect(r.d1!.doc.tasks).toHaveLength(2);
    expect(b.of("update").map((u) => u.rev)).toEqual([4, 5]);
  });
  it("rev 競合 (外部書き換え) はキャッシュを捨てて読み直し、やり直して成功する", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.cmd(a, 1, addTask);
    r.conflictOnce = true;
    await r.cmd(a, 2, addTask);
    expect(a.of("ack").at(-1)!.rev).toBe(r.d1!.rev);
    expect(r.d1!.doc.tasks).toHaveLength(2);
  });
});

describe("RoomCore: 権限の再判定", () => {
  it("確認から 60 秒未満なら D1 に問い合わせない", async () => {
    const r = new Room();
    const a = await r.join("a");
    r.t += RECHECK_MS - 1;
    await r.cmd(a, 1, addTask);
    expect(r.rechecks).toBe(0);
  });
  it("60 秒以上経っていれば再確認し、許可なら checkedAt を更新", async () => {
    const r = new Room();
    const a = await r.join("a");
    r.t += RECHECK_MS;
    await r.cmd(a, 1, addTask);
    expect(r.rechecks).toBe(1);
    expect(a.att.checkedAt).toBe(r.t);
    await r.cmd(a, 2, addTask);
    expect(r.rechecks).toBe(1);
  });
  it("不許可 (ログアウト・失効・許可取り消し) なら 4401 で切断し、コマンドは適用しない", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    r.t += RECHECK_MS;
    b.setAtt({ checkedAt: r.t }); // b は確認済み
    r.allowed = false;
    await r.cmd(a, 1, addTask);
    expect(a.closed?.code).toBe(4401);
    expect(r.saves).toBe(0);
    expect(b.of("presence").at(-1)!.users.map((u) => u.connId)).toEqual(["b"]);
  });
  it("配信先の古い接続も非同期に再判定され、不許可なら切断される", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    r.t += RECHECK_MS;
    r.allowed = false;
    r.socks.forEach((s) => s.setAtt({})); // noop
    b.setAtt({ checkedAt: r.t }); // b は確認済み、a だけ古い
    await r.cmd(b, 1, addTask);
    await new Promise((x) => setTimeout(x, 0));
    expect(a.closed?.code).toBe(4401);
    expect(b.closed).toBeNull();
  });
  it("再判定が一時的に失敗した場合は切断せず、そのコマンドは適用せず、reject を返す (pending が残らない)", async () => {
    const r = new Room();
    const a = await r.join("a");
    r.t += RECHECK_MS;
    (r.core as unknown as { deps: RoomDeps }).deps.recheck = async () => {
      throw new Error("d1");
    };
    await r.cmd(a, 1, addTask);
    expect(a.closed).toBeNull();
    expect(r.saves).toBe(0);
    expect(a.of("reject")).toEqual([{ type: "reject", reqId: 1, reason: "server_error", error: "recheck_failed" }]);
  });
  it("presence の受信でも再判定する: 不許可なら 4401 で切断し、選択は反映しない", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    r.t += RECHECK_MS;
    b.setAtt({ checkedAt: r.t });
    r.allowed = false;
    await r.core.onMessage(a, JSON.stringify({ type: "presence", selectedTaskIds: ["T"] }));
    expect(a.closed?.code).toBe(4401);
    expect(b.of("presence").at(-1)!.users.map((u) => u.connId)).toEqual(["b"]);
  });
  it("update の配信前に、確認が古い接続を再判定する: 不許可なら update を送らず切断 (presence も同様)", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b"); // 古くなる (ログアウト済み)
    r.t += RECHECK_MS;
    a.setAtt({ checkedAt: r.t });
    r.allowed = false;
    const n = b.sent.length;
    await r.cmd(a, 1, addTask);
    expect(b.closed?.code).toBe(4401);
    expect(b.sent.slice(n).filter((m) => m.type === "update")).toHaveLength(0);
    expect(a.of("update")).toHaveLength(1);
    expect(a.of("ack")).toHaveLength(1);
  });
  it("update 配信前の再判定が許可なら、そのまま update が届く。例外なら今回は送らず接続は維持", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    r.t += RECHECK_MS;
    a.setAtt({ checkedAt: r.t });
    await r.cmd(a, 1, addTask);
    expect(b.of("update")).toHaveLength(1);
    expect(b.att.checkedAt).toBe(r.t);
    r.t += RECHECK_MS;
    a.setAtt({ checkedAt: r.t });
    (r.core as unknown as { deps: RoomDeps }).deps.recheck = async () => {
      throw new Error("d1");
    };
    await r.cmd(a, 2, addTask);
    expect(b.of("update")).toHaveLength(1);
    expect(b.closed).toBeNull();
  });
  it("プレゼンス配信前にも古い接続を再判定する", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    r.t += RECHECK_MS;
    a.setAtt({ checkedAt: r.t });
    r.allowed = false;
    await r.core.onMessage(a, JSON.stringify({ type: "presence", selectedTaskIds: ["x"] }));
    await new Promise((x) => setTimeout(x, 0));
    expect(b.closed?.code).toBe(4401);
    expect(b.of("presence").some((m) => m.users.some((u) => u.selectedTaskIds.includes("x")))).toBe(false);
  });
});

describe("RoomCore: 削除・リセット", () => {
  it("削除通知で全接続へ deleted を送って 4404 で切断し、キャッシュを捨てる", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    await r.cmd(a, 1, addTask);
    const socks = [a, b];
    await r.core.onDeleted();
    for (const s of socks) {
      expect(s.of("deleted")).toHaveLength(1);
      expect(s.closed?.code).toBe(4404);
    }
    expect(r.core.cachedRev).toBeNull();
  });
  it("削除後に届いたコマンドは D1 に無いので deleted + 切断 (保存しない)", async () => {
    const r = new Room();
    const a = await r.join("a");
    r.d1 = null;
    await r.cmd(a, 1, addTask);
    expect(a.of("deleted")).toHaveLength(1);
    expect(a.closed?.code).toBe(4404);
    expect(r.saves).toBe(0);
  });
});

describe("RoomCore: バージョン", () => {
  const actor = { userId: "a", name: "A" };
  const names = (doc: GanttDocument) => doc.tasks.map((t) => t.name);

  it("作成は D1 の確定 doc を写す。保存中のコマンドが終わってから (直列化)、次のコマンドより前に写す", async () => {
    const r = new Room();
    const a = await r.join("a");
    let release!: () => void;
    r.saveGate = new Promise<void>((res) => (release = res));
    const c1 = r.cmd(a, 1, addTask); // 保存待ちで止まる
    const v = r.core.createVersion(actor, "S1", { name: "v", kind: "manual" });
    const c2 = r.cmd(a, 2, addTask); // バージョンより後に着いたコマンド
    await new Promise((res) => setTimeout(res, 5));
    expect(r.versions).toHaveLength(0); // コマンドの保存が終わるまで写さない
    r.saveGate = null;
    release();
    await Promise.all([c1, v, c2]);
    expect(r.versions).toHaveLength(1);
    const snap = JSON.parse(r.versions[0]!.doc) as GanttDocument;
    expect(snap.tasks).toHaveLength(1); // 1 件目のコマンドだけを含み、2 件目 (後から着いた) は含まない
    expect(r.versions[0]!.rev).toBe(4);
    expect(r.d1!.doc.tasks).toHaveLength(2);
  });

  it("スケジュールが無ければ 404", async () => {
    const r = new Room();
    r.d1 = null;
    expect(await r.core.createVersion(actor, "S1", { name: "v", kind: "manual" })).toEqual({ ok: false, status: 404, error: "not_found" });
  });

  it("復元: 現在の doc を自動で保存し、対象の doc に置き換え (rev+1)、全接続へ reset を配信する", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    await r.core.createVersion(actor, "S1", { name: "古い", kind: "manual" }); // 空の doc, rev 3
    await r.cmd(a, 1, { type: "addTask", afterId: null }, { ids: ["11111111-1111-4111-8111-111111111111"] });
    expect(r.d1!.doc.tasks).toHaveLength(1);
    const rev = r.d1!.rev;
    const res = await r.core.restoreVersion({ userId: "b", name: "B" }, "S1", "V1");
    expect(res).toEqual({ ok: true, changed: true, rev: rev + 1 });
    expect(r.d1!.doc.tasks).toHaveLength(0);
    expect(r.d1!.rev).toBe(rev + 1);
    expect(r.d1!.by).toBe("b");
    const auto = r.versions.find((v) => v.kind === "auto")!;
    expect(auto.name).toMatch(/^復元前の自動保存 2026-11-11 21:00$/); // NOW0 = 12:00 UTC = 21:00 JST
    expect(names(JSON.parse(auto.doc))).toHaveLength(1); // 復元前の内容
    for (const s of [a, b]) {
      expect(s.of("reset").at(-1)).toEqual({ type: "reset", rev: rev + 1, restored: { by: { userId: "b", name: "B" }, versionName: "古い" } });
    }
    // キャッシュは復元後の doc: 続くコマンドは rev+2 で配信される
    await r.cmd(a, 2, addTask);
    expect(a.of("update").at(-1)!.rev).toBe(rev + 2);
    expect(r.loads).toBe(1); // 復元では D1 を読み直さない (キャッシュ更新)
  });

  it("復元対象が現在と同一内容なら何もしない (rev も reset も自動バージョンも無し)", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.core.createVersion(actor, "S1", { name: "v", kind: "manual" });
    const res = await r.core.restoreVersion(actor, "S1", "V1");
    expect(res).toEqual({ ok: true, changed: false, rev: 3 });
    expect(r.d1!.rev).toBe(3);
    expect(a.of("reset")).toHaveLength(0);
    expect(r.versions).toHaveLength(1);
  });

  it("対象の doc が不正なら何も変えない (自動バージョンも作らない・reset も送らない)", async () => {
    const r = new Room();
    const a = await r.join("a");
    r.versions.push({ id: "BAD", name: "bad", kind: "manual", doc: JSON.stringify({ version: 2, tasks: "x" }), rev: 1, by: "a" });
    r.versions.push({ id: "NOTJSON", name: "bad2", kind: "manual", doc: "{", rev: 1, by: "a" });
    for (const id of ["BAD", "NOTJSON"]) {
      const res = await r.core.restoreVersion(actor, "S1", id);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(422);
    }
    expect(r.d1!.rev).toBe(3);
    expect(r.versions).toHaveLength(2);
    expect(a.of("reset")).toHaveLength(0);
  });

  it("存在しない versionId・無いスケジュールは 404", async () => {
    const r = new Room();
    expect(await r.core.restoreVersion(actor, "S1", "NOPE")).toEqual({ ok: false, status: 404, error: "not_found" });
    r.versions.push({ id: "V", name: "v", kind: "manual", doc: JSON.stringify(r.d1!.doc), rev: 1, by: "a" });
    r.d1 = null;
    expect(await r.core.restoreVersion(actor, "S1", "V")).toEqual({ ok: false, status: 404, error: "not_found" });
  });

  it("D1 が外部で書き換えられていたら (conflict) 読み直してやり直す", async () => {
    const r = new Room();
    await r.join("a");
    const empty = JSON.stringify(r.d1!.doc);
    const other = structuredClone(r.d1!.doc);
    other.project.name = "別";
    r.versions.push({ id: "V", name: "v", kind: "manual", doc: JSON.stringify(other), rev: 1, by: "a" });
    await r.core.restoreVersion(actor, "S1", "V"); // キャッシュを作る (rev 3 -> 4)
    expect(r.d1!.doc.project.name).toBe("別");
    r.versions.push({ id: "V2", name: "v2", kind: "manual", doc: empty, rev: 1, by: "a" });
    r.d1!.rev += 10; // 外部の書き換え: キャッシュの rev は古い
    const res = await r.core.restoreVersion(actor, "S1", "V2");
    expect(res).toEqual({ ok: true, changed: true, rev: 15 });
    expect(r.d1!.rev).toBe(15);
    expect(r.loads).toBe(2);
  });

  it("D1 の書き込みが例外ならキャッシュを捨てて例外を伝える。次のコマンドは動く", async () => {
    const r = new Room();
    const a = await r.join("a");
    const other = structuredClone(r.d1!.doc);
    other.project.name = "別";
    r.versions.push({ id: "V", name: "v", kind: "manual", doc: JSON.stringify(other), rev: 1, by: "a" });
    r.restoreFails = true;
    await expect(r.core.restoreVersion(actor, "S1", "V")).rejects.toThrow();
    expect(r.core.cachedRev).toBeNull();
    r.restoreFails = false;
    await r.cmd(a, 1, addTask);
    expect(a.of("ack")).toHaveLength(1);
  });

  it("復元より前の baseRev のコマンドは stale で拒否し、適用しない。復元後の baseRev は通る", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.core.createVersion(actor, "S1", { name: "v", kind: "manual" });
    await r.cmd(a, 1, { type: "addTask", afterId: null }, { ids: ["11111111-1111-4111-8111-111111111111"] });
    const before = r.d1!.rev;
    await r.core.restoreVersion(actor, "S1", "V1"); // rev = before + 1
    expect(r.storedResetRev).toBe(before + 1);
    const saves = r.saves;
    await r.cmd(a, 2, { type: "addTask", afterId: null }, undefined, before); // 復元前の rev で作られた
    expect(a.of("reject").at(-1)).toMatchObject({ reqId: 2, reason: "stale" });
    expect(r.saves).toBe(saves);
    expect(r.d1!.doc.tasks).toHaveLength(0);
    await r.cmd(a, 3, { type: "addTask", afterId: null }, undefined, before + 1);
    expect(a.of("ack").at(-1)).toMatchObject({ reqId: 3 });
    expect(r.d1!.doc.tasks).toHaveLength(1);
  });

  it("resetRev は RoomCore を作り直しても (DO の退避・再起動) 保たれる", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.core.createVersion(actor, "S1", { name: "v", kind: "manual" });
    await r.cmd(a, 1, addTask);
    const before = r.d1!.rev;
    await r.core.restoreVersion(actor, "S1", "V1");
    r.core = new RoomCore(r.deps, () => r.socks); // メモリ消失
    await r.cmd(a, 2, addTask, undefined, before);
    expect(a.of("reject").at(-1)).toMatchObject({ reqId: 2, reason: "stale" });
  });

  it("baseRev の無いコマンドは bad_request で拒否する", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.cmd(a, 1, addTask, undefined, null);
    expect(a.of("reject")[0]).toMatchObject({ reqId: 1, reason: "bad_request" });
    expect(r.saves).toBe(0);
  });

  it("復元前に受け付けた (直列化で先に処理される) コマンドは適用され、復元で上書きされる", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.core.createVersion(actor, "S1", { name: "v", kind: "manual" });
    const base = r.d1!.rev;
    const c = r.cmd(a, 1, addTask, undefined, base);
    const v = r.core.restoreVersion(actor, "S1", "V1");
    await Promise.all([c, v]);
    expect(a.of("ack")).toHaveLength(1);
    expect(r.d1!.doc.tasks).toHaveLength(0); // 版の内容
  });

  it("復元の D1 batch が例外でも commit 済みなら、resetRev を進めて reset を配信し成功として返す", async () => {
    const r = new Room();
    const a = await r.join("a");
    const other = structuredClone(r.d1!.doc);
    other.project.name = "別";
    r.versions.push({ id: "V", name: "v", kind: "manual", doc: JSON.stringify(other), rev: 1, by: "a" });
    r.restoreCommitsThenThrows = true;
    const res = await r.core.restoreVersion(actor, "S1", "V");
    expect(res).toEqual({ ok: true, changed: true, rev: 4 });
    expect(r.storedResetRev).toBe(4);
    expect(a.of("reset").at(-1)).toMatchObject({ type: "reset", rev: 4 });
    expect(r.core.cachedRev).toBe(4);
  });
});

describe("RoomCore: 担当 (setAssignees) の実在確認", () => {
  const setup = async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.cmd(a, 1, addTask);
    return { r, a, taskId: r.d1!.doc.tasks[0]!.id };
  };
  it("実在するユーザーなら適用して配信する", async () => {
    const { r, a, taskId } = await setup();
    await r.cmd(a, 2, { type: "setAssignees", id: taskId, userIds: ["alice", "bob"] });
    expect(a.of("ack").map((m) => m.reqId)).toEqual([1, 2]);
    expect(r.d1!.doc.tasks[0]!.assigneeIds).toEqual(["alice", "bob"]);
  });
  it("存在しないユーザーが 1 人でも含まれれば reject (UNKNOWN_USER)。doc は変わらない", async () => {
    const { r, a, taskId } = await setup();
    const rev = r.d1!.rev;
    await r.cmd(a, 2, { type: "setAssignees", id: taskId, userIds: ["alice", "ghost"] });
    expect(a.of("reject")[0]).toMatchObject({ reqId: 2, reason: "command", code: "UNKNOWN_USER" });
    expect(r.d1!.rev).toBe(rev);
    expect(r.d1!.doc.tasks[0]!.assigneeIds).toBeUndefined();
  });
  it("空の一覧は確認なしで通る。確認が失敗したら server_error で、doc は変わらない", async () => {
    const { r, a, taskId } = await setup();
    await r.cmd(a, 2, { type: "setAssignees", id: taskId, userIds: [] });
    expect(a.of("reject")).toEqual([]);
    r.failUserCheck = true;
    await r.cmd(a, 3, { type: "setAssignees", id: taskId, userIds: ["alice"] });
    expect(a.of("reject")[0]).toMatchObject({ reqId: 3, reason: "server_error" });
  });
  it("すでに未知の ID を持つタスク: 外す・実在ユーザーを足すのは可、新しい未知の ID を足すのは拒否", async () => {
    const { r, a, taskId } = await setup();
    const doc = structuredClone(r.d1!.doc);
    doc.tasks[0]!.assigneeIds = ["ghost1", "ghost2"];
    await r.cmd(a, 2, { type: "replaceDocument", doc });
    const ids = () => r.d1!.doc.tasks[0]!.assigneeIds;
    expect(ids()).toEqual(["ghost1", "ghost2"]);
    await r.cmd(a, 3, { type: "setAssignees", id: taskId, userIds: ["ghost1"] }); // 1 つ外す
    expect(ids()).toEqual(["ghost1"]);
    await r.cmd(a, 4, { type: "setAssignees", id: taskId, userIds: ["ghost1", "alice"] }); // 実在ユーザーを足す
    expect(ids()).toEqual(["ghost1", "alice"]);
    await r.cmd(a, 5, { type: "setAssignees", id: taskId, userIds: ["ghost1", "alice", "ghost3"] }); // 新しい未知 ID
    expect(a.of("reject").map((m) => [m.reqId, m.code])).toEqual([[5, "UNKNOWN_USER"]]);
    expect(ids()).toEqual(["ghost1", "alice"]);
  });
  it("replaceDocument 内の未知の ID は弾かない", async () => {
    const { r, a } = await setup();
    const doc = structuredClone(r.d1!.doc);
    doc.tasks[0]!.assigneeIds = ["ghost"];
    await r.cmd(a, 2, { type: "replaceDocument", doc });
    expect(a.of("reject")).toEqual([]);
    expect(r.d1!.doc.tasks[0]!.assigneeIds).toEqual(["ghost"]);
  });
});

describe("RoomCore: コメント変更の配信", () => {
  it("接続中の全員へ comments {taskId} だけを配信する (本文なし・D1 を読まない・保存もしない)", async () => {
    const r = new Room();
    const a = await r.join("a");
    const b = await r.join("b");
    r.core.onCommentsChanged("11111111-2222-4333-8444-555555555555");
    for (const s of [a, b]) {
      expect(s.of("comments")).toEqual([{ type: "comments", taskId: "11111111-2222-4333-8444-555555555555" }]);
    }
    expect(r.loads).toBe(0);
    expect(r.saves).toBe(0);
  });
  it("接続が無くても何も起きない。不正な taskId は配信しない", async () => {
    const r = new Room();
    r.core.onCommentsChanged("x");
    const a = await r.join("a");
    r.core.onCommentsChanged("");
    r.core.onCommentsChanged("t".repeat(100));
    r.core.onCommentsChanged(5 as unknown as string);
    expect(a.of("comments")).toEqual([]);
  });
  it("権限の確認が古い接続は再判定してから送る (不許可なら送らず切断)", async () => {
    const r = new Room();
    const a = await r.join("a");
    r.t += RECHECK_MS + 1;
    r.allowed = false;
    r.core.onCommentsChanged("t1");
    await new Promise((res) => setTimeout(res, 0));
    expect(a.of("comments")).toEqual([]);
    expect(a.closed?.code).toBe(4401);
  });
});

describe("RoomCore: 廃止した setProgress (古いタブ)", () => {
  it("reject (bad_request) されるだけで、切断も例外も doc の変更も起きない", async () => {
    const r = new Room();
    const a = await r.join("a");
    await r.cmd(a, 1, addTask);
    const rev = r.d1!.rev;
    await r.cmd(a, 2, { type: "setProgress", id: r.d1!.doc.tasks[0]!.id, progress: 50 });
    expect(a.of("reject")[0]).toMatchObject({ reqId: 2, reason: "bad_request" });
    expect(a.closed).toBeNull();
    expect(r.d1!.rev).toBe(rev);
    // その後のコマンドは通常どおり
    await r.cmd(a, 3, addTask);
    expect(a.of("ack").map((m) => m.reqId)).toEqual([1, 3]);
  });
});
