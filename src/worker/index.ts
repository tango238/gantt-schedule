import { Hono } from "hono";
import type { AppEnv } from "./env";
import { adminRoutes } from "./admin/routes";
import { authRoutes } from "./auth/routes";
import { devLoginEmails } from "./auth/session";
import { csrf, requireAdmin, requireAuth } from "./middleware";
import { securityHeaders } from "./securityHeaders";
import { scheduleRoutes } from "./schedules/routes";
import { userRoutes } from "./users/routes";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.use("*", csrf);

app.route("/auth", authRoutes);

// 未認証で呼べる API (ログイン画面用)
app.get("/api/auth-config", (c) => {
  c.header("cache-control", "no-store");
  return c.json({ devLogin: devLoginEmails(c) });
});

// これ以降の /api/* は要ログイン
app.use("/api/*", requireAuth);

app.get("/api/me", (c) => {
  c.header("cache-control", "no-store");
  return c.json({ user: c.var.user, isAdmin: c.var.user.isAdmin });
});

// 担当の選択肢用: ログイン済みなら誰でも (管理者用の /api/admin/users とは別。id・名前・メールのみ)。
app.route("/api/users", userRoutes);

app.route("/api/schedules", scheduleRoutes);

// 管理 API: 管理者 (ADMIN_EMAILS) のみ。非管理者は 403。
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", adminRoutes);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

export default app;

// Durable Object のクラスは Worker のエントリから export する (wrangler.jsonc の durable_objects.bindings)。
export { ScheduleRoom } from "./room/ScheduleRoom";
