import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// フロント (src/client) と Worker (src/worker) を 1 つの vite で扱う。
// Worker は wrangler.jsonc の main を @cloudflare/vite-plugin が workerd 上で動かす。
// テストは vitest.config.ts (プラグインなし) を使う。
export default defineConfig({
  plugins: [react(), cloudflare()],
});
