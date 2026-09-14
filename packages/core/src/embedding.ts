import { createRuleDetector } from "./detector.js";
import { DEFAULT_EMBEDDING_EXAMPLES } from "./embedding-examples.js";
import { EngineConfigError, errorMessage } from "./errors.js";
import { isDataType } from "./registry.js";
import type { AsyncDetector, DanglingRef, DataType, Detector, DetectorContext, Logger } from "./types.js";

/**
 * M3 embedding 检测器（DESIGN §4.1 演进第 2 步）。
 *
 * 设计要点：
 * - 与规则检测器实现同一 Detector 接口：同步 detect() 恒等于其规则回退的输出
 *   （同步契约无法等待向量推理，fail-open 直接落规则）；异步 detectAsync() 做
 *   「短语向量 → 类型原型近邻分类」，覆盖规则词典外的显式表述（如「照老规矩」）。
 * - 向量来源由 EmbeddingProvider 注入，core 零依赖；真实本地模型实现在独立可选包
 *   （@subconscious/embedding-local），未安装/加载失败/维度不匹配一律回退规则检测器。
 * - 原型向量 = 版本化示例集经同一 provider 就地嵌入后的归一化均值（模型无关，
 *   维度自洽）；分类 = 余弦最近原型 + negative 原型 margin 门（误检防线）。
 * - 置信度 = 0.5 + 0.5×(sim−accept)/(1−accept)（accept→0.5，sim→1→1.0，单调、可复现）。
 * - 与规则结果合并：重叠区间规则优先（模板精度高），非重叠 embedding 补充。
 */

// ---------------------------------------------------------------------------
// 向量与 provider 抽象
// ---------------------------------------------------------------------------

/** Safe cosine similarity for optional local embedding providers. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!, y = b[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y; left += x * x; right += y * y;
  }
  if (left === 0 || right === 0) return null;
  return dot / Math.sqrt(left * right);
}

/** 嵌入向量（有限数、非空、维度与原型一致由调用方校验） */
export type EmbeddingVector = readonly number[];

/** 可注入的本地向量 provider（进程内、离线；真实实现见 @subconscious/embedding-local） */
export interface EmbeddingProvider {
  /** 稳定标识（评估与日志溯源用），如 "fixture:keyword-v1" / "transformers:模型名" */
  readonly id: string;
  embed(text: string): Promise<EmbeddingVector>;
}

// ---------------------------------------------------------------------------
// 示例与配置
// ---------------------------------------------------------------------------

/** 示例标签：封闭类型集之一，或 negative（非指代短语，误检防线原型） */
export type EmbeddingExampleLabel = DataType | "negative";

/** 版本化示例集的一条：短语 → 期望类型（或 negative） */
export interface EmbeddingExample {
  readonly text: string;
  readonly type: EmbeddingExampleLabel;
}

/** 分类阈值：accept = 最近类型原型的最低余弦；margin = 对 negative/次类的最小领先 */
export interface EmbeddingThresholds {
  readonly accept: number;
  readonly margin: number;
}

export interface EmbeddingDetectorOptions {
  /** 版本化示例集；缺省使用内置 DEFAULT_EMBEDDING_EXAMPLES（见 embedding-examples.ts） */
  readonly examples?: readonly EmbeddingExample[];
  /** 部分覆盖默认阈值（accept∈(0,1)，margin∈[0,1]） */
  readonly thresholds?: Partial<EmbeddingThresholds>;
  /** 规则回退检测器，默认独立 RuleDetector */
  readonly fallback?: Detector;
  /** 单次话语最多参与分类的候选短语数（默认 48） */
  readonly maxCandidates?: number;
  /** 超过该长度的原话不走 embedding（默认 280 字符），直接规则回退 */
  readonly maxPromptChars?: number;
  /** 机器预算低于该值时停止 embed（默认 300ms），本次规则回退 */
  readonly budgetReserveMs?: number;
  /** provider 失败（抛错/非法向量/维度不匹配）次数达到上限后永久回退规则（默认 3） */
  readonly maxProviderFailures?: number;
  /** 日志（回退与禁用事件被吞掉前记录） */
  readonly logger?: Logger;
}

