import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env";
import { normalizeEmail } from "../../shared/email";
import { parseList } from "../auth/access";
import { devLoginEmails } from "../auth/session";
import {
  addAllowedEmail,
  listAllowedEmails,
  listDeletedSchedules,
  listUsers,
  removeAllowedEmail,
  restoreSchedule,
} from "./repo";

const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** /api/admin/* (requireAuth + requireAdmin の後ろにマウントする)。 */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use("*", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "too_large" }, 413) }));
adminRoutes.use("*", async (c, next) => {
  c.header("cache-control", "no-store");
  return next();
});

/** 読み取り専用の現在の設定 (デプロイ設定。管理画面からは変更できない)。 */
adminRoutes.get("/config", (c) =>
  c.json({ allowedDomains: parseList(c.env.ALLOWED_DOMAINS), adminEmails: parseList(c.env.ADMIN_EMAILS) }),
);

adminRoutes.get("/allowed-emails", async (c) => c.json({ items: await listAllowedEmails(c.env.DB) }));

/** 追加。すでに登録済みなら 200 { created: false } (冪等)。新規は 201 { created: true }。 */
adminRoutes.post("/allowed-emails", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  if (email === null) return c.json({ error: "invalid_email" }, 400);
  const created = await addAllowedEmail(c.env.DB, email, c.var.user.id);
  return c.json({ email, created }, created ? 201 : 200);
});

adminRoutes.delete("/allowed-emails/:email", async (c) => {
  const email = normalizeEmail(c.req.param("email"));
  if (email === null) return c.json({ error: "invalid_email" }, 400);
  if (!(await removeAllowedEmail(c.env.DB, email))) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

adminRoutes.get("/users", async (c) =>
  c.json({
    items: await listUsers(c.env.DB, {
      allowedDomains: c.env.ALLOWED_DOMAINS,
      adminEmails: c.env.ADMIN_EMAILS,
      devLoginEmails: devLoginEmails(c),
    }),
  }),
);

adminRoutes.get("/deleted-schedules", async (c) => c.json({ items: await listDeletedSchedules(c.env.DB) }));

/**
 * 復元。D1 の deleted_at を NULL にするだけでよい: 削除時に Durable Object はキャッシュを捨て接続を閉じており、
 * 削除中は保存も接続もできない (rev も変わらない)。復元後の最初の接続で D1 から読み直される。
 */
adminRoutes.post("/schedules/:id/restore", async (c) => {
  const id = c.req.param("id");
  if (!ID_PATTERN.test(id) || !(await restoreSchedule(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
