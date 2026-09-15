import { isAsyncDetector } from "./detector.js";
import { isPersonalPhrase } from "./memory.js";
import type { AsyncDetector, DanglingRef, DataType, Detector, PersonalPhrase } from "./types.js";

/**
 * 个人惯用语词典·运行时检测扩展（M5a，D24）。
 *
 * 把显式注册的个人短语（{短语 → 期望类型}）作为检测层扩展并入任意检测器：
 * - 精确匹配（大小写敏感、按原文出现位置命中），命中产出带真实 span 的 DanglingRef，
 *   后续走正常解析——词典只在"用户说出口"（短语出现在话语中）时触发，
 *   不改变无指代零开销透传（DESIGN §11.3 预测注入红线）。
 * - 与基座（规则/embedding）命中重叠时**个人短语优先**（显式注册强于通用规则）；
 *   非重叠命中合并，按出现位置排序，统一重编 id。
 * - 出厂示例/规则词典零改动；零合法词条时不包装，返回基座本身（行为逐字节一致）。
 * - 基座为 AsyncDetector（M3 embedding）时同样包装 detectAsync；基座任何故障不连坐
 *   短语命中（fail-open，同步契约恒可用）。
 */

/** 个人短语的置信度：显式注册是用户给的最强信号，取规则模板同级的 0.95 */
export const PERSONAL_PHRASE_CONFIDENCE = 0.95;

interface PhraseHit {
  readonly start: number;
  readonly end: number;
  readonly type: DataType;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/** 枚举所有词条的全部出现位置（同词条出现按进度互不重叠） */
function collectPhraseHits(prompt: string, phrases: readonly PersonalPhrase[]): PhraseHit[] {
  const hits: PhraseHit[] = [];
  for (const entry of phrases) {
    if (!isPersonalPhrase(entry)) continue; // 非法词条跳过，不抛出（fail-open）
    const phrase = entry.phrase;
    let from = 0;
    for (;;) {
      const at = prompt.indexOf(phrase, from);
      if (at < 0) break;
      hits.push({ start: at, end: at + phrase.length, type: entry.expectedType });
      from = at + phrase.length;
    }
  }
  return hits;
}

/** 词条间重叠消解：start 升序、长者优先贪心保留（同规则版纪律） */
function resolvePhraseOverlaps(hits: readonly PhraseHit[]): PhraseHit[] {
  const sorted = [...hits].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const accepted: PhraseHit[] = [];
  let lastEnd = -1;
  for (const hit of sorted) {
    if (hit.start >= lastEnd) {
      accepted.push(hit);
      lastEnd = hit.end;
    }
  }
  return accepted;
}

function overlapsRange(start1: number, end1: number, start2: number, end2: number): boolean {
  return start1 < end2 && start2 < end1;
}

function isSpanLike(span: unknown): span is readonly [number, number] {
  return (
    Array.isArray(span) &&
    span.length === 2 &&
    typeof span[0] === "number" &&
    typeof span[1] === "number" &&
    span[0] >= 0 &&
    span[1] > span[0]
  );
}

/** 个人短语命中 + 基座命中合并：个人优先消重叠，按出现位置排序，统一重编 id */
function mergeRefs(prompt: string, hits: readonly PhraseHit[], baseRefs: readonly DanglingRef[]): DanglingRef[] {
  const personal = hits.map(
    (hit, i): DanglingRef => ({
      id: `personal-${i + 1}`,
      span: [hit.start, hit.end],
      text: prompt.slice(hit.start, hit.end),
      expectedType: hit.type,
      confidence: PERSONAL_PHRASE_CONFIDENCE,
    }),
  );
  const kept = baseRefs.filter((ref) => {
    if (!isRecord(ref) || !isSpanLike(ref.span)) return false;
    return !hits.some((hit) => overlapsRange(ref.span[0], ref.span[1], hit.start, hit.end));
  });
  return [...personal, ...kept]
    .sort((a, b) => a.span[0] - b.span[0])
    .map((ref, i) => ({ ...ref, id: `ref-${i + 1}` }));
}

/** 把个人惯用语词典并入任意检测器；零合法词条时原样返回基座 */
export function createPersonalPhraseDetector(base: Detector, phrases: readonly PersonalPhrase[]): Detector {
  const valid = phrases.filter(isPersonalPhrase);
  if (valid.length === 0) return base;

  const hitsOf = (prompt: string): PhraseHit[] =>
    typeof prompt === "string" && prompt.length > 0 ? resolvePhraseOverlaps(collectPhraseHits(prompt, valid)) : [];

  const detect = (prompt: string): readonly DanglingRef[] => {
    let baseRefs: readonly DanglingRef[] = [];
    try {
      const result = base.detect(prompt);
      baseRefs = Array.isArray(result) ? result : [];
    } catch {
      baseRefs = []; // 基座抛错不连坐短语命中（fail-open）
    }
    return mergeRefs(prompt, hitsOf(prompt), baseRefs);
  };

  if (isAsyncDetector(base)) {
    const asyncBase: AsyncDetector = base;
    const wrapped: AsyncDetector = {
      detect,
      async detectAsync(prompt, ctx) {
        const result = await asyncBase.detectAsync(prompt, ctx);
        return mergeRefs(prompt, hitsOf(prompt), Array.isArray(result) ? result : []);
      },
    };
    return wrapped;
  }
  return { detect };
}
