import { describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { DEADLINE, withDeadline } from "../src/engine.js";

/**
 * 监督整改 6：withDeadline 在源 promise 先完成（成功或失败）时必须移除挂在
 * abort 信号上的监听器，避免长会话 / 每次 enrich 的监听器累积。
 * 迟到 rejection 防外溢语义（D3.3）不得回退。
 */

function abortListenerCount(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}

describe("withDeadline 监听器生命周期", () => {
  it("源先成功：返回值正确且监听器数回落（不累积）", async () => {
    const controller = new AbortController();
    const before = abortListenerCount(controller.signal);
    const value = await withDeadline(Promise.resolve(42), controller.signal);
    expect(value).toBe(42);
    expect(abortListenerCount(controller.signal)).toBe(before);
  });

  it("源先失败：rejection 正常传播且监听器数回落", async () => {
    const controller = new AbortController();
    const before = abortListenerCount(controller.signal);
    await expect(withDeadline(Promise.reject(new Error("源失败")), controller.signal)).rejects.toThrow("源失败");
    expect(abortListenerCount(controller.signal)).toBe(before);
  });

  it("信号已中止：立即 DEADLINE，不等待源", async () => {
    const controller = new AbortController();
    controller.abort();
    const pending = withDeadline(new Promise<number>(() => {}), controller.signal);
    expect(await pending).toBe(DEADLINE);
  });

  it("多次调用、源都先完成：监听器数保持基线（多次 enrich 不累积）", async () => {
    const controller = new AbortController();
    const before = abortListenerCount(controller.signal);
    for (let i = 0; i < 20; i += 1) {
      await withDeadline(Promise.resolve(i), controller.signal);
    }
    expect(abortListenerCount(controller.signal)).toBe(before);
  });

  it("截止获胜后源的迟到 rejection 不外溢（无未处理 rejection）", async () => {
    const controller = new AbortController();
    const pending = withDeadline(
      new Promise<number>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("迟到失败")), { once: true });
      }),
      controller.signal,
    );
    controller.abort();
    expect(await pending).toBe(DEADLINE);
    await new Promise((r) => setTimeout(r, 5)); // 排空微/宏任务，若外溢进程级监听会捕获
  });
});
