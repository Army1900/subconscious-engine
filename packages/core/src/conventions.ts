import type { Candidate, ConventionEntry } from "./types.js";

/**
 * 项目工作惯例·解析侧纯函数（M5c，docs/CONVENTIONS.md §6/§7 + DECISIONS D25）。
 * core 内确定性逻辑，与消歧先验同级（不是新数据源、零 LLM）：
 * - 命中必须带锚：域锚（话语精确包含 expression，不做近义猜测——近义属 embedding 臂）
 *   或唯一锚（裸「照旧」且本项目恰有一条活跃惯例）；
 * - 多惯例无域锚 → 候选列表（ambiguous），绝不静默注入（D-F）；
 * - 衰减：lastHitAt 距今 > 90 天不活跃（读侧过滤）且写时淘汰（存储侧，见 memory.ts）。
 */

/** 惯例注入的授权 sourceId（L1-grant-once，scope = projectKey；撤销 = 删该条授权） */
export const CONVENTIONS_SOURCE_ID = "conventions";
/** 衰减窗口：lastHitAt 距今超过 N 天视为过期（写时淘汰 + 读侧不活跃） */
export const CONVENTION_DECAY_DAYS = 90;
/** 每项目惯例条数上限（写时按 lastHitAt 最旧淘汰） */
export const MAX_CONVENTIONS_PER_PROJECT = 20;
/** 全局惯例条数上限（schema 解析拒绝超限文件；写时同样封顶） */
export const MAX_CONVENTIONS_TOTAL = 200;
/** 惯例名字符上限（与蒸馏提示词一致） */
export const MAX_CONVENTION_EXPRESSION_CHARS = 16;
/** 惯例内容字符上限（与蒸馏提示词一致） */
export const MAX_CONVENTION_CONTENT_CHARS = 120;

const MS_PER_DAY = 86_400_000;

/**
 * 窄否定模式（D-D）：话语否定本次惯例使用（「别按老规矩/这次不用惯例/先别照旧」）
 * 时本轮跳过惯例解析，其余指代照常。窄模式：否定词必须与惯例锚相邻成串，
 * 「别的不说，按老规矩来」「他不停按老规矩办事」不命中。
 */
const CONVENTION_NEGATION_PATTERN = /(别|不)(要|用)?(按|照|依|遵循|沿用)?(老规矩|惯例|照旧)/;

export function conventionNegationMatches(prompt: string): boolean {
  return CONVENTION_NEGATION_PATTERN.test(prompt);
}

/** 域锚匹配：话语精确包含 expression（大小写敏感、原文位置；不做近义扩展） */
export function domainAnchoredConventions(
  prompt: string,
  conventions: readonly ConventionEntry[],
): ConventionEntry[] {
  return conventions.filter((c) => c.expression !== "" && prompt.includes(c.expression));
}

/**
 * 活跃惯例（读侧过滤，D25）：lastHitAt 可解析且距今 ≤ CONVENTION_DECAY 天；
 * 无效时间不可核实即不活跃（不注入半可信条目）；未来时间按当下计（时钟偏移容错）。
 * 与 memory.ts 的写时淘汰同比较器：读侧保证过期惯例即使尚未被写淘汰也不注入。
 */
export function activeConventions(conventions: readonly ConventionEntry[], now: number): ConventionEntry[] {
  const windowMs = CONVENTION_DECAY_DAYS * MS_PER_DAY;
  return conventions.filter((c) => {
    const parsed = Date.parse(c.lastHitAt);
    if (Number.isNaN(parsed)) return false;
    return now - Math.min(parsed, now) <= windowMs;
  });
}

/** 候选按 lastHitAt 降序稳定排序（无效时间排最后）：候选列表最常触达的排前 */
export function rankConventionsByRecency(conventions: readonly ConventionEntry[]): ConventionEntry[] {
  return conventions
    .map((entry, index) => {
      const parsed = Date.parse(entry.lastHitAt);
      return { entry, index, t: Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed };
    })
    .sort((a, b) => b.t - a.t || a.index - b.index)
    .map((x) => x.entry);
}

/** 惯例载荷（ResolvedValue.history-content.diff）：注入的机器可读内容 */
export function conventionPayload(entry: ConventionEntry): string {
  return `${entry.expression} = ${entry.content}`;
}

/** 注入展示（§6.3）：display 注明生成出处与已用次数（透明性，可审计） */
export function conventionDisplay(entry: ConventionEntry): string {
  const origin =
    entry.basedOnSessionTitle !== "" ? `「${entry.basedOnSessionTitle}」会话` : `会话 ${entry.basedOnSessionId}`;
  return `惯例：${entry.expression} = ${entry.content}（惯例·生成于${origin} · 已用 ${entry.hitCount} 次）`;
}

/** 惯例候选（D-F 候选列表用）：label 即完整展示（含出处），value 携带稳定 id 供回写 */
export function conventionCandidate(entry: ConventionEntry): Candidate {
  return {
    id: entry.id,
    label: conventionDisplay(entry),
    value: { type: "history-content", sessionId: entry.basedOnSessionId, diff: conventionPayload(entry) },
  };
}
