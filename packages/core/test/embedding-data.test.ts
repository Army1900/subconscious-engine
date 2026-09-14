import { describe, expect, it } from "vitest";
import { createEmbeddingDetector, type EmbeddingProvider } from "../src/embedding.js";
import { createRuleDetector } from "../src/detector.js";
import {
  DEFAULT_EMBEDDING_EXAMPLES,
  EMBEDDING_EXAMPLES_VERSION,
} from "../src/embedding-examples.js";
import {
  EMBEDDING_EVAL_SET,
  embeddingEvalLeakErrors,
  evaluateRefDetection,
  type EmbeddingEvalCase,
} from "../src/embedding-eval.js";
import type { DanglingRef, DataType } from "../src/types.js";

/**
 * M3 数据层：内置示例集（训练原型）与独立评估集（docs/ACCEPTANCE.md「M3 embedding」行：
 * 评估集不只训练例）。锁定的不变量：
 * - 两套数据中英文兼备、形状合法、互不泄漏（期望指代与训练示例无相等/包含关系）；
 * - 负例不含任何正例期望指代；origin 标注与规则检测器真实行为一致；
 * - 不传 examples 时使用内置默认集；
 * - 固定向量 fixture 上的端到端 precision/recall 达标（分类逻辑，非真实模型泛化——
 *   真实模型评估见 packages/embedding-local/scripts/eval-embedding.mjs）。
 */

// ---------------------------------------------------------------------------
// 固定向量 fixture：关键词词典 → 类型 one-hot（噪声维兜底），token 级精确匹配拉丁词
// ---------------------------------------------------------------------------

const FIXTURE_TYPES: readonly DataType[] = [
  "code-symbol",
  "file",
  "image",
  "project",
  "history-event",
  "history-content",
  "text",
];
const FIXTURE_DIM = FIXTURE_TYPES.length + 1; // 末维 = 无关键词噪声

interface FixtureLexiconEntry {
  readonly type: DataType;
  readonly cjk: readonly string[];
  readonly latin: readonly string[];
}

const FIXTURE_LEXICON: readonly FixtureLexiconEntry[] = [
  { type: "code-symbol", cjk: ["函数", "方法", "代码", "变量", "常量", "接口"], latin: ["function", "method", "code", "variable", "const", "symbol", "snippet", "chunk"] },
  { type: "file", cjk: ["文件", "目录", "文件夹"], latin: ["file", "directory", "folder", "module"] },
  { type: "image", cjk: ["图", "照片", "截图"], latin: ["image", "picture", "photo", "screenshot", "pic"] },
  { type: "project", cjk: ["项目", "工程", "仓库", "代码库"], latin: ["project", "repo", "codebase", "monorepo"] },
  { type: "history-event", cjk: ["上次", "上一", "前一", "刚才", "之前"], latin: ["last", "previous", "earlier"] },
  { type: "history-content", cjk: ["规矩", "套路", "办法", "做法", "照旧", "一样", "同样"], latin: ["usual", "same"] },
  { type: "text", cjk: ["剪贴板", "粘贴", "复制"], latin: ["clipboard", "copied", "pasted"] },
];

function fixtureVector(text: string): readonly number[] {
  const v = new Array<number>(FIXTURE_DIM).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9._'-]+/).filter((t) => t.length > 0);
  let hit = false;
  for (const { type, cjk: cjkKeys, latin: latinKeys } of FIXTURE_LEXICON) {
    const idx = FIXTURE_TYPES.indexOf(type);
    if (idx < 0) continue;
    if (cjkKeys.some((k) => text.includes(k)) || latinKeys.some((k) => tokens.includes(k))) {
      v[idx] = 1;
      hit = true;
    }
  }
  if (!hit) v[FIXTURE_DIM - 1] = 1;
  return v;
}

const fixtureProvider: EmbeddingProvider = {
  id: "fixture:keyword-v1",
  embed: async (text: string) => fixtureVector(text),
};

// ---------------------------------------------------------------------------
// 指标判定统一走 src/embedding-eval.ts 的 evaluateRefDetection（与独立评估脚本同源）
// ---------------------------------------------------------------------------