/**
 * 默认阈值（在真实本地模型 Xenova/paraphrase-multilingual-MiniLM-L12-v2 上按
 * EMBEDDING_EVAL_SET 扫描调定：accept 0.65 / margin 0.1 → P 96.4% / R 90.0% / F1 93.1%；
 * margin > 0.1 在该模型上会大幅损失召回，见 packages/embedding-local/scripts/eval-embedding.mjs）。
 */
export const DEFAULT_EMBEDDING_THRESHOLDS: Readonly<EmbeddingThresholds> = { accept: 0.65, margin: 0.1 };
const DEFAULT_MAX_CANDIDATES = 48;
const DEFAULT_MAX_PROMPT_CHARS = 280;
const DEFAULT_BUDGET_RESERVE_MS = 300;
const DEFAULT_MAX_PROVIDER_FAILURES = 3;
const CJK_WINDOW_MIN = 2;
const CJK_WINDOW_MAX = 6;
const LATIN_NGRAM_MAX = 4;

// ---------------------------------------------------------------------------
// 配置校验（构造期受控失败，对齐 createEngine 的 limits 校验纪律）
// ---------------------------------------------------------------------------

function validateExamples(examples: readonly EmbeddingExample[]): void {
  if (!Array.isArray(examples) || examples.length === 0) {
    throw new EngineConfigError("invalid-detector-options", "embedding examples 必须是非空数组");
  }
  let hasPositive = false;
  for (const ex of examples) {
    if (ex === null || typeof ex !== "object" || typeof ex.text !== "string" || ex.text.length === 0) {
      throw new EngineConfigError("invalid-detector-options", "embedding example 的 text 必须是非空字符串");
    }
    if (ex.type !== "negative" && !isDataType(ex.type)) {
      throw new EngineConfigError("invalid-detector-options", `embedding example 类型非法：${String(ex.type)}`);
    }
    if (ex.type !== "negative") hasPositive = true;
  }
  if (!hasPositive) {
    throw new EngineConfigError("invalid-detector-options", "embedding examples 至少需要一条非 negative 示例");
  }
}

function validateOptions(options: EmbeddingDetectorOptions): void {
  const t = options.thresholds;
  if (t !== undefined) {
    const accept = t.accept ?? DEFAULT_EMBEDDING_THRESHOLDS.accept;
    const margin = t.margin ?? DEFAULT_EMBEDDING_THRESHOLDS.margin;
    if (!(accept > 0 && accept < 1)) {
      throw new EngineConfigError("invalid-detector-options", `thresholds.accept 必须在 (0,1)（得到 ${accept}）`);
    }
    if (!(margin >= 0 && margin <= 1)) {
      throw new EngineConfigError("invalid-detector-options", `thresholds.margin 必须在 [0,1]（得到 ${margin}）`);
    }
  }
  if (options.examples !== undefined) validateExamples(options.examples);
  if (options.maxCandidates !== undefined && (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1)) {
    throw new EngineConfigError("invalid-detector-options", "maxCandidates 必须是正整数");
  }
  if (options.maxPromptChars !== undefined && (!Number.isInteger(options.maxPromptChars) || options.maxPromptChars < 1)) {
    throw new EngineConfigError("invalid-detector-options", "maxPromptChars 必须是正整数");
  }
  if (options.budgetReserveMs !== undefined && (typeof options.budgetReserveMs !== "number" || !(options.budgetReserveMs >= 0))) {
    throw new EngineConfigError("invalid-detector-options", "budgetReserveMs 必须是非负数");
  }
  if (options.maxProviderFailures !== undefined && (!Number.isInteger(options.maxProviderFailures) || options.maxProviderFailures < 1)) {
    throw new EngineConfigError("invalid-detector-options", "maxProviderFailures 必须是正整数");
  }
}

// ---------------------------------------------------------------------------
// 向量工具
// ---------------------------------------------------------------------------

