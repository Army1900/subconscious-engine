/**
 * pi InteractPort 映射测试（D5、M1 定界）：
 * - confirm/select/input → ctx.ui 三对话框，signal/timeout 一比一透传；
 * - hasUI=false → 全部 unsupported；
 * - acquire 在 M1 显式 unsupported（不虚构获取动作完成，M2 交付）。
 */
import { describe, expect, it } from "vitest";
import { createPiInteract } from "../src/interact.js";
import { FakeUi } from "./helpers.js";

describe("createPiInteract", () => {
  it("confirm：boolean → yes/no；signal/timeout 透传", async () => {
    const ui = new FakeUi();
    ui.confirmResult = true;
    const port = createPiInteract({ hasUI: true, ui: ui.ui });
    await expect(port.confirm("要读取剪贴板吗？", { signal: new AbortController().signal, timeoutMs: 5000 })).resolves.toBe("yes");
    ui.confirmResult = false;
    await expect(port.confirm("再次确认", { timeoutMs: 100 })).resolves.toBe("no");
    expect(ui.calls).toHaveLength(2);
    expect(ui.calls[0]?.options).toEqual({ signal: expect.any(AbortSignal), timeout: 5000 });
    expect(ui.calls[1]?.options).toEqual({ signal: undefined, timeout: 100 });
  });

  it("select：undefined → null、字符串原样；options 复制后传给 ui", async () => {
    const ui = new FakeUi();
    ui.selectResult = undefined;
    const port = createPiInteract({ hasUI: true, ui: ui.ui });
    await expect(port.select("选择会话", ["a（1）", "a（2）"], { timeoutMs: 250 })).resolves.toBeNull();
    ui.selectResult = "a（2）";
    await expect(port.select("选择会话", ["a（1）", "a（2）"])).resolves.toBe("a（2）");
    expect(ui.calls[0]?.options).toEqual({ signal: undefined, timeout: 250 });
  });

  it("input：undefined → null、文本原样；placeholder 透传", async () => {
    const ui = new FakeUi();
    ui.inputResult = undefined;
    const port = createPiInteract({ hasUI: true, ui: ui.ui });
    await expect(port.input("请输入阈值", { timeoutMs: 1000 })).resolves.toBeNull();
    ui.inputResult = "42";
    await expect(port.input("请输入阈值")).resolves.toBe("42");
    expect(ui.calls[0]?.messageOrOptions).toBe("请输入阈值"); // FakeUi 记录的第二参数即 placeholder
  });

  it("hasUI=false → confirm/select/input/acquire 全部 unsupported，不触达 ui", async () => {
    const ui = new FakeUi();
    const port = createPiInteract({ hasUI: false, ui: ui.ui });
    await expect(port.confirm("x")).resolves.toBe("unsupported");
    await expect(port.select("t", ["a"])).resolves.toBe("unsupported");
    await expect(port.input("p")).resolves.toBe("unsupported");
    await expect(port.acquire({ kind: "input", prompt: "p", expectedType: "number" })).resolves.toBe("unsupported");
    expect(ui.calls).toHaveLength(0);
  });

  it("acquire 在 M1 无论是否有 UI 都 unsupported（M2 定界，不虚构完成）", async () => {
    const ui = new FakeUi();
    const port = createPiInteract({ hasUI: true, ui: ui.ui });
    await expect(
      port.acquire({ kind: "pick-file", prompt: "选择文件", expectedType: "file" }, { timeoutMs: 100 }),
    ).resolves.toBe("unsupported");
    expect(ui.calls).toHaveLength(0);
  });
});
