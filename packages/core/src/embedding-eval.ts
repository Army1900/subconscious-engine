import type { EmbeddingExample } from "./embedding.js";
import type { DanglingRef, DataType } from "./types.js";

/**
 * M3 独立评估集（held-out；docs/ACCEPTANCE.md「M3 embedding」行：评估集不只训练例）。
 *
 * 纪律：
 * - 正例 expected.text 必须是 prompt 的真实子串；负例 expected 为空数组；
 * - origin 标注与规则检测器行为一致（"rule" = 规则模板可检出，"embedding" = 规则外表述，
 *   由测试对照 RuleDetector 逐一锁定）；
 * - 期望指代与 DEFAULT_EMBEDDING_EXAMPLES 无相等/包含关系（embeddingEvalLeakErrors 锁定）；
 * - 负例不得包含任何正例期望指代；
 * - 覆盖：中文/英文、Unicode（emoji）、监督 holdout 用例（.supervision/detector-holdout.json
 *   的 positive/negative/m3SeparateFromM1 均已纳入）。
 */

/** 期望指代；origin 记录该表述由规则模板还是仅由 embedding 覆盖 */
export interface EmbeddingEvalRef {
  readonly text: string;
  readonly type: DataType;
  readonly origin: "rule" | "embedding";
}

/** 评估用例；expected 为空即负例（必须零检出） */
export interface EmbeddingEvalCase {
  readonly prompt: string;
  readonly expected: readonly EmbeddingEvalRef[];
  readonly note?: string;
}

