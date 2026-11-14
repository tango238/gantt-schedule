import { post, request } from "../schedulesApi";

export interface Comment {
  id: string;
  taskId: string;
  body: string;
  createdAt: number;
  /** null = 未編集 */
  updatedAt: number | null;
  author: { id: string; name: string };
  /** 自分が書いたか (編集・削除できる)。 */
  mine: boolean;
}

const base = (scheduleId: string) => `/api/schedules/${encodeURIComponent(scheduleId)}`;
const taskBase = (scheduleId: string, taskId: string) => `${base(scheduleId)}/tasks/${encodeURIComponent(taskId)}/comments`;

export async function fetchCommentCounts(scheduleId: string): Promise<Record<string, number>> {
  return (await request<{ counts: Record<string, number> }>(`${base(scheduleId)}/comment-counts`, { cache: "no-store" })).counts;
}
export async function fetchComments(scheduleId: string, taskId: string): Promise<Comment[]> {
  return (await request<{ comments: Comment[] }>(taskBase(scheduleId, taskId), { cache: "no-store" })).comments;
}
export const createComment = (scheduleId: string, taskId: string, body: string) =>
  request<{ comment: Comment }>(taskBase(scheduleId, taskId), post({ body }));
export const updateComment = (scheduleId: string, commentId: string, body: string) =>
  request<{ comment: Comment }>(`${base(scheduleId)}/comments/${encodeURIComponent(commentId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
export const deleteComment = (scheduleId: string, commentId: string) =>
  request<{ ok: true }>(`${base(scheduleId)}/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });
