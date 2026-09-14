/**
 * "." 入口导入纯净性（硬化轮回归；由独立消费者 tarball smoke 首次发现的缺陷）。
 *
 * 缺陷：index.ts 曾 re-export 自 hook-main.js（可执行入口，导入即副作用：
 * 注册全局 uncaughtException/unhandledRejection 处理器 + 排干 stdin）——
 * 库式 `import "@subconscious/adapter-claude"` 会阻塞至 stdin 超时（默认 5s），
 * 并吞掉消费者进程自己的未捕获异常（退出码被改写为 0）。
 *
 * 验证（真实子进程，非进程内 mock）：父进程保持子进程 stdin 打开（永不关闭），
 * 子进程导入 "." 入口后立即打印并退出。若入口仍读取 stdin，子进程会挂到
 * readAllStdin 预算耗尽（≥ 总超时），本测试即失败。
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const CHILD_SCRIPT = `
await import("@subconscious/adapter-claude");
process.stdout.write("IMPORTED\\n");
`;

describe('"." 入口导入纯净（不读 stdin、不注册全局处理器）', () => {
  it("导入后立即完成：stdin 保持打开也不阻塞、不排干", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    // 故意不写/不关 child.stdin：入口若读 stdin，将挂到预算耗尽
    const startedAt = Date.now();
    const code = await new Promise<number>((resolve) => {
      child.on("close", (exitCode) => resolve(exitCode ?? -1));
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 4000).unref();
    });
    const durationMs = Date.now() - startedAt;
    expect(code).toBe(0);
    expect(stdout).toBe("IMPORTED\n");
    expect(stderr).toBe("");
    expect(durationMs).toBeLessThan(2000); // 旧缺陷会阻塞约 5s（stdin 预算）
  });
});
