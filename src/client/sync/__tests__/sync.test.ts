// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommand } from "../../../shared/engine";
import { doc as mkDoc, seq, task } from "../../../shared/engine/__tests__/fixtures";
import type { GanttDocument } from "../../../shared/model/types";
import { useUiStore } from "../../components/uiStore";
import { setCommandContextOverride, setSessionFactory, useAppStore } from "../../store/appStore";
import { FakeServer, makeSession, tick, until } from "./helpers";

const st = () => useAppStore.getState();
const nameOf = (id: string, d: GanttDocument | null = st().doc) => d!.tasks.find((t) => t.id === id)!.name;
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

const commands = () => h.transport.sent.filter((m): m is Extract<typeof m, { type: "command" }> => m.type === "command");

let server: FakeServer;
let h: ReturnType<typeof makeSession>;

function install(s: FakeServer): void {
  server = s;
  setSessionFactory((_id, handlers) => {
    h = makeSession(server, handlers);
    return h.session;
  });
}
async function open(doc: GanttDocument): Promise<void> {
  install(new FakeServer(doc));
  await st().openSchedule("S1");
}

const base = () =>
  mkDoc([task({ id: "A", start: "2023-05-22", end: "2023-05-23" }), task({ id: "B", start: "2023-05-24", end: "2023-05-25" })]);

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ toasts: [], confirm: null });
  setCommandContextOverride({ today: "2023-05-22", newId: seq("N"), defaultTaskName: "新しいタスク", defaultCategoryName: "新しいカテゴリ", defaultMilestoneName: "m" });
  useAppStore.setState({ doc: null, scheduleId: null });
});

describe("楽観的更新とコマンド送信", () => {
  it("ローカルに即反映し、サーバーへ送り、確定後に saved になる", async () => {
    await open(base());
    expect(st().loadStatus).toBe("ready");
    expect(st().readOnly).toBe(false);
    h.transport.holdUpstream = true;
    st().dispatch({ type: "setName", id: "A", name: "新名称" });
    expect(nameOf("A")).toBe("新名称"); // 送信完了前に反映済み
    expect(st().saveStatus).toBe("saving");
    h.transport.releaseUpstream();
    expect(st().saveStatus).toBe("saved");
    expect(st().rev).toBe(1);
    expect(nameOf("A", server.doc)).toBe("新名称");
  });

  it("応答を待たずに全て送り、送信順にサーバーへ届き、全て確定する", async () => {
    await open(base());
    h.transport.holdUpstream = true;
    st().dispatch({ type: "setName", id: "A", name: "1" });
    st().dispatch({ type: "setName", id: "A", name: "2" });
    st().dispatch({ type: "setName", id: "A", name: "3" });
    expect(commands().map((m) => (m.command as { name: string }).name)).toEqual(["1", "2", "3"]);
    expect(st().pending).toBe(3);
    expect(nameOf("A")).toBe("3");
    h.transport.releaseUpstream();
    expect(st().pending).toBe(0);
    expect(st().saveStatus).toBe("saved");
    expect(nameOf("A")).toBe("3");
    expect(st().rev).toBe(3);
  });

  it("実質変更のないコマンドと view の変更は送らない", async () => {
    await open(base());
    st().dispatch({ type: "rescheduleAll" });
    st().setZoom("month");
    st().toggleCollapsed("A");
    await tick();
    expect(commands()).toHaveLength(0);
    expect(st().saveStatus).toBe("idle");
  });

  it("addTask: ローカルで生成した ID をサーバーも採用し、選択が保たれる。自分の update で二重にならない", async () => {
    await open(base());
    st().dispatch({ type: "addTask", afterId: "A" });
    const localId = st().selectedId!;
    expect((commands()[0]!.context as { ids: string[] }).ids).toEqual([localId]);
    expect(server.doc.tasks.some((t) => t.id === localId)).toBe(true);
    expect(st().doc!.tasks).toHaveLength(3);
    expect(st().selectedId).toBe(localId);
  });

  it("確定後の doc が楽観的な doc と同じなら参照を変えない", async () => {
    await open(base());
    h.transport.holdUpstream = true;
    st().dispatch({ type: "setName", id: "A", name: "x" });
    const optimistic = st().doc;
    h.transport.releaseUpstream();
    expect(st().doc).toBe(optimistic);
  });

  it("view は他者の update が来ても保たれる", async () => {
    await open(base());
    st().setZoom("week");
    server.external({ type: "setProjectInfo", name: "N" });
    expect(st().doc!.project.name).toBe("N");
    expect(st().doc!.view?.zoom).toBe("week");
  });
});

