import { defineConfig } from "vitest/config";

/** 唯一目的：挂 test/setup.ts 的记忆路径密闭钉（include 等保持 vitest 默认） */
export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
