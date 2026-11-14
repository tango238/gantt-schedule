import { post, request } from "./schedulesApi";

export interface PersonRef {
  name: string;
  email: string;
}
export interface AllowedEmailItem {
  email: string;
  addedBy: PersonRef | null;
  createdAt: number;
}
export type AccessReason = "admin" | "exception" | "domain" | "dev" | null;
export interface UserItem {
  email: string;
  name: string;
  lastLoginAt: number;
  access: AccessReason;
}
export interface DeletedScheduleItem {
  id: string;
  name: string;
  deletedAt: number;
  deletedBy: PersonRef | null;
}
export interface AdminConfig {
  allowedDomains: string[];
  adminEmails: string[];
}

const get = <T>(url: string) => request<T>(url, { cache: "no-store" });

export const fetchAdminConfig = () => get<AdminConfig>("/api/admin/config");
export const fetchAllowedEmails = async () => (await get<{ items: AllowedEmailItem[] }>("/api/admin/allowed-emails")).items;
export const addAllowedEmail = (email: string) =>
  request<{ email: string; created: boolean }>("/api/admin/allowed-emails", post({ email }));
export const removeAllowedEmail = (email: string) =>
  request<{ ok: true }>(`/api/admin/allowed-emails/${encodeURIComponent(email)}`, { method: "DELETE" });
export const fetchUsers = async () => (await get<{ items: UserItem[] }>("/api/admin/users")).items;
export const fetchDeletedSchedules = async () =>
  (await get<{ items: DeletedScheduleItem[] }>("/api/admin/deleted-schedules")).items;
export const restoreSchedule = (id: string) =>
  request<{ ok: true }>(`/api/admin/schedules/${encodeURIComponent(id)}/restore`, { method: "POST" });