describe("他のユーザーの変更", () => {
  it("他者の update が反映される (再読込なし)", async () => {
    await open(base());
    server.external({ type: "setName", id: "B", name: "theirs" });
    expect(nameOf("B")).toBe("theirs");
    expect(st().rev).toBe(1);
  });

  it("未確定の自分の操作は、他者の update が先に届いても巻き戻らない。確定後も二重にならない", async () => {
    await open(base());
    h.transport.holdUpstream = true;
    st().dispatch({ type: "setName", id: "A", name: "mine" });
    st().dispatch({ type: "addTask", afterId: "A" });
    server.external({ type: "setName", id: "B", name: "theirs" }); // 自分のコマンドより先にサーバーへ
    expect(nameOf("A")).toBe("mine");
    expect(nameOf("B")).toBe("theirs");
    expect(st().doc!.tasks).toHaveLength(3);
    expect(st().pending).toBe(2);
    h.transport.releaseUpstream();
    expect(st().pending).toBe(0);
    expect(st().doc!.tasks).toHaveLength(3);
    expect(st().doc!.tasks.map((t) => t.name)).toEqual(server.doc.tasks.map((t) => t.name));
    expect(st().rev).toBe(server.rev);
  });

  it("他者の変更で自分の未確定コマンドが適用できなくなったら、そのコマンドだけ捨てて知らせる", async () => {
    await open(base());
    h.transport.holdUpstream = true;
    st().dispatch({ type: "setName", id: "A", name: "mine" });
    st().dispatch({ type: "setName", id: "B", name: "keep" });
    server.external({ type: "deleteTask", id: "A" });
    expect(st().doc!.tasks.map((x) => x.id)).toEqual(["B"]);
    expect(nameOf("B")).toBe("keep");
    expect(st().pending).toBe(1);
    expect(toasts().some((m) => m.includes("反映できませんでした"))).toBe(true);
    h.transport.releaseUpstream(); // サーバーも A のコマンドを拒否し、B のコマンドを適用する
    await until(() => st().pending === 0);
    expect(server.doc.tasks.map((x) => x.id)).toEqual(["B"]);
    expect(nameOf("B", server.doc)).toBe("keep");
    expect(st().doc!.tasks.map((x) => x.name)).toEqual(server.doc.tasks.map((x) => x.name));
  });

  it("ドラッグ中の preview は他者の update で消されない", async () => {
    await open(base());
    const preview = st().doc!;
    st().setPreview(preview);
    server.external({ type: "setName", id: "B", name: "theirs" });
    expect(st().preview).toBe(preview);
  });

  it("自分と他者の update が交互に届いても欠番にならない", async () => {
    await open(base());
    st().dispatch({ type: "setName", id: "A", name: "a1" });
    server.external({ type: "setName", id: "B", name: "b1" });
    st().dispatch({ type: "setName", id: "A", name: "a2" });
    expect(server.rev).toBe(3);
    expect(st().rev).toBe(3);
    expect(st().doc!.tasks.map((t) => t.name)).toEqual(server.doc.tasks.map((t) => t.name));
    expect(h.session.phase).toBe("live");
  });
});

