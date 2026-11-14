// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { doc as mkDoc, seq, task } from "../../../shared/engine/__tests__/fixtures";
import type { GanttDocument } from "../../../shared/model/types";
import { useUiStore } from "../../components/uiStore";
import { markSelfRestore, setCommandContextOverride, setSessionFactory, useAppStore } from "../../store/appStore";
import { FakeServer, makeSession, until } from "./helpers";

const st = () => useAppStore.getState();
const nameOf = (id: string, d: GanttDocument | null = st().doc) => d!.tasks.find((t) => t.id === id)!.name;
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
const withoutView = (d: GanttDocument): GanttDocument => {
  const { view: _v, ...rest } = d;
  return rest as GanttDocument;
};

let server: FakeServer;
let h: ReturnType<typeof makeSession>;

const base = () =>
  mkDoc([task({ id: "A", start: "2023-05-22", end: "2023-05-23" }), task({ id: "B", start: "2023-05-24", end: "2023-05-25" })]);

/** 過去のバージョン: A の名前が違う。 */
const oldVersionDoc = (): GanttDocument => {
  const d = structuredClone(withoutView(base()));
  d.tasks.find((t) => t.id === "A")!.name = "古い A";
  return d;
};
const enter = () => st().enterViewing({ id: "V1", name: "v1", kind: "manual", createdAt: 1, doc: oldVersionDoc() });

beforeEach(async () => {
  localStorage.clear();
  useUiStore.setState({ toasts: [], confirm: null });
  setCommandContextOverride({ today: "2023-05-22", newId: seq("N"), defaultTaskName: "新しいタスク", defaultCategoryName: "新しいカテゴリ" });
  useAppStore.setState({ doc: null, scheduleId: null });
  server = new FakeServer(base());
  setSessionFactory((_id, handlers) => {
    h = makeSession(server, handlers);
    return h.session;
  });
  await st().openSchedule("S1");
});

describe("バージョン表示 (読み取り専用)", () => {
  it("表示中は doc がバージョンの内容になり、readOnly。dispatch は拒否され、サーバーへ何も送らない", () => {
    enter();
    expect(nameOf("A")).toBe("古い A");
    expect(st().viewing?.versionId).toBe("V1");
    expect(st().readOnly).toBe(true);
    const before = h.transport.sent.length;
    const r = st().dispatch({ type: "setName", id: "A", name: "x" });
    expect(r).toEqual({ ok: false, code: "READ_ONLY" });
    expect(nameOf("A")).toBe("古い A");
    expect(h.transport.sent.length).toBe(before);
    expect(st().pending).toBe(0);
  });

  it("表示中に他者の update が届いても閲覧 doc は変わらず、戻ると最新になる", async () => {
    enter();
    const viewDoc = st().doc;
    server.external({ type: "setName", id: "B", name: "他者の B" });
    expect(st().doc).toBe(viewDoc); // 参照も内容も変わらない
    expect(nameOf("B")).toBe("B"); // 閲覧中は版の内容 (元の名前)
    expect(st().rev).toBe(1); // 最新 rev は追従
    st().exitViewing();
    expect(st().viewing).toBeNull();
    expect(nameOf("B")).toBe("他者の B");
    expect(nameOf("A")).toBe("A");
    expect(st().readOnly).toBe(false);
    expect(st().rev).toBe(1);
  });

  it("表示中に reset (他者がバージョン復元) が来ても閲覧 doc は変わらず、戻ると復元後の内容になる", async () => {
    enter();
    const viewDoc = st().doc;
    const restored = structuredClone(server.doc);
    restored.tasks.find((t) => t.id === "B")!.name = "復元後 B";
    server.doc = restored;
    server.rev = 7;
    h.transport.deliver({ type: "reset", rev: 7, restored: { by: { userId: "u2", name: "花子" }, versionName: "週次" } });
    await until(() => st().rev === 7 && st().syncPhase === "live");
    expect(st().doc).toBe(viewDoc);
    expect(toasts()).toContain("花子さんがバージョン『週次』に戻しました");
    st().exitViewing();
    expect(nameOf("B")).toBe("復元後 B");
    expect(st().rev).toBe(7);
  });

  it("表示中に切断・再接続しても閲覧 doc は変わらず、再接続後も読み取り専用のまま", async () => {
    enter();
    h.transport.drop();
    expect(st().syncPhase).toBe("reconnecting");
    expect(st().viewing).not.toBeNull();
    h.fire();
    await until(() => st().syncPhase === "live");
    expect(st().readOnly).toBe(true); // まだ閲覧中
    expect(nameOf("A")).toBe("古い A");
    st().exitViewing();
    expect(st().readOnly).toBe(false);
  });

  it("戻る前に未確定だったコマンドも、戻ると反映されている", async () => {
    h.transport.holdUpstream = true;
    st().dispatch({ type: "setName", id: "B", name: "編集中" });
    enter();
    h.transport.releaseUpstream();
    await until(() => st().pending === 0);
    expect(nameOf("B")).toBe("B"); // 閲覧中は版の内容
    st().exitViewing();
    expect(nameOf("B")).toBe("編集中");
  });

  it("バージョンを表示中に別のバージョンを表示しても、戻り先は現在のスケジュール", () => {
    enter();
    st().enterViewing({ id: "V2", name: "v2", kind: "auto", createdAt: 2, doc: withoutView(base()) });
    expect(st().viewing?.versionId).toBe("V2");
    st().exitViewing();
    expect(nameOf("A")).toBe("A");
    expect(nameOf("B")).toBe("B");
  });

  it("画面を閉じたら viewing は消える", async () => {
    enter();
    st().closeSchedule();
    expect(st().viewing).toBeNull();
    await st().openSchedule("S1");
    expect(st().viewing).toBeNull();
  });
});

