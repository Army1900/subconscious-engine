import { describe, expect, it } from "vitest";
import { extractUserPrompt, injectIntoParts } from "../src/inject.js";
import type { ChatPartLike } from "../src/inject.js";

function textPart(text: string, extra: Partial<ChatPartLike> = {}): ChatPartLike {
  return { type: "text", text, ...extra };
}

describe("extractUserPrompt（用户话语提取）", () => {
  it("单个 text part → 原文", () => {
    expect(extractUserPrompt([textPart("参考上次的修改")])).toBe("参考上次的修改");
  });

  it("跳过 synthetic 文本部分（宿主注入的合成提示不是用户话语）", () => {
    const parts = [textPart("Called the Read tool", { synthetic: true }), textPart("真实用户输入")];
    expect(extractUserPrompt(parts)).toBe("真实用户输入");
  });

  it("跳过非 text 部分，多段用户文本按序换行拼接", () => {
    const parts: ChatPartLike[] = [{ type: "step-start" }, textPart("第一段"), { type: "tool" }, textPart("第二段")];
    expect(extractUserPrompt(parts)).toBe("第一段\n第二段");
  });

  it("空 parts / 全非文本 → 空串", () => {
    expect(extractUserPrompt([])).toBe("");
    expect(extractUserPrompt([{ type: "step-start" }])).toBe("");
  });
});

describe("injectIntoParts（只改当前用户消息）", () => {
  it("追加到唯一 text part 的文本尾部，原话保持前缀不变", () => {
    const part = textPart("参考上次的修改");
    const ok = injectIntoParts([part], "[潜意识引擎·已解析]\n- 历史会话");
    expect(ok).toBe(true);
    expect(part.text).toBe("参考上次的修改\n\n[潜意识引擎·已解析]\n- 历史会话");
  });

  it("synthetic 在前时注入第一个非 synthetic 的 text part，synthetic 不动", () => {
    const synthetic = textPart("合成提示", { synthetic: true });
    const real = textPart("用户原话");
    const ok = injectIntoParts([synthetic, real], "CTX");
    expect(ok).toBe(true);
    expect(synthetic.text).toBe("合成提示");
    expect(real.text).toBe("用户原话\n\nCTX");
  });

  it("多个 text part 只改第一个，其余不动", () => {
    const first = textPart("一");
    const second = textPart("二");
    injectIntoParts([first, second], "CTX");
    expect(first.text).toBe("一\n\nCTX");
    expect(second.text).toBe("二");
  });

  it("没有可用 text part（空 / 全合成 / 全非文本）→ false 且不改动", () => {
    expect(injectIntoParts([], "CTX")).toBe(false);
    const syntheticOnly = [textPart("合成", { synthetic: true })];
    expect(injectIntoParts(syntheticOnly, "CTX")).toBe(false);
    expect(syntheticOnly[0]?.text).toBe("合成");
    const toolOnly: ChatPartLike[] = [{ type: "tool" }];
    expect(injectIntoParts(toolOnly, "CTX")).toBe(false);
    expect(toolOnly[0]?.type).toBe("tool");
  });

  it("空 context → false（no-op，不追加空块）", () => {
    const part = textPart("原话");
    expect(injectIntoParts([part], "")).toBe(false);
    expect(part.text).toBe("原话");
  });
});
