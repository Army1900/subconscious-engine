import { describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { guardInteract } from "../src/interact.js";
import { ManualTimer } from "../src/timer.js";
import type { AcquisitionSpec, InteractOptions, InteractPort } from "../src/types.js";
import { flushMicrotasks } from "./helpers.js";

/**
 * 监督 review-01（2026-09-13 13:19）：guardInteract 必须为每次交互创建子 AbortController——
 * - 单次交互超时：abort 子 signal 并 settle 安全侧（UI 收到 aborted，对话框关闭）；
 * - 父 signal（引擎截止/dispose）中止：立即 settle 安全侧并 abort 子 signal；
 * - 端口永不结束或忽略取消时仍有界；
 * - 每次调用结束清理 timer 与父 signal 监听器（不累积）。
 */

/** 捕获端口收到的 opts 且永不 settle 的端口（模拟忽略取消的宿主 UI） */
function hangingPort(capture: (io: InteractOptions | undefined) => void): InteractPort {
  return {
    confirm: (_prompt: string, opts?: InteractOptions) => {
      capture(opts);
      return new Promise<"yes" | "no" | "unsupported">(() => {});
    },
    select: (_title: string, _options: readonly string[], opts?: InteractOptions) => {
      capture(opts);
      return new Promise<string | null | "unsupported">(() => {});
    },
    acquire: (_spec: AcquisitionSpec, opts?: InteractOptions) => {
      capture(opts);
      return new Promise<null | "unsupported">(() => {});
    },
  };
}

describe("单次交互的子 AbortController", () => {
  it("超时：settle 安全值并 abort 子 signal；端口拿到的是子信号而非父信号；timer 已清", async () => {
    const timer = new ManualTimer();
    const parent = new AbortController();
    let captured: InteractOptions | undefined;
    const port = hangingPort((io) => {
      captured = io;
    });
    const guarded = guardInteract(port, { signal: parent.signal, interactTimeoutMs: 1500, timer });

    const pending = guarded.confirm("允许读取？");
    await flushMicrotasks();

    expect(captured?.signal).toBeDefined();
    expect(captured?.signal).not.toBe(parent.signal); // 子控制器信号，不直传父信号
    expect(captured?.signal?.aborted).toBe(false);
    expect(captured?.timeoutMs).toBe(1500);

    timer.advance(1500); // 单次交互预算耗尽
    await expect(pending).resolves.toBe("no"); // confirm 安全侧
    expect(captured?.signal?.aborted).toBe(true); // UI 收到 aborted
    expect(timer.pendingCount()).toBe(0); // timer 已清
  });

  it("超时（select）：安全侧 null 并 abort 子 signal", async () => {
    const timer = new ManualTimer();
    const parent = new AbortController();
    let captured: InteractOptions | undefined;
    const port = hangingPort((io) => {
      captured = io;
    });
    const guarded = guardInteract(port, { signal: parent.signal, interactTimeoutMs: 800, timer });

    const pending = guarded.select("请选择", ["甲", "乙"]);
    await flushMicrotasks();
    timer.advance(800);
    await expect(pending).resolves.toBeNull();
    expect(captured?.signal?.aborted).toBe(true);
    expect(timer.pendingCount()).toBe(0);
  });

  it("父 signal 中止：不等交互超时立即 settle 安全值并 abort 子 signal", async () => {
    const timer = new ManualTimer();
    const parent = new AbortController();
    let captured: InteractOptions | undefined;
    const port = hangingPort((io) => {
      captured = io;
    });
    const guarded = guardInteract(port, { signal: parent.signal, interactTimeoutMs: 30_000, timer });

    const pending = guarded.confirm("允许读取？");
    await flushMicrotasks();
    parent.abort(); // 引擎截止：端口忽略取消也必须立即有界
    await expect(pending).resolves.toBe("no");
    expect(captured?.signal?.aborted).toBe(true);
    expect(timer.pendingCount()).toBe(0); // 未推进任何时间即返回（立即，非等到 30s）
    expect(timer.now()).toBe(0);
  });
});

describe("交互结束后的清理（timer / 父监听器）", () => {
  it("端口先完成：返回真实值，父 signal 监听器数回落、timer 清空", async () => {
    const timer = new ManualTimer();
    const parent = new AbortController();
    const port: InteractPort = {
      confirm: async () => "yes",
      select: async () => "甲",
      acquire: async () => null,
    };
    const guarded = guardInteract(port, { signal: parent.signal, interactTimeoutMs: 1000, timer });

    const before = getEventListeners(parent.signal, "abort").length;
    await expect(guarded.confirm("允许？")).resolves.toBe("yes");
    expect(getEventListeners(parent.signal, "abort").length).toBe(before); // 无监听器累积
    expect(timer.pendingCount()).toBe(0);

    // 已清理的 timer 再推进也不产生任何效果
    timer.advance(10_000);
    await flushMicrotasks();
  });

  it("端口抛错：安全侧 + abort 子 signal + 清理", async () => {
    const timer = new ManualTimer();
    const parent = new AbortController();
    let captured: InteractOptions | undefined;
    const port: InteractPort = {
      confirm: (_prompt: string, opts?: InteractOptions) => {
        captured = opts;
        return Promise.reject(new Error("UI 崩溃"));
      },
      select: async () => null,
      acquire: async () => null,
    };
    const guarded = guardInteract(port, { signal: parent.signal, interactTimeoutMs: 1000, timer });

    await expect(guarded.confirm("允许？")).resolves.toBe("no");
    expect(captured?.signal?.aborted).toBe(true);
    expect(timer.pendingCount()).toBe(0);
    expect(getEventListeners(parent.signal, "abort").length).toBe(0);
  });
});