function isFiniteVector(v: unknown): v is EmbeddingVector {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/** L2 归一化；零向量返回空数组（按非法处理，余弦对零向量本就无定义） */
function normalize(v: readonly number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return [];
  return v.map((x) => x / norm);
}

/** 各向量先归一化再求均值再归一化（每条示例等权） */
function meanDirection(vectors: readonly (readonly number[])[]): number[] | null {
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) return null;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    const unit = normalize(v);
    if (unit.length !== dim) return null;
    for (let i = 0; i < dim; i += 1) sum[i] = sum[i]! + unit[i]!;
  }
  return normalize(sum);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** embed 与中止信号的 race：signal 中止 → null；provider rejection 原样传播给调用方记录 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort); // 先到：摘掉监听器（D16 对称清理）
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err); // 若 abort 已获胜，此处 reject 是 no-op；迟到 rejection 由调用方 catch
      },
    );
  });
}

// ---------------------------------------------------------------------------
// 原型空间
// ---------------------------------------------------------------------------

interface PrototypeSpace {
  readonly dimension: number;
  readonly positives: ReadonlyMap<DataType, EmbeddingVector>;
  readonly negative: EmbeddingVector | null;
}

type InitOutcome =
  | { ok: true; space: PrototypeSpace }
  | { ok: false; reason: "provider-failure" | "stopped" };

// ---------------------------------------------------------------------------
// 候选短语生成（确定性；CJK 滑窗 + 拉丁词 n-gram）
// ---------------------------------------------------------------------------

interface CandidateSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function isCjkUnit(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

function isWordUnit(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2e || // . （this-file.txt / 3.14 视作单词内部）
    code === 0x5f || // _
    code === 0x27 || // '
    code === 0x2d // -
  );
}

function generateCandidates(prompt: string, maxCandidates: number): readonly CandidateSpan[] {
  const out: CandidateSpan[] = [];
  const tokens: CandidateSpan[] = []; // 拉丁词元（start/end 即词位）
  const len = prompt.length;
  let i = 0;
  while (i < len) {
    const code = prompt.charCodeAt(i);
    if (isCjkUnit(code)) {
      let j = i + 1;
      while (j < len && isCjkUnit(prompt.charCodeAt(j))) j += 1;
      for (let s = i; s < j; s += 1) {
        for (let w = CJK_WINDOW_MAX; w >= CJK_WINDOW_MIN; w -= 1) {
          const e = s + w;
          if (e <= j) out.push({ start: s, end: e, text: prompt.slice(s, e) });
        }
      }
      i = j;
    } else if (isWordUnit(code)) {
      let j = i + 1;
      while (j < len && isWordUnit(prompt.charCodeAt(j))) j += 1;
      tokens.push({ start: i, end: j, text: prompt.slice(i, j) });
      i = j;
    } else {
      i += 1; // 分隔符/emoji/标点（代理对按两个非词码元跳过，窗口不会切断 emoji）
    }
  }
  // 拉丁词 n-gram（1..4 词，跨词拼接仅允许纯空白间隔）
  for (let a = 0; a < tokens.length; a += 1) {
    for (let n = 1; n <= LATIN_NGRAM_MAX && a + n - 1 < tokens.length; n += 1) {
      const first = tokens[a]!;
      const last = tokens[a + n - 1]!;
      if (n > 1 && !/^\s+$/.test(prompt.slice(tokens[a + n - 2]!.end, last.start))) break;
      out.push({ start: first.start, end: last.end, text: prompt.slice(first.start, last.end) });
    }
  }
  return capCandidates(out, maxCandidates);
}

/** 超上限时等步长抽样（保序、含首尾可达，确定性覆盖全句） */
function capCandidates(candidates: readonly CandidateSpan[], max: number): readonly CandidateSpan[] {
  if (candidates.length <= max) return candidates;
  const stride = Math.ceil(candidates.length / max);
  const kept: CandidateSpan[] = [];
  for (let k = 0; k < candidates.length && kept.length < max; k += stride) {
    kept.push(candidates[k]!);
  }
  const last = candidates[candidates.length - 1]!;
  if (kept.length < max && !kept.includes(last)) kept.push(last);
  return kept;
}

