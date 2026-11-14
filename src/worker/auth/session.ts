import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Env, SessionUser } from "../env";
import { isAdminEmail, isAllowed, isLocalHostname, parseList } from "./access";
import { randomToken, sha256Hex } from "./crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Ctx = Context<AppEnv>;

export function requestHostname(c: Ctx): string {
  return new URL(c.req.url).hostname;
}

/**
 * 開発用ログインのメール一覧 (DEV_LOGIN_EMAIL はカンマ区切り)。
 * 有効なのは DEV_LOGIN_EMAIL が設定され、かつリクエストの hostname が localhost 系のときだけ。無効なら空配列。
 */
export function devLoginEmails(c: Ctx): string[] {
  return isLocalHostname(requestHostname(c)) ? parseList(c.env.DEV_LOGIN_EMAIL) : [];
}

/**
 * Cookie の属性。localhost 系以外は常に Secure + `__Host-` 接頭辞 (Path=/ ・Domain なし)。
 * localhost 系のみ Secure を外し、接頭辞も付けない (http で動かすため)。
 */
export function cookieSpec(c: Ctx, base: "session" | "oauth_tx") {
  const local = isLocalHostname(requestHostname(c));
  return { name: local ? base : `__Host-${base}`, secure: !local };
}

export function setSessionCookie(c: Ctx, token: string): void {
  const { name, secure } = cookieSpec(c, "session");
  setCookie(c, name, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Ctx): void {
  const { name, secure } = cookieSpec(c, "session");
  deleteCookie(c, name, { path: "/", secure });
}

/**
 * D1 の例外アドレス表を読んで許可判定する。hd はログイン時に検証した値 (users.hd)。
 * devLogin = 開発用ログインが有効なときの DEV_LOGIN_EMAIL (無効なら undefined)。
 * HTTP (requireAuth) と Durable Object (WebSocket の権限再判定) の両方がこの関数を使う。
 */
export async function checkAllowedEnv(
  env: Env,
  email: string,
  hd: string | null,
  devLogin: string | undefined,
): Promise<boolean> {
  const e = email.trim().toLowerCase();
  const row = await env.DB.prepare("SELECT 1 AS x FROM allowed_emails WHERE email = ?").bind(e).first();
  return isAllowed(e, hd, {
    allowedDomains: env.ALLOWED_DOMAINS,
    adminEmails: env.ADMIN_EMAILS,
    exceptionEmails: row ? [e] : [],
    devLoginEmail: devLogin,
  });
}

export async function checkAllowed(c: Ctx, email: string, hd: string | null): Promise<boolean> {
  return checkAllowedEnv(c.env, email, hd, devLoginEmails(c).join(",") || undefined);
}

export interface UserProfile {
  email: string;
  name: string;
  picture: string | null;
  /** ログイン時に検証した hd クレーム (dev-login などは null) */
  hd: string | null;
}

/** users を upsert し、セッションを発行して Cookie を設定する。期限切れセッションも掃除する。 */
export async function createSession(c: Ctx, profile: UserProfile): Promise<void> {
  const db = c.env.DB;
  const now = Date.now();
  const email = profile.email.trim().toLowerCase();
  await db
    .prepare(
      `INSERT INTO users (id, email, name, picture, hd, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, picture = excluded.picture, hd = excluded.hd, last_login_at = excluded.last_login_at`,
    )
    .bind(randomToken(16), email, profile.name, profile.picture, profile.hd, now, now)
    .run();
  const user = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (!user) throw new Error("user upsert failed");

  const token = randomToken(32);
  const id = await sha256Hex(token);
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db
      .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(id, user.id, now, now + SESSION_TTL_MS),
  ]);
  setSessionCookie(c, token);
}

/**
 * セッション ID (Cookie 値のハッシュ) からユーザーを引き、現在の設定と保存済み hd で許可を再判定する。
 * 無効 / 期限切れ / 不許可なら null (不許可のときはセッションを削除)。
 */
export async function lookupSession(
  env: Env,
  sessionId: string,
  devLogin: string | undefined,
  now: number = Date.now(),
): Promise<SessionUser | null> {
  const row = await env.DB
    .prepare(
      `SELECT u.id, u.email, u.name, u.picture, u.hd
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(sessionId, now)
    .first<{ id: string; email: string; name: string; picture: string | null; hd: string | null }>();
  if (!row) return null;

  if (!(await checkAllowedEnv(env, row.email, row.hd, devLogin))) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
    return null;
  }
  const { hd: _hd, ...rest } = row;
  return { ...rest, isAdmin: isAdminEmail(row.email, env.ADMIN_EMAILS) };
}

/**
 * Cookie からセッションを引く (lookupSession)。Cookie が無い場合は hadCookie=false を返す。
 */
export async function loadSession(
  c: Ctx,
): Promise<{ hadCookie: boolean; session: { user: SessionUser; sessionId: string } | null }> {
  const token = getCookie(c, cookieSpec(c, "session").name);
  if (!token) return { hadCookie: false, session: null };
  const sessionId = await sha256Hex(token);
  const user = await lookupSession(c.env, sessionId, devLoginEmails(c).join(",") || undefined);
  return { hadCookie: true, session: user ? { sessionId, user } : null };
}

export async function deleteSessionByCookie(c: Ctx): Promise<void> {
  const token = getCookie(c, cookieSpec(c, "session").name);
  if (!token) return;
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
}
