import type { DataSource, Resolution, SessionChange, SessionRecord } from "../types.js";
import { snippetBlock, truncate } from "../text.js";

const NOT_FOUND: Resolution = { status: "not-found" };

function isChange(c: unknown): c is SessionChange {
  if (c === null || typeof c !== "object") return false;
  const v = c as Partial<SessionChange>;
  if (v.tool !== "edit" && v.tool !== "write") return false;
  if (typeof v.at !== "string") return false;
  return true;
}

interface DiffSummary {
  text: string;
  used: number;
  total: number;
  truncated: boolean;
}

function formatChange(n: number, change: SessionChange, snippetChars: number): string {
  const where = change.path !== undefined && change.path !== "" ? change.path : "（未提供路径）";
  const head = `${n}. ${change.tool} ${where}`;
  if (change.tool === "edit") {
    const oldText = snippetBlock(change.oldText ?? "", snippetChars);
    const newText = snippetBlock(change.newText ?? "", snippetChars);
    return `${head}\n  - ${oldText}\n  + ${newText}`;
  }
  const content = snippetBlock(change.content ?? "", snippetChars);
  return `${head}\n  + ${content}`;
}

/** 有界 diff 摘要：条数、单条长度、总长三重上限（D8.2）；isError 跳过（D9） */
function buildDiffSummary(changes: readonly SessionChange[], limits: {
  maxDiffEntries: number;
  maxDiffSnippetChars: number;
  maxDiffChars: number;
}): DiffSummary {
  const usable = changes
    .filter((c) => isChange(c) && c.isError !== true)
    .map((c, i) => ({ c, i, t: Date.parse(c.at) }))
    .sort((a, b) => {
      // 时间升序（旧→新）；无效时间排最后，原始顺序稳定
      const av = Number.isNaN(a.t) ? Number.POSITIVE_INFINITY : a.t;
      const bv = Number.isNaN(b.t) ? Number.POSITIVE_INFINITY : b.t;
      if (av !== bv) return av - bv;
      return a.i - b.i;
    })
    .map((x) => x.c);

  const capped = usable.slice(0, limits.maxDiffEntries);
  const lines: string[] = [];
  let total = 0;
  let truncated = capped.length < usable.length;
  for (let i = 0; i < capped.length; i += 1) {
    const entry = formatChange(i + 1, capped[i] as SessionChange, limits.maxDiffSnippetChars);
    if (total + entry.length > limits.maxDiffChars) {
      truncated = true;
      break;
    }
    lines.push(entry);
    total += entry.length;
  }
  return { text: lines.join("\n"), used: lines.length, total: usable.length, truncated };
}

/**
 * `session-content`（L0，类型 history-content；DESIGN §4.2、D4、D9）。
 * - 只在 ctx.boundSession 存在（wave 1 已解析/用户已选择稳定会话 id）时读取；
 *   引擎侧无绑定时不会调用本源，此处返回 not-found 是双保险（D4.2）。
 * - 读取按绑定的 SessionRef（id + path）定位，不凭任意 ID 拼路径。
 * - 提取 edit/write 的 old/new/content 构造确定性 diff 摘要，跳过 isError，不做语义筛选。
 */
export const sessionContentSource: DataSource = {
  id: "session-content",
  types: ["history-content"],
  permission: "L0-free",
  async resolve(ref, env, ctx): Promise<Resolution> {
    if (ref.expectedType !== "history-content") return NOT_FOUND;
    const bound = ctx.boundSession;
    if (bound === undefined || typeof bound.id !== "string" || bound.id.trim() === "") return NOT_FOUND;
    if (typeof env.readSessionContent !== "function") return NOT_FOUND;

    let record: SessionRecord | null = null;
    try {
      record = await env.readSessionContent(bound, { signal: ctx.signal, maxBytes: ctx.limits.maxSourceBytes });
    } catch {
      return NOT_FOUND;
    }
    if (record === null || typeof record !== "object" || typeof record.sessionId !== "string") return NOT_FOUND;
    // 稳定绑定红线（监督 review-01 13:19）：返回记录必须属于绑定会话本身；
    // 错误或恶意 provider 返回另一会话的内容时按 not-found 丢弃，绝不注入。
    if (record.sessionId !== bound.id) return NOT_FOUND;
    if (!Array.isArray(record.changes)) return NOT_FOUND;

    const diff = buildDiffSummary(record.changes, ctx.limits);
    if (diff.used === 0) return NOT_FOUND; // 绑定会话中无可用的修改记录，诚实放弃

    const title = bound.title !== undefined && bound.title !== "" ? `「${bound.title}」` : "";
    const note = diff.truncated ? "，已截断" : "";
    const display = `绑定会话 ${bound.id}${title}的修改记录（${diff.used}/${diff.total} 处${note}）：\n${diff.text}`;
    return {
      status: "resolved",
      value: { type: "history-content", sessionId: bound.id, diff: truncate(diff.text, ctx.limits.maxDiffChars) },
      display,
    };
  },
};
