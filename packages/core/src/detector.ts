import type { AsyncDetector, DanglingRef, DataType, Detector } from "./types.js";

/**
 * 规则版指代检测器（M1；DESIGN §4.1）。
 *
 * 纪律：
 * - 只检测话语中显式出现的指代（指示词 + 封闭类型名词模板），不预测用户没说的需求。
 * - 输出带 span 与置信度；低置信在引擎侧被丢弃（透传而非猜测）。
 * - 检测器自身永不抛出：任何输入异常都返回空列表（fail-open 的第一环）。
 *
 * 误检/漏检的风险模型：漏检 = 退化为现状（无害）；误检由置信度阈值与注入可见性兜底。
 */

interface RefPattern {
  readonly source: string;
  readonly flags: string;
  readonly type: DataType;
  readonly confidence: number;
}

/**
 * 模板表。中英文指示词 → 期望数据类型。
 * 中文不使用 \b（CJK 无词边界），依赖"指示词 + 封闭名词表"双条件降低误检；
 * 英文使用 \b 且名词表封闭，"lastIndexOf / previousValue / this-file.txt" 类标识符不触发。
 */
const PATTERNS: readonly RefPattern[] = [
  // ---- 中文：code-symbol ----
  { source: "(这个|那个|此|该)(函数|方法|变量|常量)", flags: "g", type: "code-symbol", confidence: 0.95 },
  // ---- 中文：file ----
  { source: "(这个|那个|此|该)(文件|目录|文件夹)", flags: "g", type: "file", confidence: 0.95 },
  // ---- 中文：image（"那张图""这个截图"）----
  { source: "(这|那)(张|幅|个)(图片|照片|截图|图)", flags: "g", type: "image", confidence: 0.9 },
  // ---- 中文：project（cwd-context 可达入口）----
  { source: "(这个|当前|本)(项目|工程|仓库)", flags: "g", type: "project", confidence: 0.9 },
  { source: "(当前|本)(目录)", flags: "g", type: "project", confidence: 0.8 },
  { source: "(剪贴板|粘贴板)(内容)?", flags: "g", type: "text", confidence: 0.9 },
  // ---- 中文：history-event ----
  { source: "(上一次|上次|上一回|上回|刚才)", flags: "g", type: "history-event", confidence: 0.85 },
  // ---- 中文：history-content（"一样的错误处理""和上次一样"）
  //      尾部内容词有界（≤10 个连续文字字符），不跨标点/空格 ----
  { source: "(一样|同样)(的)?[\\u4e00-\\u9fffA-Za-z0-9]{0,10}", flags: "g", type: "history-content", confidence: 0.85 },
  // ---- 英文：code-symbol ----
  { source: "\\bthis (function|method|class|variable|const|symbol)\\b", flags: "gi", type: "code-symbol", confidence: 0.9 },
  // ---- 英文：file ----
  { source: "\\b(this|that) (file|directory|folder|module)\\b", flags: "gi", type: "file", confidence: 0.9 },
  // ---- 英文：image ----
  { source: "\\b(this|that|the) (image|picture|photo|screenshot|pic)\\b", flags: "gi", type: "image", confidence: 0.85 },
  // ---- 英文：project ----
  { source: "\\b(this|the current) project\\b", flags: "gi", type: "project", confidence: 0.85 },
  { source: "\\b(the )?clipboard( contents?)?\\b", flags: "gi", type: "text", confidence: 0.9 },
  // ---- 英文：history-event（要求 the + 序指示 + 事件名词，避免 "lastIndexOf" 类误检）----
  {
    source: "\\bthe (last|previous|most recent) (change|session|conversation|commit|edit|fix|modification|message)\\b",
    flags: "gi",
    type: "history-event",
    confidence: 0.85,
  },
  // ---- 英文：history-content ----
  {
    source: "\\b(same as (last|previous) time|like (last|previous) time|the same way as before)\\b",
    flags: "gi",
    type: "history-content",
    confidence: 0.8,
  },
];

interface RawMatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly type: DataType;
  readonly confidence: number;
}

function collectMatches(prompt: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const pattern of PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1; // 防御零长匹配死循环
        continue;
      }
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        type: pattern.type,
        confidence: pattern.confidence,
      });
    }
  }
  return matches;
}

/** 重叠消解：按 start 升序、长度降序贪心保留互不重叠的匹配（先到先得，长者优先） */
function resolveOverlaps(matches: readonly RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const accepted: RawMatch[] = [];
  let lastEnd = -1;
  for (const m of sorted) {
    if (m.start >= lastEnd) {
      accepted.push(m);
      lastEnd = m.end;
    }
  }
  return accepted;
}

/** 规则版检测器。无状态、可复用、永不抛出 */
export class RuleDetector implements Detector {
  detect(prompt: string): readonly DanglingRef[] {
    if (typeof prompt !== "string" || prompt.length === 0) return [];
    let matches: RawMatch[];
    try {
      matches = collectMatches(prompt);
    } catch {
      return [];
    }
    const refs = resolveOverlaps(matches).map((m, i): DanglingRef => {
      const span: readonly [number, number] = [m.start, m.end];
      return { id: `ref-${i + 1}`, span, text: m.text, expectedType: m.type, confidence: m.confidence };
    });
    return refs;
  }
}

export function createRuleDetector(): RuleDetector {
  return new RuleDetector();
}

/**
 * 结构探测：是否为异步增强检测器（M3，AsyncDetector）。
 * 引擎据此选择共享机器预算的异步检测路径；仅同步 Detector 时走原路径，行为与 M1 一致。
 */
export function isAsyncDetector(detector: Detector): detector is AsyncDetector {
  return typeof (detector as Partial<AsyncDetector>).detectAsync === "function";
}
