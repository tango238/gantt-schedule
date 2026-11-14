// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsSection } from "../../components/SidePanel/CommentsSection";
import { useUiStore } from "../../components/uiStore";
import { onCommentsChanged, postComment, openTaskComments, resetComments, useCommentsStore } from "../commentsStore";
import type { Comment } from "../commentsApi";
import { formatCommentTime } from "../format";

const TASK = "11111111-1111-4111-8111-111111111111";
const mkC = (id: string, mine: boolean, body: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  taskId: TASK,
  body,
  createdAt: new Date(2026, 10, 12, 9, 5).getTime(),
  updatedAt: null,
  author: { id: mine ? "me" : "other", name: mine ? "私" : "田中" },
  mine,
  ...extra,
});

let server: Comment[];
let calls: Array<{ method: string; url: string; body?: unknown }>;
let respond: (method: string, url: string, body: unknown) => Response | null;
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  server = [];
  calls = [];
  respond = () => null;
  useUiStore.setState({ toasts: [], confirm: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const custom = respond(method, url, body);
      if (custom) return custom;
      if (url.endsWith("/comment-counts")) return json(200, { counts: server.length ? { [TASK]: server.length } : {} });
      if (method === "GET") return json(200, { comments: server });
      if (method === "POST") {
        server.push(mkC("c" + (server.length + 1), true, body.body));
        return json(201, { comment: server.at(-1) });
      }
      if (method === "PATCH") {
        const id = url.split("/").pop()!;
        const c = server.find((x) => x.id === id)!;
        c.body = body.body;
        c.updatedAt = 5;
        return json(200, { comment: c });
      }
      if (method === "DELETE") {
        server = server.filter((x) => x.id !== url.split("/").pop());
        return json(200, { ok: true });
      }
      return json(404, {});
    }),
  );
  resetComments("S1");
});
afterEach(() => {
  cleanup();
  resetComments(null);
  vi.unstubAllGlobals();
});

describe("formatCommentTime", () => {
  it("ローカル時刻の YYYY/MM/DD HH:mm (ゼロ埋め)", () => {
    expect(formatCommentTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026/01/02 03:04");
    expect(formatCommentTime(new Date(2026, 10, 12, 23, 59).getTime())).toBe("2026/11/12 23:59");
  });
});

describe("commentsStore", () => {
  it("通知を受けると件数を取り直し、開いているタスクなら一覧も取り直す (大文字小文字は区別しない)", async () => {
    server = [mkC("c1", false, "a")];
    openTaskComments(TASK.toUpperCase());
    await waitFor(() => expect(useCommentsStore.getState().current?.items).toHaveLength(1));
    server.push(mkC("c2", false, "b"));
    calls = [];
    onCommentsChanged(TASK.toUpperCase());
    await waitFor(() => expect(useCommentsStore.getState().current?.items).toHaveLength(2));
    expect(calls.map((c) => c.url.split("/").slice(-1)[0])).toEqual(expect.arrayContaining(["comment-counts", "comments"]));
    expect(useCommentsStore.getState().counts).toEqual({ [TASK]: 2 });
  });
  it("開いていない別タスクの通知では一覧を取り直さない", async () => {
    openTaskComments(TASK);
    await waitFor(() => expect(useCommentsStore.getState().current?.items).toEqual([]));
    calls = [];
    onCommentsChanged("22222222-2222-4222-8222-222222222222");
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toContain("comment-counts");
  });
  it("失敗の種類を返す (上限 409 / 403 / 404 / 通信エラー)", async () => {
    respond = (m) => (m === "POST" ? json(409, { error: "comment_limit", limit: 500 }) : null);
    expect(await postComment(TASK, "x")).toBe("limit");
    respond = (m) => (m === "POST" ? json(403, { error: "forbidden" }) : null);
    expect(await postComment(TASK, "x")).toBe("forbidden");
    respond = (m) => (m === "POST" ? json(404, { error: "not_found" }) : null);
    expect(await postComment(TASK, "x")).toBe("notfound");
    respond = (m) => (m === "POST" ? json(500, {}) : null);
    expect(await postComment(TASK, "x")).toBe("failed");
  });
  it("別のスケジュールへ移ったら、遅れて届いた古い応答は反映しない", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...a: Parameters<typeof fetch>) => { await gate; return orig(...a); }));
    server = [mkC("c1", false, "old")];
    openTaskComments(TASK);
    resetComments("S2");
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(useCommentsStore.getState().current).toBeNull();
  });
});

