import { describe, expect, it } from "vitest";
import { createRecordingUnsupportedInteract } from "../src/interact.js";

describe("录制型 unsupported InteractPort（OpenCode plugin 无交互对话框 API）", () => {
  it("confirm 返回 unsupported 并录制提示文案", async () => {
    const port = createRecordingUnsupportedInteract();
    await expect(port.confirm("读取剪贴板？")).resolves.toBe("unsupported");
    expect(port.records).toEqual([{ kind: "confirm", prompt: "读取剪贴板？" }]);
  });

  it("select 返回 unsupported 并录制候选标签", async () => {
    const port = createRecordingUnsupportedInteract();
    await expect(port.select("选择会话", ["会话 A", "会话 B"])).resolves.toBe("unsupported");
    expect(port.records).toEqual([{ kind: "select", title: "选择会话", labels: ["会话 A", "会话 B"] }]);
  });

  it("acquire 返回 unsupported 并录制规格", async () => {
    const port = createRecordingUnsupportedInteract();
    const spec = {
      kind: "pick-image" as const,
      prompt: "选择图片",
      expectedType: "image" as const,
    };
    await expect(port.acquire(spec)).resolves.toBe("unsupported");
    expect(port.records).toEqual([{ kind: "acquire", spec }]);
  });

  it("records 是只读快照（外部 push 不影响后续读取）", async () => {
    const port = createRecordingUnsupportedInteract();
    await port.confirm("a");
    const snapshot = port.records as unknown as Array<unknown>;
    expect(() => snapshot.push("x")).toThrow();
    await port.confirm("b");
    expect(port.records).toHaveLength(2);
  });
});
