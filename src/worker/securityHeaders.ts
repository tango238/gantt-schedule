import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";

/**
 * Worker が返す応答用のセキュリティヘッダー。静的ファイルの応答には public/_headers が効く
 * (Workers Static Assets の _headers は Worker の応答には適用されない) ので、同じ内容をここでも付ける。
 * form-action は Google ログインへの遷移 (リダイレクト) には影響しないが、'self' のままで足りる。
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://*.googleusercontent.com",
  "connect-src 'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  // WebSocket のアップグレードは応答ヘッダーを触らない (stub.fetch が返す 101 応答は変更できない)。
  if (c.req.header("upgrade")?.toLowerCase() === "websocket") return next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "strict-origin-when-cross-origin");
  c.header("x-frame-options", "DENY");
  c.header("x-robots-tag", "noindex, nofollow");
  await next();
  if (c.res.headers.get("content-type")?.startsWith("text/html")) c.res.headers.set("content-security-policy", CSP);
};
