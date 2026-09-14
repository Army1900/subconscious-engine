import type { Timer, TimerHandle } from "./types.js";

/**
 * 截止时钟（D3）：deadline + AbortSignal。
 *
 * - 机器预算：timeoutMs 只计机器工作时间；pause/resume 期间预算冻结（等待用户交互时，
 *   交互本身由 interactTimeoutMs 单独约束，D3.1 双时钟）。
 * - 到期即 abort：引擎把 signal 传给一切异步端口（数据源、HostEnv provider、交互），
 *   截止后不再发起任何新的数据源调用或交互。
 * - dispose：enrich 返回前统一调用，清除计时句柄并 abort 信号，关闭仍在等待的交互。
 */
export interface DeadlineClock {
  readonly signal: AbortSignal;
  expired(): boolean;
  remainingMs(): number;
  /** 冻结机器预算（进入用户交互时调用；可重入计数） */
  pause(): void;
  /** 恢复机器预算（交互结束时调用） */
  resume(): void;
  /** 清理并 abort。幂等 */
  dispose(): void;
}

export function createDeadlineClock(totalMs: number, timer: Timer): DeadlineClock {
  const controller = new AbortController();
  const startAt = timer.now();
  let deadline = startAt + Math.max(0, totalMs);
  let fired = false;
  let disposed = false;
  let handle: TimerHandle | undefined;
  let pauseDepth = 0;
  let pausedAt: number | null = null;

  const clearHandle = (): void => {
    if (handle !== undefined) {
      timer.clear(handle);
      handle = undefined;
    }
  };

  const fire = (): void => {
    if (fired || disposed) return;
    fired = true;
    clearHandle();
    controller.abort();
  };

  const arm = (): void => {
    if (fired || disposed || pauseDepth > 0) return;
    const ms = deadline - timer.now();
    if (ms <= 0) {
      fire();
      return;
    }
    clearHandle();
    handle = timer.set(fire, ms);
  };

  arm();

  return {
    signal: controller.signal,
    expired(): boolean {
      if (fired || disposed || controller.signal.aborted) return true;
      const now = pausedAt ?? timer.now(); // 暂停期间机器时间冻结在 pausedAt
      return now >= deadline;
    },
    remainingMs(): number {
      if (fired) return 0;
      const now = pausedAt ?? timer.now();
      return Math.max(0, deadline - now);
    },
    pause(): void {
      if (fired || disposed) return;
      pauseDepth += 1;
      if (pauseDepth === 1) {
        pausedAt = timer.now();
        clearHandle();
      }
    },
    resume(): void {
      if (pauseDepth === 0 || pausedAt === null) return;
      pauseDepth -= 1;
      if (pauseDepth === 0) {
        deadline += timer.now() - pausedAt; // 暂停时长不计入机器预算
        pausedAt = null;
        arm();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearHandle();
      controller.abort();
    },
  };
}
