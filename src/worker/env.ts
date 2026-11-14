import type { Hono } from "hono";

/** Worker のバインディング / 環境変数 (wrangler.jsonc の vars、シークレット、.dev.vars)。 */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** スケジュールごとの Durable Object (idFromName(scheduleId))。 */
  SCHEDULE_ROOM: DurableObjectNamespace<import("./room/ScheduleRoom").ScheduleRoom>;
  ALLOWED_DOMAINS: string;
  ADMIN_EMAILS: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** 設定されているときだけ /auth/dev-login が有効。ローカル (.dev.vars) のみ。 */
  DEV_LOGIN_EMAIL?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  isAdmin: boolean;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; sessionId: string };
};

export type App = Hono<AppEnv>;
