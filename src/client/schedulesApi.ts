// 一覧画面用の REST 呼び出し (作成・複製・削除・インポート・一覧)。
// 編集中のスケジュールへのコマンド送信は sync/ が担当する。
export interface ScheduleListItem {
  id: string;
  name: string;
  updatedAt: number;
  updatedBy: { name: string; email: string };
  /** ログイン中のユーザーのお気に入りか。 */
  favorite: boolean;
}

export interface ApiIssue {
  code: string;
  path: string;
  message?: string;
  params?: Record<string, string | number>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly issues?: ApiIssue[],
    readonly kind?: string,
  ) {
    super(`${status} ${error}`);
  }
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 401) {
    window.location.reload(); // セッション切れ: ログイン画面へ
    throw new ApiError(401, "unauthorized");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(json.error ?? "error"),
      Array.isArray(json.issues) ? (json.issues as ApiIssue[]) : undefined,
      typeof json.kind === "string" ? json.kind : undefined,
    );
  }
  return json as T;
}

export const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function listSchedules(): Promise<ScheduleListItem[]> {
  return (await request<{ schedules: ScheduleListItem[] }>("/api/schedules", { cache: "no-store" })).schedules;
}
export const createSchedule = (name: string) => request<{ id: string }>("/api/schedules", post({ name }));
export const importSchedule = (doc: unknown) =>
  request<{ id: string; warnings: ApiIssue[] }>("/api/schedules", post({ doc }));
export const copySchedule = (copyFrom: string) => request<{ id: string }>("/api/schedules", post({ copyFrom }));
export const deleteSchedule = (id: string) =>
  request<{ ok: true }>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
export const setFavorite = (id: string, on: boolean) =>
  request<{ favorite: boolean }>(`/api/schedules/${encodeURIComponent(id)}/favorite`, { method: on ? "PUT" : "DELETE" });
