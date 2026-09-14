/**
 * UserPromptSubmit 可执行入口的超时配置（硬化轮从 hook-main.ts 抽出）。
 *
 * 原因：hook-main.ts 是**可执行入口**（导入即副作用：注册全局异常处理器 +
 * 读 stdin），此前 index.ts 从它 re-export 超时常量，导致库式
 * `import "@subconscious/adapter-claude"` 阻塞至 stdin 预算耗尽并吞掉消费者
 * 进程的未捕获异常（tarball 消费者 smoke 首次发现，回归测试
 * test/index-entry.proc.test.ts 锁定）。本模块保持零副作用："." 入口与
 * hook-main 都从这里取值。
 */

export const DEFAULT_TOTAL_TIMEOUT_MS = 5000;
export const MAX_TOTAL_TIMEOUT_MS = 30000;
const TIMEOUT_ENV_VAR = "SUBCONSCIOUS_HOOK_TIMEOUT_MS";

export function resolveTotalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TIMEOUT_ENV_VAR];
  if (raw === undefined) return DEFAULT_TOTAL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_TOTAL_TIMEOUT_MS;
  return Math.min(n, MAX_TOTAL_TIMEOUT_MS);
}