export const EMBEDDING_EVAL_SET: readonly EmbeddingEvalCase[] = [
  // ---- 正例：规则覆盖（含监督 holdout 用例与 Unicode）----
  {
    prompt: "把这个函数改成和上次一样的错误处理",
    expected: [
      { text: "这个函数", type: "code-symbol", origin: "rule" },
      { text: "上次", type: "history-event", origin: "rule" },
      { text: "一样的错误处理", type: "history-content", origin: "rule" },
    ],
  },
  {
    prompt: "参考上次的修改改这个文件",
    expected: [
      { text: "上次", type: "history-event", origin: "rule" },
      { text: "这个文件", type: "file", origin: "rule" },
    ],
  },
  { prompt: "看看那张图里面是什么", expected: [{ text: "那张图", type: "image", origin: "rule" }] },
  {
    prompt: "Fix this function using the previous change",
    expected: [
      { text: "this function", type: "code-symbol", origin: "rule" },
      { text: "the previous change", type: "history-event", origin: "rule" },
    ],
  },
  { prompt: "🙂 这个文件还有问题", expected: [{ text: "这个文件", type: "file", origin: "rule" }], note: "Unicode emoji 前缀" },
  {
    prompt: "比较这个文件和那个文件",
    expected: [
      { text: "这个文件", type: "file", origin: "rule" },
      { text: "那个文件", type: "file", origin: "rule" },
    ],
  },
  { prompt: "分析这个项目的结构", expected: [{ text: "这个项目", type: "project", origin: "rule" }] },
  { prompt: "open that pic from the chat", expected: [{ text: "that pic", type: "image", origin: "rule" }] },

  // ---- 正例：规则外表述（embedding 专属增量）----
  { prompt: "就按老套路再实现一遍", expected: [{ text: "老套路", type: "history-content", origin: "embedding" }] },
  {
    prompt: "照老规矩处理这段代码",
    expected: [
      // 老规矩：盲区补齐轮起由规则模板覆盖（前缀动词 + 老规矩），origin 相应翻转为 rule
      { text: "老规矩", type: "history-content", origin: "rule" },
      { text: "这段代码", type: "code-symbol", origin: "embedding" },
    ],
    note: "监督 holdout 用例：老规矩已规则化，这段代码仍为 embedding 专属",
  },
  { prompt: "把这块代码抽出去", expected: [{ text: "这块代码", type: "code-symbol", origin: "embedding" }] },
  { prompt: "回到之前那一版", expected: [{ text: "之前那一版", type: "history-event", origin: "embedding" }] },
  { prompt: "把那批文件都加上头注释", expected: [{ text: "那批文件", type: "file", origin: "embedding" }] },
  { prompt: "这几张图片压缩一下再发", expected: [{ text: "这几张图片", type: "image", origin: "embedding" }] },
  { prompt: "当前这个代码库是什么协议", expected: [{ text: "这个代码库", type: "project", origin: "embedding" }] },
  { prompt: "跟我刚复制的内容对比一下", expected: [{ text: "刚复制的内容", type: "text", origin: "embedding" }] },
  { prompt: "tidy it up the usual way", expected: [{ text: "the usual way", type: "history-content", origin: "embedding" }] },
  { prompt: "照旧再跑一遍构建", expected: [{ text: "照旧", type: "history-content", origin: "rule" }] }, // 规则补齐照旧后迁移（监督者 2026-09-15，同老规矩先例）
  {
    prompt: "把刚才粘贴的那段发我看看",
    expected: [
      { text: "刚才", type: "history-event", origin: "rule" },
      { text: "粘贴的那段", type: "text", origin: "embedding" },
    ],
  },
  { prompt: "还是沿用原来的套路来", expected: [{ text: "原来的套路", type: "history-content", origin: "embedding" }] },
  { prompt: "apply the usual treatment here", expected: [{ text: "the usual treatment", type: "history-content", origin: "embedding" }] },
  {
    prompt: "check the screenshot from our last call",
    expected: [
      { text: "the screenshot", type: "image", origin: "rule" },
      { text: "our last call", type: "history-event", origin: "embedding" },
    ],
  },

  // ---- 正例：内容指代自然表述（盲区补齐轮新增；规则模板与 embedding 措辞均与训练示例不同）----
  { prompt: "错误处理照老规矩来一遍", expected: [{ text: "照老规矩", type: "history-content", origin: "rule" }] },
  { prompt: "把这几个告警照着清理一下", expected: [{ text: "照着清理", type: "history-content", origin: "rule" }] },
  { prompt: "把定好的编码约定补进 README", expected: [{ text: "定好的编码约定", type: "history-content", origin: "rule" }] },
  { prompt: "别偏离当初定下的设计哲学", expected: [{ text: "定下的设计哲学", type: "history-content", origin: "rule" }] },
  {
    prompt: "把咱们之前讨论过的结论落成文档",
    expected: [
      { text: "之前", type: "history-event", origin: "rule" },
      { text: "讨论过的结论", type: "history-content", origin: "rule" },
    ],
  },
  {
    prompt: "把上次碰撞出的点子挑两个做原型",
    expected: [
      { text: "上次", type: "history-event", origin: "rule" },
      { text: "碰撞出的点子", type: "history-content", origin: "rule" },
    ],
  },
  {
    prompt: "上次那个错误处理的改造也补了测试",
    expected: [
      { text: "上次", type: "history-event", origin: "rule" },
      { text: "错误处理的改造", type: "history-content", origin: "rule" },
    ],
  },
  { prompt: "还是沿用咱们那套做法", expected: [{ text: "咱们那套做法", type: "history-content", origin: "embedding" }] },
  { prompt: "把咱们聊出来的那套思路往下推", expected: [{ text: "聊出来的那套思路", type: "history-content", origin: "embedding" }] },
  { prompt: "handle it same as our discussion", expected: [{ text: "same as our discussion", type: "history-content", origin: "embedding" }] },
  {
    prompt: "stick to the principles we agreed on when naming things",
    expected: [{ text: "principles we agreed on", type: "history-content", origin: "embedding" }],
  },

  // ---- 负例（必须零检出；含监督 holdout 负例）----
  { prompt: "你好", expected: [] },
  { prompt: "解释快速排序", expected: [] },
  { prompt: "This is a test", expected: [] },
  { prompt: "I like that idea", expected: [] },
  { prompt: "lastIndexOf 的复杂度是多少？", expected: [], note: "API 名含 last，不得按词片段误检" },
  { prompt: "今天天气怎么样", expected: [] },
  { prompt: "现在几点了", expected: [] },
  { prompt: "帮我生成一个随机密码", expected: [] },
  { prompt: "请创建一个叫 demo 的脚本", expected: [] },
  { prompt: "what is the capital of France", expected: [] },
  { prompt: "run the tests now", expected: [] },
  { prompt: "please wait a moment", expected: [] },

  // ---- 负例（盲区补齐轮新增：哲学/闲聊/外部参照物不误触）----
  { prompt: "我喜欢讨论那些想法", expected: [], note: "惯常讨论（无体验态\"过/出\"），非历史内容指代" },
  { prompt: "最近在读斯多葛哲学，蛮治愈的", expected: [], note: "哲学闲聊（读书感想），非定下的设计哲学" },
  { prompt: "照着说明书装家具挺解压的", expected: [], note: "外部参照物（说明书+装），非照着既有内容清理" },
  { prompt: "周末去爬山，风景真不错", expected: [], note: "纯闲聊" },
];

