import type { GanttDocument } from "../shared/model/types";
import { post, request } from "./schedulesApi";

export type VersionKind = "manual" | "auto";

export interface VersionItem {
  id: string;
  name: string;
  kind: VersionKind;
  rev: number | null;
  createdAt: number;
  createdBy: { name: string; email: string };
}
export interface VersionDetail extends VersionItem {
  /** 保存時点の doc (view なし)。 */
  doc: GanttDocument;
}

const base = (scheduleId: string) => `/api/schedules/${encodeURIComponent(scheduleId)}/versions`;

export async function listVersions(scheduleId: string): Promise<VersionItem[]> {
  return (await request<{ versions: VersionItem[] }>(base(scheduleId), { cache: "no-store" })).versions;
}
export const getVersion = (scheduleId: string, versionId: string) =>
  request<VersionDetail>(`${base(scheduleId)}/${encodeURIComponent(versionId)}`, { cache: "no-store" });
export const saveVersion = (scheduleId: string, name: string) =>
  request<{ id: string; created: boolean }>(base(scheduleId), post({ name }));
/** 戻す。changed=false は「現在の内容と同じで何もしなかった」。成功すると接続中の全クライアントに reset が配信される。 */
export const restoreVersion = (scheduleId: string, versionId: string) =>
  request<{ ok: true; changed: boolean; rev: number }>(`${base(scheduleId)}/${encodeURIComponent(versionId)}/restore`, {
    method: "POST",
  });
export const deleteVersion = (scheduleId: string, versionId: string) =>
  request<{ ok: true }>(`${base(scheduleId)}/${encodeURIComponent(versionId)}`, { method: "DELETE" });
/** AI 適用の直前の自動バージョン。同一内容なら created=false (成功扱い)。名前はサーバーが付ける。 */
export const saveAutoVersion = (scheduleId: string) =>
  request<{ id: string; created: boolean }>(base(scheduleId), post({ kind: "auto", reason: "ai" }));
