import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      // 拡張ホストが実行時に提供する "vscode" をテスト用スタブへ差し替える。
      vscode: fileURLToPath(new URL("./test/extension/vscode-mock.ts", import.meta.url)),
    },
  },
});