describe("欠番・初期同期の競合", () => {
  it("rev が飛んだら doc を取り直し、その間は読み取り専用", async () => {
    await open(base());
    server.external({ type: "setName", id: "B", name: "b1" });
    let release!: () => void;
    server.snapshotGate = new Promise<void>((r) => (release = r));
    h.transport.deliver({ type: "update", rev: 5, patches: [], by: { userId: "u2", name: "x" } });
    expect(st().syncPhase).toBe("resyncing");
    expect(st().readOnly).toBe(true);
    release();
    server.snapshotGate = null;
    await until(() => st().syncPhase === "live");
    expect(nameOf("B")).toBe("b1");
    expect(st().readOnly).toBe(false);
  });

  it("reset メッセージ (バージョン復元など) でも取り直す", async () => {
    await open(base());
    server.doc = { ...server.doc, project: { ...server.doc.project, name: "復元後" } };
    server.rev = 10;
    h.transport.deliver({ type: "reset", rev: 10 });
    await until(() => st().syncPhase === "live" && st().rev === 10);
    expect(st().doc!.project.name).toBe("復元後");
  });

  it("hello 後のスナップショット取得中に届いた update は、スナップショットより新しいものだけ適用される", async () => {
    install(new FakeServer(base()));
    let release!: () => void;
    server.snapshotGate = new Promise<void>((r) => (release = r));
    const opening = st().openSchedule("S1");
    await tick();
    await tick();
    // 取得中 (取得結果は rev 1 の状態) に rev 1, 2, 3 の update が届く
    server.external({ type: "setName", id: "A", name: "a1" }); // rev 1
    const snapDoc = structuredClone(server.doc);
    server.external({ type: "setName", id: "B", name: "b2" }); // rev 2
    server.external({ type: "setProjectInfo", name: "P3" }); // rev 3
    const full = server.doc;
    server.doc = snapDoc;
    server.rev = 1;
    release();
    await opening;
    expect(st().rev).toBe(3);
    expect(nameOf("A")).toBe("a1");
    expect(nameOf("B")).toBe("b2");
    expect(st().doc!.project.name).toBe("P3");
    void full;
  });
});

describe("拒否", () => {
  it("サーバーが拒否したら、そのコマンドを外して表示を戻し、トーストを出す", async () => {
    await open(base());
    server.doc = { ...server.doc, tasks: server.doc.tasks.filter((t) => t.id !== "A") }; // サーバーだけ A を持たない
    st().dispatch({ type: "setName", id: "A", name: "ローカルだけ" });
    expect(st().pending).toBe(0);
    expect(st().doc!.tasks.some((t) => t.name === "ローカルだけ")).toBe(false);
    expect(toasts().length).toBeGreaterThan(0);
  });
});

