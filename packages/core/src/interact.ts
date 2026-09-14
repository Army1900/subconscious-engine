import type {
  AcquisitionSpec,
  InteractOptions,
  InteractPort,
  Logger,
  ResolvedValue,
  Timer,
  TimerHandle,
} from "./types.js";
import { errorMessage } from "./errors.js";

/** 全能力不可用的交互端口：宿主未提供 interact 时走降级路径而非报错（DESIGN §8.2） */
export const UNSUPPORTED_INTERACT: InteractPort = {
  confirm: async () => "unsupported",
  select: async () => "unsupported",
  acquire: async () => "unsupported",
};

/**
 * 带纪律的交互包装器（D5）：
 * - 每次交互创建子 AbortController：端口只收子信号；单次交互超时或引擎信号（父）中止时
 *   立即 settle 安全侧并 abort 子信号（宿主 UI 收到 aborted 即关闭对话框），端口永不结束
 *   或忽略取消时依然有界；每次调用结束清理 timer 与父信号监听器；
 * - 超时/取消取安全侧：confirm → "no"（不授权、不读取）；select/acquire → null（放弃，不注入结论）；
 * - 引擎信号已中止时不再发起交互（截止后禁止新 UI，D3）；
 * - 端口抛错按超时同侧处理并记日志（fail-open）。
 */
export interface GuardedInteract {
  confirm(prompt: string): Promise<"yes" | "no" | "unsupported">;
  select(title: string, options: readonly string[]): Promise<string | null | "unsupported">;
  acquire(spec: AcquisitionSpec): Promise<ResolvedValue | null | "unsupported">;
}

export interface GuardedInteractOptions {
  readonly signal: AbortSignal;
  readonly interactTimeoutMs: number;
  readonly timer: Timer;
  readonly logger?: Logger;
}

function raceWithFallback<T>(
  opts: GuardedInteractOptions,
  fallback: () => T,
  run: (io: InteractOptions) => Promise<T>,
): Promise<T> {
  // 截止后禁止新交互：直接返回安全侧，不调用端口
  if (opts.signal.aborted) return Promise.resolve(fallback());
  return new Promise<T>((resolve) => {
    // 子 AbortController（监督 review-01 13:19）：每次交互独立信号。
    // 端口拿到的是子信号：单次交互超时 / 父信号（引擎截止）中止 / 端口报错时
    // abort 它，宿主 UI 据此关闭对话框；父信号不直传，避免端口越过本次交互生命周期。
    const child = new AbortController();
    let settled = false;
    let handle: TimerHandle | undefined;
    const finish = (value: T, abortChild: boolean): void => {
      if (settled) return;
      settled = true;
      if (handle !== undefined) opts.timer.clear(handle);
      opts.signal.removeEventListener("abort", onParentAbort);
      if (abortChild && !child.signal.aborted) child.abort();
      resolve(value);
    };
    const onParentAbort = (): void => {
      finish(fallback(), true); // 引擎截止：立即安全侧并中止子信号（不等交互超时）
    };
    opts.signal.addEventListener("abort", onParentAbort, { once: true });
    handle = opts.timer.set(() => finish(fallback(), true), opts.interactTimeoutMs);
    run({ signal: child.signal, timeoutMs: opts.interactTimeoutMs }).then(
      (value) => finish(value, false), // 正常完成：不中止子信号，只清理 timer/父监听器
      (err: unknown) => {
        opts.logger?.({ level: "warn", event: "interact-error", detail: errorMessage(err) });
        finish(fallback(), true); // 端口错误：该次交互失败，中止子信号并取安全侧
      },
    );
  });
}

export function guardInteract(port: InteractPort, opts: GuardedInteractOptions): GuardedInteract {
  return {
    confirm(prompt: string): Promise<"yes" | "no" | "unsupported"> {
      return raceWithFallback(opts, () => "no", (io) => port.confirm(prompt, io));
    },
    select(title: string, options: readonly string[]): Promise<string | null | "unsupported"> {
      return raceWithFallback(opts, () => null, (io) => port.select(title, options, io));
    },
    acquire(spec: AcquisitionSpec): Promise<ResolvedValue | null | "unsupported"> {
      return raceWithFallback(opts, () => null, (io) => port.acquire(spec, io));
    },
  };
}
