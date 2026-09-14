import type { Timer, TimerHandle } from "./types.js";

/**
 * 系统计时器：@types/node 为 core 的显式 devDependency（types: ["node"]），
 * 取消/计时类型不依赖任何宿主或传递依赖（监督复核点）。
 */
export function createSystemTimer(): Timer {
  return {
    now: () => Date.now(),
    set: (fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms),
    clear: (handle: TimerHandle): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

interface ScheduledTask {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/**
 * 手动时钟：测试注入用。advance() 顺序触发到期任务，超时语义可确定性复现，
 * 不依赖真实睡眠（避免超时测试抖动）。
 */
export class ManualTimer implements Timer {
  private nowMs: number = 0;
  private seq: number = 0;
  private readonly tasks = new Map<number, ScheduledTask>();

  now(): number {
    return this.nowMs;
  }

  set(fn: () => void, ms: number): TimerHandle {
    this.seq += 1;
    const id = this.seq;
    this.tasks.set(id, { id, at: this.nowMs + Math.max(0, ms), fn });
    return id;
  }

  clear(handle: TimerHandle): void {
    this.tasks.delete(handle as number);
  }

  /** 推进时间并触发所有到期任务（按到期时间升序） */
  advance(ms: number): void {
    this.nowMs += ms;
    for (;;) {
      let due: ScheduledTask | undefined;
      for (const task of this.tasks.values()) {
        if (task.at <= this.nowMs && (due === undefined || task.at < due.at)) {
          due = task;
        }
      }
      if (due === undefined) return;
      this.tasks.delete(due.id);
      due.fn();
    }
  }

  /** 尚未触发的任务数（测试断言 timer 清理纪律用） */
  pendingCount(): number {
    return this.tasks.size;
  }
}
