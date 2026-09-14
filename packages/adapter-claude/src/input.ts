/**
 * Claude Code hook stdin 输入解析（DESIGN §7.3、docs/ACCEPTANCE「Claude」行）。
 *
 * 协议事实（官方 hooks reference，https://docs.claude.com/en/docs/claude-code/hooks，
 * 2026-09-14 核实）：hook 经 stdin 收 JSON，UserPromptSubmit 事件字段为
 * session_id / transcript_path / cwd / permission_mode / hook_event_name / prompt。
 *
 * 解析纪律：
 * - 只认 UserPromptSubmit（本适配器唯一插入点）；其他事件 → null（no-op 透传）。
 * - cwd 只取输入字段，缺失/空/非字符串 → null（不回退 process.cwd()，不猜测）。
 * - session_id / transcript_path 缺失时诚实置空：对应能力（会话目录）降级不可用，
 *   不是错误——fail-open 表现为「没生效」而不是失败。
 * - 永不抛出：任何非法输入 → null，由入口输出空、退出 0（DESIGN §5.3）。
 */

/** UserPromptSubmit hook 输入（官方字段中本适配器消费的子集） */
export interface ClaudeHookInput {
  readonly hookEventName: "UserPromptSubmit";
  /** 官方 session_id；缺失置空（当前会话排除逻辑随之关闭） */
  readonly sessionId: string;
  /** 官方 transcript_path；缺失/相对路径置空（recent-sessions 随之不可用） */
  readonly transcriptPath: string;
  readonly cwd: string;
  readonly prompt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function optionalString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function parseUserPromptSubmitInput(raw: string): ClaudeHookInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.hook_event_name !== "UserPromptSubmit") return null;
  if (typeof parsed.cwd !== "string" || parsed.cwd.trim() === "") return null;
  if (typeof parsed.prompt !== "string") return null;
  return {
    hookEventName: "UserPromptSubmit",
    sessionId: optionalString(parsed.session_id),
    transcriptPath: optionalString(parsed.transcript_path),
    cwd: parsed.cwd,
    prompt: parsed.prompt,
  };
}