describe("CommentsSection", () => {
  const open = async () => {
    render(
      <fieldset disabled={false}>
        <CommentsSection taskId={TASK} />
      </fieldset>,
    );
    await screen.findByTestId("comments");
  };

  it("作成者名・ローカル日時・編集済みを表示し、本文は HTML として解釈せず改行を保つ", async () => {
    server = [mkC("c1", false, "<img src=x onerror=alert(1)>\n2行目"), mkC("c2", true, "編集した", { updatedAt: 9 })];
    await open();
    const items = await screen.findAllByTestId("comment");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByTestId("comment-author").textContent).toBe("田中");
    expect(within(items[0]!).getByTestId("comment-time").textContent).toBe("2026/11/12 09:05");
    expect(within(items[0]!).queryByTestId("comment-edited")).toBeNull();
    expect(within(items[1]!).getByTestId("comment-edited").textContent).toBe("編集済み");
    const body = within(items[0]!).getByTestId("comment-body");
    expect(body.textContent).toBe("<img src=x onerror=alert(1)>\n2行目");
    expect(body.querySelector("img")).toBeNull();
  });

  it("編集・削除は自分のコメントにだけ出る", async () => {
    server = [mkC("c1", false, "他人"), mkC("c2", true, "自分")];
    await open();
    const items = await screen.findAllByTestId("comment");
    expect(within(items[0]!).queryByTestId("comment-edit")).toBeNull();
    expect(within(items[0]!).queryByTestId("comment-delete")).toBeNull();
    expect(within(items[1]!).getByTestId("comment-edit")).toBeTruthy();
    expect(within(items[1]!).getByTestId("comment-delete")).toBeTruthy();
  });

  it("送信: ボタンと Ctrl/Cmd+Enter。空白だけは送れない。送信後は入力が空になり一覧に出る", async () => {
    await open();
    const input = screen.getByTestId("comment-input") as HTMLTextAreaElement;
    const send = screen.getByTestId("comment-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  こんにちは\n改行  " } });
    expect(send.disabled).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" }); // 修飾キー無しでは送らない
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ body: "  こんにちは\n改行  " }); // 整形はサーバー
    await waitFor(() => expect(input.value).toBe(""));
    await waitFor(() => expect(screen.getAllByTestId("comment")).toHaveLength(1));
    fireEvent.change(input, { target: { value: "二つ目" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
  });

  it("日本語入力の変換確定の Enter では送信しない", async () => {
    await open();
    const input = screen.getByTestId("comment-input");
    fireEvent.change(input, { target: { value: "かな" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("4000 文字を超えると送れない", async () => {
    await open();
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "あ".repeat(4001) } });
    expect((screen.getByTestId("comment-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("編集: 保存すると PATCH し、編集済みになる。キャンセルでは送らない", async () => {
    server = [mkC("c1", true, "元")];
    await open();
    fireEvent.click(await screen.findByTestId("comment-edit"));
    const ed = screen.getByTestId("comment-edit-input") as HTMLTextAreaElement;
    expect(ed.value).toBe("元");
    fireEvent.change(ed, { target: { value: "直した" } });
    fireEvent.click(screen.getByTestId("comment-edit-save"));
    await waitFor(() => expect(screen.getByTestId("comment-body").textContent).toBe("直した"));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ body: "直した" });
    await screen.findByTestId("comment-edited");
    fireEvent.click(screen.getByTestId("comment-edit"));
    fireEvent.keyDown(screen.getByTestId("comment-edit-input"), { key: "Escape" });
    expect(screen.queryByTestId("comment-edit-input")).toBeNull();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("削除は確認ダイアログ (window.confirm ではない) を経てから DELETE する", async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
    server = [mkC("c1", true, "消す")];
    await open();
    fireEvent.click(await screen.findByTestId("comment-delete"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const req = useUiStore.getState().confirm;
    expect(req).not.toBeNull();
    act(() => req!.onConfirm());
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryAllByTestId("comment")).toHaveLength(0));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("読み取り専用 (切断中・バージョン閲覧中) は親の fieldset disabled で投稿・編集・削除ボタンが無効になる", async () => {
    server = [mkC("c1", true, "自分")];
    render(
      <fieldset disabled>
        <CommentsSection taskId={TASK} />
      </fieldset>,
    );
    const del = (await screen.findByTestId("comment-delete")) as HTMLButtonElement;
    // jsdom は fieldset[disabled] 配下のフォームコントロールを :disabled として扱う
    expect(del.matches(":disabled")).toBe(true);
    expect((screen.getByTestId("comment-edit") as HTMLButtonElement).matches(":disabled")).toBe(true);
    expect((screen.getByTestId("comment-send") as HTMLButtonElement).matches(":disabled")).toBe(true);
    expect((screen.getByTestId("comment-input") as HTMLTextAreaElement).matches(":disabled")).toBe(true);
  });

  it("サーバーの拒否 (403) はトーストで知らせる", async () => {
    await open();
    respond = (m) => (m === "POST" ? json(403, { error: "forbidden" }) : null);
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
  });
});