// ---------------------------------------------------------------------------
// 分类与合并
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly type: DataType;
  readonly confidence: number;
}

/** 余弦最近原型 + negative/次类 margin 门；返回 null = 拒绝（透传，不猜测） */
function classifyByPrototypes(
  vec: EmbeddingVector,
  space: PrototypeSpace,
  thresholds: EmbeddingThresholds,
): { type: DataType; confidence: number } | null {
  let bestType: DataType | null = null;
  let bestSim = Number.NEGATIVE_INFINITY;
  let secondSim = Number.NEGATIVE_INFINITY;
  for (const [type, proto] of space.positives) {
    const sim = cosineSimilarity(vec, proto);
    if (sim === null) continue;
    if (sim > bestSim) {
      secondSim = bestSim;
      bestSim = sim;
      bestType = type;
    } else if (sim > secondSim) {
      secondSim = sim;
    }
  }
  if (bestType === null) return null;
  const negSim =
    space.negative !== null ? (cosineSimilarity(vec, space.negative) ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
  const competitor = Math.max(negSim, secondSim);
  if (!(bestSim >= thresholds.accept)) return null;
  if (!(bestSim - competitor >= thresholds.margin)) return null;
  const ratio = (bestSim - thresholds.accept) / (1 - thresholds.accept);
  return { type: bestType, confidence: clamp01(0.5 + 0.5 * ratio) };
}

/** embedding 命中内部消解重叠：置信度降序 → 短者优先 → 起点升序，贪心保留互不重叠 */
function resolveEmbeddingOverlaps(items: readonly ScoredCandidate[]): readonly ScoredCandidate[] {
  const sorted = [...items].sort(
    (a, b) => b.confidence - a.confidence || (a.end - a.start) - (b.end - b.start) || a.start - b.start,
  );
  const kept: ScoredCandidate[] = [];
  for (const item of sorted) {
    if (kept.some((k) => item.start < k.end && k.start < item.end)) continue;
    kept.push(item);
  }
  return kept;
}

/** 规则结果优先：重叠区间丢 embedding 命中；非重叠合并后按 span 升序统一重编 id */
function mergeWithRuleRefs(ruleRefs: readonly DanglingRef[], embeddingHits: readonly ScoredCandidate[]): readonly DanglingRef[] {
  const kept = embeddingHits.filter(
    (hit) => !ruleRefs.some((ref) => hit.start < ref.span[1] && ref.span[0] < hit.end),
  );
  const entries: ReadonlyArray<{ start: number; ref: Omit<DanglingRef, "id"> }> = [
    ...ruleRefs.map((ref) => {
      const { id: _id, ...rest } = ref; // 规则项内容原样保留（含置信度），id 统一重编
      return { start: ref.span[0], ref: rest };
    }),
    ...kept.map((hit) => ({
      start: hit.start,
      ref: {
        span: [hit.start, hit.end] as const,
        text: hit.text,
        expectedType: hit.type,
        confidence: Math.round(clamp01(hit.confidence) * 1e6) / 1e6,
      },
    })),
  ];
  const sorted = entries.slice().sort((a, b) => a.start - b.start);
  return sorted.map((entry, index): DanglingRef => ({ ...entry.ref, id: `ref-${index + 1}` }));
}

// ---------------------------------------------------------------------------
// EmbeddingDetector
// ---------------------------------------------------------------------------

/** 可选 embedding 检测器：异步向量近邻分类，任何失败回退规则检测器（永不抛出） */
export class EmbeddingDetector implements Detector, AsyncDetector {
  private readonly provider: EmbeddingProvider | null;
  private readonly examples: readonly EmbeddingExample[];
  private readonly thresholds: EmbeddingThresholds;
  private readonly maxCandidates: number;
  private readonly maxPromptChars: number;
  private readonly budgetReserveMs: number;
  private readonly maxProviderFailures: number;
  private readonly logger: Logger | undefined;
  private readonly fallback: Detector;

  private prototypes: PrototypeSpace | null = null;
  private initPromise: Promise<PrototypeSpace | null> | null = null;
  private failures = 0;
  private disabled = false;

  constructor(provider: EmbeddingProvider | null | undefined, options: EmbeddingDetectorOptions = {}) {
    validateOptions(options);
    const examples = options.examples ?? DEFAULT_EMBEDDING_EXAMPLES;
    validateExamples(examples); // 默认集同样受形状约束（防数据文件回归）
    this.provider = provider ?? null;
    this.examples = examples;
    this.thresholds = { ...DEFAULT_EMBEDDING_THRESHOLDS, ...options.thresholds };
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    this.maxPromptChars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
    this.budgetReserveMs = options.budgetReserveMs ?? DEFAULT_BUDGET_RESERVE_MS;
    this.maxProviderFailures = options.maxProviderFailures ?? DEFAULT_MAX_PROVIDER_FAILURES;
    this.logger = options.logger;
    this.fallback = options.fallback ?? createRuleDetector();
  }

  /** 同步契约：恒等于规则回退输出（不等待向量推理，fail-open） */
  detect(prompt: string): readonly DanglingRef[] {
    return this.fallbackRefs(prompt);
  }

  async detectAsync(prompt: string, ctx?: DetectorContext): Promise<readonly DanglingRef[]> {
    const ruleRefs = this.fallbackRefs(prompt);
    if (this.provider === null || this.disabled) return ruleRefs;
    if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > this.maxPromptChars) return ruleRefs;
    if (ctx !== undefined && ctx.signal.aborted) return ruleRefs;

    let space = this.prototypes;
    if (space === null) {
      space = await this.ensurePrototypes(ctx);
      if (space === null) return ruleRefs; // 原型未就绪（失败/中止/预算）：规则回退
    }

    const candidates = generateCandidates(prompt, this.maxCandidates);
    if (candidates.length === 0) return ruleRefs;

    const cache = new Map<string, EmbeddingVector>();
    const hits: ScoredCandidate[] = [];
    for (const cand of candidates) {
      if (this.outOfBudget(ctx)) return ruleRefs; // 未完成即止 → 整次规则回退（确定性）
      let vec = cache.get(cand.text);
      if (vec === undefined) {
        try {
          const got = await this.embedText(this.provider, cand.text, ctx);
          if (got === null) return ruleRefs; // 中止
          vec = got;
        } catch (err) {
          this.recordFailure(`embed-error:${errorMessage(err)}`);
          return ruleRefs;
        }
        cache.set(cand.text, vec);
      }
      if (vec.length !== space.dimension || !isFiniteVector(vec)) {
        this.recordFailure(`candidate-vector-invalid(len=${vec.length}, dim=${space.dimension})`);
        return ruleRefs;
      }
      const scored = classifyByPrototypes(vec, space, this.thresholds);
      if (scored !== null) {
        hits.push({ start: cand.start, end: cand.end, text: cand.text, type: scored.type, confidence: scored.confidence });
      }
    }
    return mergeWithRuleRefs(ruleRefs, resolveEmbeddingOverlaps(hits));
  }

  // ---- 内部：规则回退与预算 ----

  private fallbackRefs(prompt: string): readonly DanglingRef[] {
    try {
      const result = this.fallback.detect(prompt);
      return Array.isArray(result) ? result : [];
    } catch {
      return []; // 回退检测器也不可信时按零指代处理（fail-open）
    }
  }

  private outOfBudget(ctx: DetectorContext | undefined): boolean {
    if (ctx === undefined) return false;
    return ctx.signal.aborted || ctx.remainingMs() < this.budgetReserveMs;
  }

  private log(level: "info" | "warn", event: string, detail?: string): void {
    this.logger?.({ level, event, ...(detail !== undefined ? { detail } : {}) });
  }

  private recordFailure(detail: string): void {
    this.failures += 1;
    this.log("warn", "embedding-provider-failure", detail);
    if (this.failures >= this.maxProviderFailures && !this.disabled) {
      this.disabled = true;
      this.log("warn", "embedding-detector-disabled", `provider 失败 ${this.failures} 次，本实例永久回退规则检测器`);
    }
  }

  /** 单次 embed：abort → null；provider 抛错原样传播（调用方记录并回退） */
  private async embedText(
    provider: EmbeddingProvider,
    text: string,
    ctx: DetectorContext | undefined,
  ): Promise<EmbeddingVector | null> {
    const promise = Promise.resolve().then(() => provider.embed(text));
    if (ctx === undefined) return await promise;
    return await raceAbort(promise, ctx.signal);
  }

  // ---- 内部：原型构建（单飞；失败可重试直至达上限） ----

  private ensurePrototypes(ctx: DetectorContext | undefined): Promise<PrototypeSpace | null> {
    const existing = this.initPromise;
    if (existing !== null) return existing; // 单飞：并发调用共享同一次尝试
    const provider = this.provider;
    if (provider === null) return Promise.resolve(null);
    const attempt = this.buildPrototypes(provider, ctx);
    this.initPromise = attempt;
    void attempt.then(() => {
      // 尝试结束即清引用：成功走 prototypes 缓存；失败/中止由下一次调用重新尝试
      if (this.initPromise === attempt) this.initPromise = null;
    });
    return attempt;
  }

  private async buildPrototypes(
    provider: EmbeddingProvider,
    ctx: DetectorContext | undefined,
  ): Promise<PrototypeSpace | null> {
    const outcome = await this.buildPrototypesOutcome(provider, ctx);
    if (outcome.ok) {
      this.prototypes = outcome.space;
      return outcome.space;
    }
    if (outcome.reason === "stopped") {
      this.log("info", "embedding-prototype-stopped", "预算不足或已中止，本次回退规则，稍后重试");
    } // provider-failure 已在内部计数
    return null;
  }

  private async buildPrototypesOutcome(
    provider: EmbeddingProvider,
    ctx: DetectorContext | undefined,
  ): Promise<InitOutcome> {
    const groups = new Map<EmbeddingExampleLabel, number[][]>();
    let dimension: number | null = null;
    try {
      for (const ex of this.examples) {
        if (this.outOfBudget(ctx)) return { ok: false, reason: "stopped" };
        const vec = await this.embedText(provider, ex.text, ctx);
        if (vec === null) return { ok: false, reason: "stopped" };
        if (!isFiniteVector(vec)) {
          this.recordFailure("prototype-vector-invalid");
          return { ok: false, reason: "provider-failure" };
        }
        if (dimension === null) dimension = vec.length;
        else if (vec.length !== dimension) {
          this.recordFailure(`prototype-dim-mismatch(len=${vec.length}, dim=${dimension})`);
          return { ok: false, reason: "provider-failure" };
        }
        const group = groups.get(ex.type) ?? [];
        group.push([...vec]);
        groups.set(ex.type, group);
      }
    } catch (err) {
      this.recordFailure(`prototype-embed-error:${errorMessage(err)}`);
      return { ok: false, reason: "provider-failure" };
    }
    if (dimension === null) return { ok: false, reason: "provider-failure" }; // 无示例（构造期已挡，防御）
    const positives = new Map<DataType, EmbeddingVector>();
    for (const [label, vectors] of groups) {
      if (label === "negative") continue;
      const proto = meanDirection(vectors);
      if (proto === null) continue;
      positives.set(label, proto);
    }
    if (positives.size === 0) {
      this.recordFailure("prototype-empty-positives");
      return { ok: false, reason: "provider-failure" };
    }
    const negativeGroup = groups.get("negative");
    const negative = negativeGroup !== undefined ? meanDirection(negativeGroup) : null;
    return { ok: true, space: { dimension, positives, negative } };
  }
}

/** 便捷构造（provider 可为 null/undefined：即纯规则回退模式） */
export function createEmbeddingDetector(
  provider?: EmbeddingProvider | null,
  options?: EmbeddingDetectorOptions,
): EmbeddingDetector {
  return new EmbeddingDetector(provider ?? null, options ?? {});
}
