import { defineConfig } from "vitest/config";

// 純関数 (engine / model / 認証判定 / コマンド適用) と、クライアントのストア・コンポーネントのテスト。
// workerd は起動しない。DOM が要るテストはファイル先頭の `// @vitest-environment jsdom` で切り替える。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
