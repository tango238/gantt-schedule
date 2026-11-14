import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listAllUsers } from "./repo";

/**
 * 担当の選択肢用 (/api/users)。ログイン済みなら誰でも使える (管理者用の /api/admin/users とは別)。
 * 返すのは id・名前・メールだけ (最終ログイン・許可状態などは返さない)。
 */
export const userRoutes = new Hono<AppEnv>();

userRoutes.get("/", async (c) => {
  c.header("cache-control", "no-store");
  return c.json({ users: await listAllUsers(c.env.DB) });
});
