import { emailDomain, isAdminEmail, parseList } from "../auth/access";
import type { D1Like } from "../schedules/repo";

/** 管理画面用の D1 アクセス。時刻は ms の INTEGER。 */

const LIST_LIMIT = 1000;

export interface AllowedEmailItem {
  email: string;
  /** 追加した管理者 (users 表から引く。引けなければ null) */
  addedBy: { name: string; email: string } | null;
  createdAt: number;
}

export async function listAllowedEmails(db: D1Like): Promise<AllowedEmailItem[]> {
  const { results } = await db
    .prepare(
      `SELECT a.email, a.created_at AS createdAt, u.name AS userName, u.email AS userEmail
       FROM allowed_emails a LEFT JOIN users u ON u.id = a.added_by
       ORDER BY a.created_at DESC, a.email
       LIMIT ?`,
    )
    .bind(LIST_LIMIT)
    .all<{ email: string; createdAt: number; userName: string | null; userEmail: string | null }>();
  return results.map((r) => ({
    email: r.email,
    createdAt: r.createdAt,
    addedBy: r.userEmail === null ? null : { name: r.userName ?? "", email: r.userEmail },
  }));
}

/** 追加する。すでにあれば false (既存の行は変更しない)。 */
export async function addAllowedEmail(db: D1Like, email: string, addedByUserId: string, now = Date.now()): Promise<boolean> {
  const r = await db
    .prepare("INSERT OR IGNORE INTO allowed_emails (email, added_by, created_at) VALUES (?, ?, ?)")
    .bind(email, addedByUserId, now)
    .run();
  return r.meta.changes > 0;
}

/** 削除する。無ければ false。 */
export async function removeAllowedEmail(db: D1Like, email: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM allowed_emails WHERE email = ?").bind(email).run();
  return r.meta.changes > 0;
}

/** ログイン可能な理由。優先順: 管理者 > 例外アドレス > ドメイン (開発用ログインはローカルのみ)。 */
export type AccessReason = "admin" | "exception" | "domain" | "dev" | null;

export interface UserItem {
  email: string;
  name: string;
  lastLoginAt: number;
  /** 今ログインできる理由。null = 不許可 (次のアクセスでセッションも失効する)。 */
  access: AccessReason;
}

export interface AccessSources {
  allowedDomains: string | undefined;
  adminEmails: string | undefined;
  devLoginEmails: readonly string[];
}

/** 純関数: 現在の設定・例外表・保存済み hd からの許可理由 (isAllowed と同じ規則)。 */
export function accessReason(email: string, hd: string | null, exceptions: ReadonlySet<string>, src: AccessSources): AccessReason {
  const e = email.trim().toLowerCase();
  if (isAdminEmail(e, src.adminEmails)) return "admin";
  if (exceptions.has(e)) return "exception";
  const domains = parseList(src.allowedDomains);
  const d = emailDomain(e);
  if (d && domains.includes(d) && hd !== null && domains.includes(hd.trim().toLowerCase())) return "domain";
  if (src.devLoginEmails.includes(e)) return "dev";
  return null;
}

export async function listUsers(db: D1Like, src: AccessSources): Promise<UserItem[]> {
  const [users, ex] = await Promise.all([
    db
      .prepare("SELECT email, name, hd, last_login_at AS lastLoginAt FROM users ORDER BY last_login_at DESC, email LIMIT ?")
      .bind(LIST_LIMIT)
      .all<{ email: string; name: string; hd: string | null; lastLoginAt: number }>(),
    db.prepare("SELECT email FROM allowed_emails").bind().all<{ email: string }>(),
  ]);
  const exceptions = new Set(ex.results.map((r) => r.email));
  return users.results.map((u) => ({
    email: u.email,
    name: u.name,
    lastLoginAt: u.lastLoginAt,
    access: accessReason(u.email, u.hd, exceptions, src),
  }));
}

export interface DeletedScheduleItem {
  id: string;
  name: string;
  deletedAt: number;
  deletedBy: { name: string; email: string } | null;
}

export async function listDeletedSchedules(db: D1Like): Promise<DeletedScheduleItem[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, s.deleted_at AS deletedAt, u.name AS userName, u.email AS userEmail
       FROM schedules s LEFT JOIN users u ON u.id = s.deleted_by
       WHERE s.deleted_at IS NOT NULL
       ORDER BY s.deleted_at DESC, s.id
       LIMIT ?`,
    )
    .bind(LIST_LIMIT)
    .all<{ id: string; name: string; deletedAt: number; userName: string | null; userEmail: string | null }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    deletedAt: r.deletedAt,
    deletedBy: r.userEmail === null ? null : { name: r.userName ?? "", email: r.userEmail },
  }));
}

/** 復元する (deleted_at / deleted_by を NULL に)。削除されていない・存在しなければ false。 */
export async function restoreSchedule(db: D1Like, id: string): Promise<boolean> {
  const r = await db
    .prepare("UPDATE schedules SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL")
    .bind(id)
    .run();
  return r.meta.changes > 0;
}