describe("切断と再接続", () => {
  it("切断すると読み取り専用 + 再接続中になり、未確定コマンドを破棄して知らせ、発行は全て止まる", async () => {
    await open(base());
    h.transport.holdUpstream = true;
    st().dispatch({ type: "setName", id: "A", name: "未保存" });
    h.transport.drop();
    expect(st().readOnly).toBe(true);
    expect(st().syncPhase).toBe("reconnecting");
    expect(st().saveStatus).toBe("reconnecting");
    expect(nameOf("A")).not.toBe("未保存");
    expect(st().pending).toBe(0);
    expect(toasts().some((m) => m.includes("1 件"))).toBe(true);
    expect(st().dispatch({ type: "setName", id: "A", name: "x" })).toEqual({ ok: false, code: "READ_ONLY" });
    st().setEditing({ taskId: "A", field: "name" });
    expect(st().editing).toBeNull();
  });

  it("バックオフで再接続し、成功したら最新 doc で置き換えて編集可能に戻る", async () => {
    await open(base());
    h.transport.drop();
    server.down = true;
    server.external({ type: "setName", id: "B", name: "切断中の他者の変更" });
    expect(h.fire()).toBe(1000); // 1 回目の再接続 (失敗)
    await until(() => h.timers.filter((t) => t.live).length === 1);
    expect(st().syncPhase).toBe("reconnecting");
    expect(h.fire()).toBe(2000); // 2 回目も失敗
    await until(() => h.timers.filter((t) => t.live).length === 1);
    server.down = false;
    h.fire(); // 3 回目で成功
    await until(() => st().syncPhase === "live");
    expect(st().readOnly).toBe(false);
    expect(nameOf("B")).toBe("切断中の他者の変更");
    expect(st().saveStatus).toBe("saved");
    expect(st().dispatch({ type: "setName", id: "A", name: "再開" }).ok).toBe(true);
    await until(() => st().pending === 0);
    expect(nameOf("A", server.doc)).toBe("再開");
  });

  it("再接続の間隔は 15 秒を上限にする", async () => {
    await open(base());
    server.down = true;
    h.transport.drop();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      delays.push(h.fire()!);
      await until(() => h.timers.filter((t) => t.live).length === 1);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it("nudge (タブ復帰): live なら生存確認、再接続待ちなら待たずに再接続する", async () => {
    await open(base());
    h.session.nudge();
    expect(h.transport.checks).toBe(1);
    h.transport.drop();
    h.session.nudge();
    await until(() => st().syncPhase === "live");
  });

  it("goOffline (offline イベント) で即座に読み取り専用になる", async () => {
    await open(base());
    h.session.goOffline();
    expect(st().readOnly).toBe(true);
    expect(st().syncPhase).toBe("reconnecting");
  });
});

describe("終了状態", () => {
  it("削除通知で deleted にし、再接続しない", async () => {
    await open(base());
    h.transport.deliver({ type: "deleted" });
    expect(st().loadStatus).toBe("deleted");
    expect(st().readOnly).toBe(true);
    expect(h.timers.filter((t) => t.live)).toHaveLength(0);
  });

  it("close code 4404 は削除、4401 は未認証 (再接続しない)", async () => {
    await open(base());
    h.transport.drop(4404);
    expect(st().loadStatus).toBe("deleted");
    await open(base());
    h.transport.drop(4401);
    expect(st().syncPhase).toBe("unauthorized");
    expect(h.timers.filter((t) => t.live)).toHaveLength(0);
  });

  it("初回の接続失敗は HTTP で確かめる: 404 は notfound", async () => {
    const s = new FakeServer(base());
    s.down = true;
    s.snapshotOutcome = "notfound";
    install(s);
    await st().openSchedule("S1");
    expect(st().loadStatus).toBe("notfound");
    expect(st().doc).toBeNull();
  });

  it("初回の接続失敗で HTTP も通らなければ error (再試行ボタン用)", async () => {
    const s = new FakeServer(base());
    s.down = true;
    s.snapshotOutcome = "error";
    install(s);
    await st().openSchedule("S1");
    expect(st().loadStatus).toBe("error");
  });

  it("画面を離れたら接続を閉じ、以降のイベントでストアを触らない", async () => {
    await open(base());
    st().closeSchedule();
    expect(h.transport.closedByClient).toBe(true);
    server.external({ type: "setName", id: "A", name: "x" });
    expect(st().doc).toBeNull();
  });
});

describe("プレゼンス", () => {
  it("hello と presence メッセージで一覧が更新され、自分の接続 ID が分かる", async () => {
    const s = new FakeServer(base());
    s.helloPresence = [{ connId: "c1", userId: "u1", name: "me", picture: null, color: "#e6194b", selectedTaskIds: [] }];
    install(s);
    await st().openSchedule("S1");
    expect(st().selfConnId).toBe("c1");
    expect(st().presence).toHaveLength(1);
    h.transport.deliver({
      type: "presence",
      users: [
        { connId: "c1", userId: "u1", name: "me", picture: null, color: "#e6194b", selectedTaskIds: [] },
        { connId: "c2", userId: "u2", name: "you", picture: null, color: "#3cb44b", selectedTaskIds: ["A"] },
      ],
    });
    expect(st().presence.map((p) => p.name)).toEqual(["me", "you"]);
  });

  it("選択が変わったら (デバウンス後に 1 回) presence を送り、同じ内容は再送しない", async () => {
    await open(base());
    st().select("A");
    st().select("B");
    await new Promise((r) => setTimeout(r, 200));
    const pres = h.transport.sent.filter((m) => m.type === "presence");
    expect(pres.at(-1)).toEqual({ type: "presence", selectedTaskIds: ["B"] });
    const n = pres.length;
    st().select("B");
    await new Promise((r) => setTimeout(r, 200));
    expect(h.transport.sent.filter((m) => m.type === "presence")).toHaveLength(n);
  });
});

describe("再接続の失敗理由 (live だった接続)", () => {
  it("オフライン中に削除されていたら、復帰後のハンドシェイク失敗を HTTP で確かめて deleted にする", async () => {
    await open(base());
    h.transport.drop();
    server.down = true;
    server.snapshotOutcome = "notfound";
    h.fire();
    await until(() => st().loadStatus === "deleted");
    expect(h.timers.filter((t) => t.live)).toHaveLength(0); // 再接続を続けない
  });

  it("セッションが失効していたら (401) unauthorized にして再接続しない", async () => {
    await open(base());
    h.transport.drop();
    server.down = true;
    server.snapshotOutcome = "unauthorized";
    h.fire();
    await until(() => st().syncPhase === "unauthorized");
    expect(h.timers.filter((t) => t.live)).toHaveLength(0);
  });

  it("HTTP でも通信できないだけなら、従来どおりバックオフで再接続を続ける", async () => {
    await open(base());
    h.transport.drop();
    server.down = true;
    server.snapshotOutcome = "error";
    h.fire();
    await until(() => h.timers.filter((t) => t.live).length === 1);
    expect(st().syncPhase).toBe("reconnecting");
  });
});

describe("取り直しの競合", () => {
  it("取り直し中に reset が来たら、完了後にもう一度取り直す", async () => {
    await open(base());
    let release!: () => void;
    server.snapshotGate = new Promise<void>((r) => (release = r));
    const calls = server.snapshotCalls;
    h.transport.deliver({ type: "update", rev: 5, patches: [], by: { userId: "u2", name: "x" } }); // 欠番 -> 取得 1 回目 (古い状態)
    h.transport.deliver({ type: "reset", rev: 10 });
    server.doc = { ...server.doc, project: { ...server.doc.project, name: "復元後" } };
    server.rev = 10;
    server.snapshotGate = null;
    release();
    await until(() => st().syncPhase === "live" && st().rev === 10);
    expect(st().doc!.project.name).toBe("復元後");
    expect(server.snapshotCalls).toBe(calls + 2);
  });

  it("hello より先に update が届いても、スナップショット (その update 以降を含む) と矛盾せず収束する", async () => {
    await open(base());
    h.transport.drop();
    const r1 = executeCommand(server.doc, { type: "setName", id: "B", name: "切断中" }, { today: "2023-05-22", defaultTaskName: "n", defaultCategoryName: "c", defaultMilestoneName: "m", newId: () => "x" });
    if (!r1.ok) throw new Error();
    server.doc = r1.doc;
    server.rev = 1;
    h.fire(); // 再接続開始 (hello は次の microtask)
    h.transport.handlers!.onMessage({ type: "update", rev: 1, patches: r1.patches, by: { userId: "u2", name: "x" } });
    await until(() => st().syncPhase === "live");
    expect(st().rev).toBe(1);
    expect(nameOf("B")).toBe("切断中");
  });
});

describe("dispatch の保険", () => {
  it("session が live でない (submit できない) ときはローカルにも適用せず READ_ONLY を返す", async () => {
    await open(base());
    h.session.phase = "resyncing"; // store の readOnly より先に session だけが live でなくなった状態
    const before = st().doc;
    expect(st().dispatch({ type: "setName", id: "A", name: "x" })).toEqual({ ok: false, code: "READ_ONLY" });
    expect(st().doc).toBe(before);
  });
});

describe("コメントのイベント", () => {
  it("comments {taskId} を受けるとコメントの取り直しを呼ぶ。doc・rev・接続には影響しない", async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(new Response(JSON.stringify({ counts: {}, comments: [] }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await open(base());
      await tick();
      fetchMock.mockClear();
      const rev = st().rev;
      const doc = st().doc;
      h.transport.deliver({ type: "comments", taskId: "A" });
      await tick();
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["/api/schedules/S1/comment-counts"]);
      expect(st().rev).toBe(rev);
      expect(st().doc).toBe(doc);
      expect(st().syncPhase).toBe("live");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("古いクライアントの想定: 未知の種別のメッセージ (comments を含む) は無視され、切断も例外も起きない", async () => {
    await open(base());
    const doc = st().doc;
    // コメントに対応しないハンドラ (= 古いクライアント) でも、新しいサーバーのメッセージで壊れない。
    const bare = makeSession(server, {
      onDoc() {},
      onStatus() {},
      onPresence() {},
      onDropped() {},
      onRejected() {},
      onConflictDropped() {},
      onUnauthorized() {},
    });
    bare.session.start();
    await until(() => bare.session.phase === "live");
    expect(() => {
      bare.transport.deliver({ type: "comments", taskId: "A" });
      bare.transport.deliver({ type: "future-message", x: 1 } as never);
    }).not.toThrow();
    expect(bare.session.phase).toBe("live");
    expect(bare.transport.closedByClient).toBe(false);
    bare.session.close();
    expect(st().doc).toBe(doc);
  });
});
