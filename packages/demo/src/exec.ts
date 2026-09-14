/**
 * 真实子进程版 PiExec（demo 用）。
 *
 * pi 宿主的 `pi.exec` 与 pi 内部的 execCommand 都不从包根导出（exports 只有 "."、
 * rpc-entry 等子路径），demo 无法复用其实现；故按官方 ExecOptions/ExecResult
 * 契约自实现一个真实执行器：spawn 真实进程、透传 cwd/signal/timeout。
 *
 * 消费方是 adapter 的 readGitStatus：临时 fixture 目录不是 git 仓库 →
 * code !== 0 → undefined（不注入 git 块），与真实宿主行为一致（fail-open）。
 */
import { spawn } from "node:child_process";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

export function realExec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(command, args, { cwd: options?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killed = false;

    const timer =
      options?.timeout !== undefined
        ? setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, options.timeout)
        : undefined;
    const onAbort = (): void => {
      killed = true;
      child.kill("SIGKILL");
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.signal?.aborted) onAbort(); // 已中止的信号不会再触发 abort 事件

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code: child.exitCode ?? 1, killed });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // 可执行文件不存在等 spawn 失败：按 code=1 结束（上层以 code!==0 判定不可用）
    child.on("error", (err: Error) => {
      stderr += err.message;
      finish();
    });
    child.on("close", () => {
      finish();
    });
  });
}
