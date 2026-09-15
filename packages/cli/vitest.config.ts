import { defineConfig } from "vitest/config";

/** 唯一目的：挂 test/setup.ts 的 HOME 密闭钉（include 等保持 vitest 默认） */
export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
