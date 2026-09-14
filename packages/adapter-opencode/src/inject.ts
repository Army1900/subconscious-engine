/**
 * chat.message 输出的 parts 读写（DESIGN §7.4；docs/ACCEPTANCE「OpenCode」行）。
 *
 * 协议事实（@opencode-ai/plugin@1.18.30 Hooks["chat.message"]，2026-09-14 核实）：
 * hook 以 (input, output) 触发，output = { message: UserMessage; parts: Part[] }，
 * 按引用传给插件、await 后宿主把同一对象持久化并送 LLM——突变 parts 即改写
 * 「当前这条用户消息」。UserMessage 本体无文本字段，用户话语在非合成 text part。
 *
 * 纪律：
 * - 只改当前用户消息：仅突变 output.parts 中已存在的第一个非合成 text part，
 *   不 push 新 part（插件自造 id/sessionID 的 part 不在官方契约内）、不动其他
 *   part、不动历史消息（experimental.chat.messages.transform 才触及历史，禁用）；
 * - 原话不改写：注入物以 "\n\n" 追加在原文本之后，原文保持逐字节前缀；
 * - 找不到可注入通道（无文本部分）→ false，调用方放弃注入（fail-open no-op）。
 */

/** 本适配器消费的 Part 结构子面：真实 SDK Part（判别联合）结构性满足 */
export interface ChatPartLike {
  type: string;
  synthetic?: boolean;
  text?: string;
}

/** 是否为可承载用户话语的文本部分（type "text"、非合成） */
function isUserTextPart(part: ChatPartLike): part is ChatPartLike & { text: string } {
  return part.type === "text" && part.synthetic !== true && typeof part.text === "string";
}

/**
 * 提取用户话语：非合成 text part 的文本按出现顺序以 "\n" 拼接。
 * 无可用文本 → 空串（调用方按无指代处理，no-op）。
 */
export function extractUserPrompt(parts: readonly ChatPartLike[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (isUserTextPart(part)) texts.push(part.text);
  }
  return texts.join("\n");
}

/**
 * 把注入物追加到第一个非合成 text part 的文本尾部（原地突变，append-only）。
 * 成功 → true；无通道或注入物为空 → false（parts 保持原样）。
 */
export function injectIntoParts(parts: readonly ChatPartLike[], context: string): boolean {
  if (context === "") return false;
  for (const part of parts) {
    if (!isUserTextPart(part)) continue;
    part.text = `${part.text}\n\n${context}`;
    return true;
  }
  return false;
}
