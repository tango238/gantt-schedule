import { create } from "zustand";
import { idKey } from "../../shared/model/id";
import { ApiError } from "../schedulesApi";
import { createComment, deleteComment, fetchCommentCounts, fetchComments, updateComment, type Comment } from "./commentsApi";

/**
 * タスクのコメント (スケジュール本体の doc とは別。HTTP で取得し、変更は WebSocket の comments イベントで知る)。
 * counts: タスク ID (小文字) -> 件数。current: 右ペインで開いているタスクの一覧。
 */
interface CommentsState {
  scheduleId: string | null;
  counts: Record<string, number>;
  current: { taskId: string; items: Comment[] | null; error: boolean } | null;
  /** 送信前の下書き (タスク ID -> 本文。メモリのみ)。 */
  drafts: Record<string, string>;
  busy: boolean;
}

export const useCommentsStore = create<CommentsState>()(() => ({
  scheduleId: null,
  counts: {},
  current: null,
  drafts: {},
  busy: false,
}));

const set = useCommentsStore.setState;
const get = useCommentsStore.getState;

/** 古い応答が新しい状態を上書きしないための世代。 */
let countsGen = 0;
let listGen = 0;

/** スケジュールを開く / 閉じる (null)。状態を空にする。 */
export function resetComments(scheduleId: string | null): void {
  countsGen++;
  listGen++;
  set({ scheduleId, counts: {}, current: null, drafts: {}, busy: false });
}

export async function loadCounts(): Promise<void> {
  const id = get().scheduleId;
  if (id === null) return;
  const gen = ++countsGen;
  try {
    const counts = await fetchCommentCounts(id);
    if (gen === countsGen && get().scheduleId === id) set({ counts });
  } catch {
    /* 件数の印が出ないだけ。次の通知・再接続で取り直す */
  }
}

async function loadList(taskId: string): Promise<void> {
  const id = get().scheduleId;
  if (id === null) return;
  const gen = ++listGen;
  try {
    const items = await fetchComments(id, taskId);
    if (gen !== listGen || get().scheduleId !== id || get().current?.taskId !== taskId) return;
    set({ current: { taskId, items, error: false } });
  } catch {
    if (gen !== listGen || get().current?.taskId !== taskId) return;
    set((s) => ({ current: { taskId, items: s.current?.items ?? null, error: true } }));
  }
}

/** 右ペインで開くタスクを切り替える (null = 閉じる)。一覧を取得する。 */
export function openTaskComments(taskId: string | null): void {
  if (taskId === null) {
    listGen++;
    set({ current: null });
    return;
  }
  const key = idKey(taskId);
  if (get().current?.taskId === key) return;
  set({ current: { taskId: key, items: null, error: false } });
  void loadList(key);
}

export function reloadCurrentComments(): void {
  const c = get().current;
  if (c) void loadList(c.taskId);
}

/** WebSocket の comments イベント / 再接続: 件数を取り直し、そのタスクを開いていれば一覧も取り直す。 */
export function onCommentsChanged(taskId: string): void {
  void loadCounts();
  if (get().current?.taskId === idKey(taskId)) void loadList(idKey(taskId));
}

export function setDraft(taskId: string, text: string): void {
  set((s) => ({ drafts: { ...s.drafts, [idKey(taskId)]: text } }));
}

export type CommentError = "limit" | "invalid" | "forbidden" | "notfound" | "failed";
const classify = (e: unknown): CommentError => {
  if (e instanceof ApiError) {
    if (e.status === 409 && e.error === "comment_limit") return "limit";
    if (e.status === 400) return "invalid";
    if (e.status === 403) return "forbidden";
    if (e.status === 404) return "notfound";
  }
  return "failed";
};

/** 成功なら null、失敗なら理由。成功後は自分で一覧と件数を取り直す (通知は待たない)。 */
async function mutate(taskId: string, f: (scheduleId: string) => Promise<unknown>): Promise<CommentError | null> {
  const id = get().scheduleId;
  if (id === null) return "failed";
  set({ busy: true });
  try {
    await f(id);
    return null;
  } catch (e) {
    return classify(e);
  } finally {
    if (get().scheduleId === id) {
      set({ busy: false });
      onCommentsChanged(taskId);
    }
  }
}

export const postComment = (taskId: string, body: string) => mutate(taskId, (sid) => createComment(sid, taskId, body));
export const editComment = (taskId: string, commentId: string, body: string) =>
  mutate(taskId, (sid) => updateComment(sid, commentId, body));
export const removeComment = (taskId: string, commentId: string) => mutate(taskId, (sid) => deleteComment(sid, commentId));
