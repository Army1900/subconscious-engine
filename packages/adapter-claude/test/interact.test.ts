import { describe, expect, it } from "vitest";
import { createRecordingUnsupportedInteract } from "../src/interact.js";

describe("createRecordingUnsupportedInteract（无 UI 降级端口）", () => {
  it("select 记录 title+labels 并返回 unsupported", async () => {
    const port = createRecordingUnsupportedInteract();
    const answer = await port.select("请选择「上次」所指：", ["会话 A（昨天）", "会话 B（上周）"]);
    expect(answer).toBe("unsupported");
    expect(port.records).toHaveLength(1);
    expect(port.records[0]).toEqual({
      kind: "select",
      title: "请选择「上次」所指：",
      labels: ["会话 A（昨天）", "会话 B（上周）"],
    });
  });

  it("confirm 记录 prompt 并返回 unsupported", async () => {
    const port = createRecordingUnsupportedInteract();
    const answer = await port.confirm("允许潜意识引擎读取数据源「clipboard」？");
    expect(answer).toBe("unsupported");
    expect(port.records[0]).toEqual({ kind: "confirm", prompt: "允许潜意识引擎读取数据源「clipboard」？" });
  });

  it("acquire 记录获取规格并返回 unsupported", async () => {
    const port = createRecordingUnsupportedInteract();
    const spec = {
      kind: "pick-image",
      prompt: "请选择「这张图」所指的图片",
      expectedType: "image",
    } as const;
    const answer = await port.acquire(spec);
    expect(answer).toBe("unsupported");
    expect(port.records[0]).toEqual({ kind: "acquire", spec });
  });

  it("多次调用按顺序累积记录（供降级注入逐条还原）", async () => {
    const port = createRecordingUnsupportedInteract();
    await port.confirm("第一");
    await port.select("第二", ["a", "b"]);
    await port.acquire({
      kind: "input",
      prompt: "第三",
      expectedType: "text",
    });
    expect(port.records.map((r) => r.kind)).toEqual(["confirm", "select", "acquire"]);
  });

  it("记录数组只读快照：外部变更不影响内部记录", () => {
    const port = createRecordingUnsupportedInteract();
    const snapshot = port.records;
    expect(() => {
      (snapshot as unknown as { push(v: unknown): void }).push({ kind: "confirm", prompt: "x" });
    }).toThrow();
  });
});
