import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../env";
import { safeRedirect } from "./access";
import { pkceChallenge, randomToken, timingSafeEqual } from "./crypto";
import { buildAuthUrl, exchangeCode, IdTokenError, verifyIdToken } from "./google";
import {
  checkAllowed,
  clearSessionCookie,
  cookieSpec,
  createSession,
  deleteSessionByCookie,
  devLoginEmails,
} from "./session";

const OAUTH_TTL_SEC = 600;

type Ctx = Context<AppEnv>;

export const authRoutes = new Hono<AppEnv>();

function page(c: Ctx, title: string, message: string, status: ContentfulStatusCode) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="/error-page.css"></head><body><div class="box"><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/">トップへ戻る</a></div></body></html>`;
  c.header("cache-control", "no-store");
  return c.html(html, status); // c.html 経由なので c.header / Cookie 操作 (Set-Cookie) が反映される
}

const denied = (c: Ctx) => page(c, "このアカウントではログインできません", "このアカウントには Schedule へのアクセスが許可されていません。管理者に連絡してください。", 403);
const failed = (c: Ctx) => page(c, "ログインに失敗しました", "もう一度お試しください。", 400);

authRoutes.get("/login", async (c) => {
  const { GOOGLE_CLIENT_ID } = c.env;
  if (!GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return page(c, "設定エラー", "Google ログインが設定されていません。", 503);
  }
  const url = new URL(c.req.url);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const codeVerifier = randomToken(32); // PKCE
  const redirect = safeRedirect(url.searchParams.get("redirect"));
  // state / nonce / code_verifier / 戻り先は短命の HttpOnly Cookie に保持。state は URL 側と突き合わせて CSRF を防ぐ。
  const oauth = cookieSpec(c, "oauth_tx");
  setCookie(c, oauth.name, JSON.stringify({ state, nonce, codeVerifier, redirect }), {
    httpOnly: true,
    secure: oauth.secure,
    sameSite: "Lax", // Google からのトップレベル GET 遷移で送られる必要がある
    path: "/", // __Host- 接頭辞は Path=/ が必須
    maxAge: OAUTH_TTL_SEC,
  });
  c.header("cache-control", "no-store");
  return c.redirect(
    buildAuthUrl({
      clientId: GOOGLE_CLIENT_ID,
      redirectUri: `${url.origin}/auth/callback`,
      state,
      nonce,
      codeChallenge: await pkceChallenge(codeVerifier),
    }),
    302,
  );
});

authRoutes.get("/callback", async (c) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = c.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return page(c, "設定エラー", "Google ログインが設定されていません。", 503);
  const url = new URL(c.req.url);

  const oauth = cookieSpec(c, "oauth_tx");
  const raw = getCookie(c, oauth.name);
  deleteCookie(c, oauth.name, { path: "/", secure: oauth.secure }); // 使い捨て
  c.header("cache-control", "no-store");

  let tx: { state: string; nonce: string; codeVerifier: string; redirect: string };
  try {
    const parsed = JSON.parse(raw ?? "");
    if (typeof parsed?.state !== "string" || typeof parsed?.nonce !== "string" || typeof parsed?.codeVerifier !== "string") throw new Error();
    tx = { state: parsed.state, nonce: parsed.nonce, codeVerifier: parsed.codeVerifier, redirect: safeRedirect(parsed.redirect) };
  } catch {
    return failed(c);
  }

  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code || !timingSafeEqual(state, tx.state)) return failed(c);

  try {
    const idToken = await exchangeCode({
      code,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: `${url.origin}/auth/callback`,
      codeVerifier: tx.codeVerifier,
    });
    const id = await verifyIdToken(idToken, { clientId: GOOGLE_CLIENT_ID, nonce: tx.nonce });
    if (!(await checkAllowed(c, id.email, id.hd))) return denied(c);
    await createSession(c, { email: id.email, name: id.name, picture: id.picture, hd: id.hd });
  } catch (e) {
    if (e instanceof IdTokenError) {
      console.warn("login failed:", e.message);
      return failed(c);
    }
    throw e;
  }
  return c.redirect(tx.redirect, 302);
});

authRoutes.post("/logout", async (c) => {
  await deleteSessionByCookie(c);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// 開発用ログイン: DEV_LOGIN_EMAIL (カンマ区切り) が設定されているときだけ存在する。未設定なら 404。
// ?as=<email> で一覧内のメールを選べる (省略時は先頭)。一覧に無いメールは 404。
authRoutes.get("/dev-login", async (c) => {
  // DEV_LOGIN_EMAIL 設定 かつ hostname が localhost 系のときだけ有効 (多重防御)
  const emails = devLoginEmails(c);
  if (emails.length === 0) return c.notFound();
  const as = c.req.query("as")?.trim().toLowerCase();
  const email = as === undefined || as === "" ? emails[0]! : emails.find((e) => e === as);
  if (!email) return c.notFound();
  await createSession(c, { email, name: email.split("@")[0] || email, picture: null, hd: null });
  c.header("cache-control", "no-store");
  return c.redirect(safeRedirect(new URL(c.req.url).searchParams.get("redirect")), 302);
});
