import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import { clearSessionCookie, loadSession } from "./auth/session";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 状態変更系メソッドの CSRF 対策。Origin ヘッダが自分のオリジンと一致することを要求する。
 * Origin が無い場合は Sec-Fetch-Site が same-origin / none のときだけ許可 (それも無ければ拒否)。
 */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!UNSAFE.has(c.req.method)) return next();
  const origin = c.req.header("origin");
  const own = new URL(c.req.url).origin;
  if (origin !== undefined) {
    if (origin !== own) return c.json({ error: "forbidden" }, 403);
  } else {
    const site = c.req.header("sec-fetch-site");
    if (site !== "same-origin" && site !== "none") return c.json({ error: "forbidden" }, 403);
  }
  return next();
};

/** /api/* 用。未ログイン・失効・不許可なら 401。 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { hadCookie, session } = await loadSession(c);
  if (!session) {
    if (hadCookie) clearSessionCookie(c); // Cookie が無いときは Set-Cookie を返さない
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("user", session.user);
  c.set("sessionId", session.sessionId);
  return next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.user.isAdmin) return c.json({ error: "forbidden" }, 403);
  return next();
};