describe("折りたたみ・ズーム (view) の扱い", () => {
  it("表示中の view の変更は保存されず、戻ると表示前の view に戻る", async () => {
    const live = mkDoc([task({ id: "P", start: "2023-05-22", end: "2023-05-23" }), task({ id: "C", parentId: "P", start: "2023-05-22", end: "2023-05-23" } as never)]);
    server = new FakeServer(live);
    await st().openSchedule("S1");
    st().toggleCollapsed("P");
    const stored = () => localStorage.getItem(Object.keys(localStorage)[0]!);
    const savedBefore = stored();
    expect(st().doc!.view!.collapsedTaskIds).toContain("P");
    st().enterViewing({ id: "V", name: "v", kind: "manual", createdAt: 1, doc: withoutView(mkDoc([task({ id: "X", start: "2023-05-22", end: "2023-05-23" })])) });
    st().setZoom("week");
    expect(st().doc!.view!.zoom).toBe("week");
    expect(stored()).toBe(savedBefore); // 表示中の変更は localStorage に書かない
    st().exitViewing();
    expect(st().doc!.view!.collapsedTaskIds).toContain("P");
    expect(st().doc!.view!.zoom).toBe("day");
    expect(stored()).toBe(savedBefore);
  });
});

describe("復元と stale / 通知 / 読み取り専用", () => {
  it("コマンドには送信時点の確定 rev が baseRev として載る", () => {
    server.external({ type: "setName", id: "B", name: "x" });
    st().dispatch({ type: "setName", id: "A", name: "y" });
    const msg = h.transport.sent.find((m) => m.type === "command")!;
    expect((msg as { baseRev: number }).baseRev).toBe(1);
  });

  it("stale の reject は pending を外すだけで、トーストを出さない", () => {
    h.transport.holdUpstream = true;
    st().dispatch({ type: "setName", id: "A", name: "y" });
    const reqId = (h.transport.sent.find((m) => m.type === "command") as { reqId: number }).reqId;
    h.transport.deliver({ type: "reject", reqId, reason: "stale", error: "stale_base" });
    expect(st().pending).toBe(0);
    expect(nameOf("A")).toBe("A");
    expect(toasts()).toEqual([]);
  });

  it("同じユーザーの別タブの復元には「戻しました」を、他ユーザーには「○○さんが」を出す。自分の復元中は出さない", async () => {
    // hello の you.userId は FakeServer では "u1"
    h.transport.deliver({ type: "reset", rev: 5, restored: { by: { userId: "u1", name: "自分" }, versionName: "週次" } });
    expect(toasts()).toContain("バージョン『週次』に戻しました");
    useUiStore.setState({ toasts: [] });
    h.transport.deliver({ type: "reset", rev: 6, restored: { by: { userId: "u2", name: "花子" }, versionName: "週次" } });
    expect(toasts()).toContain("花子さんがバージョン『週次』に戻しました");
    useUiStore.setState({ toasts: [] });
    markSelfRestore(true);
    h.transport.deliver({ type: "reset", rev: 7, restored: { by: { userId: "u1", name: "自分" }, versionName: "週次" } });
    markSelfRestore(false);
    expect(toasts()).toEqual([]);
  });
});