/**
 * 程序化泄漏检查（评估有效性前提）：
 * - 任何用例 prompt 不得与训练示例逐字相同；
 * - 任何期望指代文本不得与训练示例相等或互为包含（词级共享是允许的泛化）；
 * - 负例 prompt 不得包含任何正例期望指代文本。
 * 返回错误清单；空数组 = 通过。
 */
export function embeddingEvalLeakErrors(
  examples: readonly EmbeddingExample[],
  cases: readonly EmbeddingEvalCase[],
): readonly string[] {
  const errors: string[] = [];
  const overlaps = (a: string, b: string): boolean => a === b || a.includes(b) || b.includes(a);
  for (const c of cases) {
    for (const ex of examples) {
      if (c.prompt === ex.text) {
        errors.push(`prompt 与训练示例逐字相同："${c.prompt}"`);
      }
    }
    for (const e of c.expected) {
      for (const ex of examples) {
        if (overlaps(e.text, ex.text)) {
          errors.push(`期望指代 "${e.text}" 与训练示例 "${ex.text}" 重叠（prompt："${c.prompt}"）`);
        }
      }
    }
  }
  const expectedTexts = cases.flatMap((c) => c.expected.map((e) => e.text));
  for (const c of cases) {
    if (c.expected.length > 0) continue;
    for (const text of expectedTexts) {
      if (c.prompt.includes(text)) {
        errors.push(`负例 "${c.prompt}" 包含正例期望指代 "${text}"`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 判定指标（检测器评估的唯一事实源：核心测试、独立评估脚本、embedding-local 测试共用）
// ---------------------------------------------------------------------------

export interface RefDetectionMetrics {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  /** 预测集合与期望集合完全一致（零 FP 且零 FN）的用例占比 */
  readonly sentenceAccuracy: number;
  readonly caseCount: number;
  /** FP 明细（prompt + 预测文本 + 类型），供评估报告与回归排查 */
  readonly falsePositives: ReadonlyArray<{ prompt: string; text: string; type: DataType }>;
}

/**
 * 指代检测判定：命中（TP）= 预测与期望 span 重叠且类型一致；
 * 一对一贪心匹配（一个期望至多匹配一个预测）；负例（expected 为空）的任何预测都是 FP。
 */
export function evaluateRefDetection(
  cases: readonly EmbeddingEvalCase[],
  predictedOf: (prompt: string) => readonly DanglingRef[],
): RefDetectionMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let exact = 0;
  const falsePositives: Array<{ prompt: string; text: string; type: DataType }> = [];
  for (const c of cases) {
    const predicted = predictedOf(c.prompt);
    const matched = new Set<number>();
    let caseExact = predicted.length === c.expected.length;
    for (const p of predicted) {
      const idx = c.expected.findIndex((e, i) => {
        if (matched.has(i) || e.type !== p.expectedType) return false;
        const at = c.prompt.indexOf(e.text);
        return at >= 0 && p.span[0] < at + e.text.length && at < p.span[1];
      });
      if (idx >= 0) {
        matched.add(idx);
        tp += 1;
      } else {
        fp += 1;
        caseExact = false;
        falsePositives.push({ prompt: c.prompt, text: p.text, type: p.expectedType });
      }
    }
    if (c.expected.length !== matched.size) caseExact = false;
    fn += c.expected.length - matched.size;
    if (caseExact) exact += 1;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    sentenceAccuracy: cases.length === 0 ? 1 : exact / cases.length,
    caseCount: cases.length,
    falsePositives,
  };
}