function evaluate(cases: readonly EmbeddingEvalCase[], predictedOf: (p: string) => readonly DanglingRef[]) {
  return evaluateRefDetection(cases, predictedOf);
}

// ---------------------------------------------------------------------------
// 数据形状与互不泄漏
// ---------------------------------------------------------------------------

describe("内置示例集（训练原型）", () => {
  it("版本号存在且形状合法：非空文本、类型在封闭集、每类 ≥2 条正例", () => {
    expect(EMBEDDING_EXAMPLES_VERSION).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_EMBEDDING_EXAMPLES.length).toBeGreaterThanOrEqual(24);
    const perType = new Map<DataType, number>();
    let negatives = 0;
    for (const ex of DEFAULT_EMBEDDING_EXAMPLES) {
      expect(ex.text.length).toBeGreaterThan(0);
      if (ex.type === "negative") {
        negatives += 1;
        continue;
      }
      perType.set(ex.type, (perType.get(ex.type) ?? 0) + 1);
    }
    expect(perType.size).toBeGreaterThanOrEqual(6);
    for (const [type, count] of perType) {
      expect(count, `类型 ${type} 示例数`).toBeGreaterThanOrEqual(2);
    }
    expect(negatives).toBeGreaterThanOrEqual(8);
  });

  it("中英文短语兼备", () => {
    const hasZh = DEFAULT_EMBEDDING_EXAMPLES.some((e) => /[一-鿿]/.test(e.text));
    const hasEn = DEFAULT_EMBEDDING_EXAMPLES.some((e) => /^[A-Za-z]/.test(e.text));
    expect(hasZh).toBe(true);
    expect(hasEn).toBe(true);
  });
});

describe("独立评估集（held-out）", () => {
  it("规模与形状：≥20 例，正例 ≥12、负例 ≥8，中英文兼备，期望指代必须是 prompt 子串", () => {
    expect(EMBEDDING_EVAL_SET.length).toBeGreaterThanOrEqual(20);
    const positives = EMBEDDING_EVAL_SET.filter((c) => c.expected.length > 0);
    const negatives = EMBEDDING_EVAL_SET.filter((c) => c.expected.length === 0);
    expect(positives.length).toBeGreaterThanOrEqual(12);
    expect(negatives.length).toBeGreaterThanOrEqual(8);
    expect(positives.some((c) => /[一-鿿]/.test(c.prompt))).toBe(true);
    expect(positives.some((c) => !/[一-鿿]/.test(c.prompt))).toBe(true);
    expect(negatives.some((c) => /[一-鿿]/.test(c.prompt))).toBe(true);
    expect(negatives.some((c) => !/[一-鿿]/.test(c.prompt))).toBe(true);
    for (const c of EMBEDDING_EVAL_SET) {
      expect(c.prompt.length).toBeGreaterThan(0);
      for (const e of c.expected) {
        expect(c.prompt.includes(e.text), `期望指代 "${e.text}" 必须在 prompt 中`).toBe(true);
      }
    }
  });

  it("评估集不只训练例：期望指代与训练示例无相等/包含关系（程序化泄漏检查）", () => {
    expect(embeddingEvalLeakErrors(DEFAULT_EMBEDDING_EXAMPLES, EMBEDDING_EVAL_SET)).toEqual([]);
  });

  it("泄漏检查器本身有效：构造泄漏样例必须报错", () => {
    const leaky: readonly EmbeddingEvalCase[] = [
      { prompt: "改一下这个函数", expected: [{ text: "这个函数", type: "code-symbol", origin: "rule" }] },
    ];
    expect(embeddingEvalLeakErrors([{ text: "这个函数", type: "code-symbol" }], leaky).length).toBeGreaterThan(0);
    expect(embeddingEvalLeakErrors([{ text: "那个方法", type: "code-symbol" }], leaky)).toEqual([]);
  });

  it("origin 标注与规则检测器真实行为一致", () => {
    const rule = createRuleDetector();
    for (const c of EMBEDDING_EVAL_SET) {
      const ruleRefs = rule.detect(c.prompt);
      for (const e of c.expected) {
        const at = c.prompt.indexOf(e.text);
        const hit = ruleRefs.some(
          (r) => r.expectedType === e.type && r.span[0] < at + e.text.length && at < r.span[1],
        );
        expect(hit, `"${e.text}" 标注 origin=${e.origin}`).toBe(e.origin === "rule");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 默认示例集接入与端到端指标（固定向量 fixture）
// ---------------------------------------------------------------------------

describe("默认示例集与 fixture 指标", () => {
  it("不传 examples 时使用内置默认集（规则外表述可检出）", async () => {
    const detector = createEmbeddingDetector(fixtureProvider, { thresholds: { accept: 0.6, margin: 0.2 } });
    const refs = await detector.detectAsync("就按老套路再实现一遍");
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs.some((r) => r.expectedType === "history-content")).toBe(true);
  });

  it("fixture 指标：整体 precision/recall ≥ 0.85，embedding 专属子集 recall ≥ 0.8", async () => {
    const detector = createEmbeddingDetector(fixtureProvider, { thresholds: { accept: 0.6, margin: 0.2 } });
    const predictions = new Map<string, readonly DanglingRef[]>();
    for (const c of EMBEDDING_EVAL_SET) {
      predictions.set(c.prompt, await detector.detectAsync(c.prompt));
    }
    const overall = evaluate(EMBEDDING_EVAL_SET, (p) => predictions.get(p) ?? []);
    expect(overall.precision).toBeGreaterThanOrEqual(0.85);
    expect(overall.recall).toBeGreaterThanOrEqual(0.85);

    const embeddingOnly = EMBEDDING_EVAL_SET.map((c) => ({
      prompt: c.prompt,
      expected: c.expected.filter((e) => e.origin === "embedding"),
    })).filter((c) => c.expected.length > 0);
    const sub = evaluate(embeddingOnly, (p) => predictions.get(p) ?? []);
    expect(sub.recall).toBeGreaterThanOrEqual(0.8);
    expect(sub.tp).toBeGreaterThanOrEqual(8); // 确有足够多的规则外样例被检出
  });

  it("规则基线在 embedding 专属子集上检不出（证明评估集确有训练外增量）", () => {
    const rule = createRuleDetector();
    const embeddingOnlyCases = EMBEDDING_EVAL_SET.filter((c) =>
      c.expected.some((e) => e.origin === "embedding"),
    );
    expect(embeddingOnlyCases.length).toBeGreaterThanOrEqual(8);
    const sub = evaluate(
      embeddingOnlyCases.map((c) => ({ prompt: c.prompt, expected: c.expected.filter((e) => e.origin === "embedding") })),
      (p) => rule.detect(p),
    );
    expect(sub.recall).toBeLessThan(0.2); // 规则检测器对这些表述基本无效
  });

  it("evaluateRefDetection 边界：负例的预测即 FP；零预测负例计入句子准确率", () => {
    const cases: readonly EmbeddingEvalCase[] = [
      { prompt: "你好", expected: [] },
      { prompt: "分析这个项目", expected: [{ text: "这个项目", type: "project", origin: "rule" }] },
    ];
    const allCorrect = evaluateRefDetection(cases, (p) =>
      p === "分析这个项目" ? [{ id: "ref-1", span: [2, 6], text: "这个项目", expectedType: "project", confidence: 0.9 }] : [],
    );
    expect(allCorrect.tp).toBe(1);
    expect(allCorrect.fp).toBe(0);
    expect(allCorrect.fn).toBe(0);
    expect(allCorrect.sentenceAccuracy).toBe(1);

    const withFalsePositive = evaluateRefDetection(cases, (p) =>
      p === "你好"
        ? [{ id: "ref-1", span: [0, 2], text: "你好", expectedType: "text", confidence: 0.9 }]
        : [{ id: "ref-1", span: [2, 4], text: "这个", expectedType: "code-symbol", confidence: 0.9 }],
    );
    expect(withFalsePositive.fp).toBe(2); // 负例的预测即 FP；正例上类型不符的重叠预测也是 FP
    expect(withFalsePositive.fn).toBe(1);
    expect(withFalsePositive.falsePositives.map((f) => f.prompt)).toEqual(["你好", "分析这个项目"]);
    expect(withFalsePositive.sentenceAccuracy).toBe(0);
  });
});
