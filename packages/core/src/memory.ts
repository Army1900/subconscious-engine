import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EngineConfigError } from "./errors.js";
import { isDataType } from "./registry.js";
import { isNonEmptyString } from "./text.js";
import type { Candidate, DisambiguationPrior, MemoryData, MemoryStore, PersonalPhrase } from "./types.js";

/**
 * 个人记忆层 v0（M5a；DESIGN §11.3 红线 + docs/DECISIONS.md D24）：
 * - 消歧先验：用户在 select 消歧中选定历史会话时记录 {项目、会话、标题、时间}；
 *   使用侧只做两件事——对既有候选加权排序、达门槛时保守代选（display 可审计）。
 *   绝不注入用户没提到的会话（预测注入红线）。
 * - 个人惯用语词典：{短语 → 期望类型}，只显式注册（addPersonalPhrase / 手工编辑），
 *   v0 不自动学习；命中仍要求"用户说出口"（短语在话语中出现）才触发。
 * - 持久化参照 FileGrantStore：临时文件 + rename 原子写，任何损坏/IO 故障 fail-open
 *   为空记忆（行为等同今天）。
 */

// ---------------------------------------------------------------------------
// 常量（阈值与上限依据见 D24）
// ---------------------------------------------------------------------------

/** 先验有效窗口：仅统计近 N 天内的选择 */
export const PRIOR_WINDOW_DAYS = 14;
/** 自动代选次数门槛：同项目同会话窗口内被选 ≥ N 次 */
export const PRIOR_AUTO_MIN_PICKS = 2;
/** 自动代选显著度门槛：首选权重 ≥ N × 次选权重 */
export const PRIOR_AUTO_DOMINANCE = 2;
/** 先验记录条数上限（写入时裁剪窗口外记录后封顶，保留最新） */
export const MAX_DISAMBIGUATION_RECORDS = 100;
/** 词条数上限 */
export const MAX_PHRASES = 200;
/** 单条短语字符上限 */
export const MAX_PHRASE_CHARS = 64;
/** 解析提示字符上限 */
export const MAX_HINT_CHARS = 200;

const MS_PER_DAY = 86_400_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function emptyMemory(): MemoryData {
  return { version: 1, disambiguation: [], phrases: [] };
}

// ---------------------------------------------------------------------------
// 形状校验（memory.json 可手工编辑，一切入口按不可信输入校验）
// ---------------------------------------------------------------------------

export function isDisambiguationPrior(v: unknown): v is DisambiguationPrior {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.projectKey) &&
    isNonEmptyString(v.sessionId) &&
    typeof v.title === "string" &&
    typeof v.at === "string"
  );
}

export function isPersonalPhrase(v: unknown): v is PersonalPhrase {
  if (!isRecord(v)) return false;
  if (typeof v.phrase !== "string") return false;
  if (v.phrase.trim().length === 0 || v.phrase.length > MAX_PHRASE_CHARS) return false;
  if (!isDataType(v.expectedType)) return false;
  if (v.hint !== undefined && typeof v.hint !== "string") return false;
  if (typeof v.hint === "string" && v.hint.length > MAX_HINT_CHARS) return false;
  return true;
}

/** 严格校验并重建 MemoryData；任一条目/数量非法 → null（不产出半份数据） */
export function parseMemoryData(v: unknown): MemoryData | null {
  if (!isRecord(v)) return null;
  if (v.version !== 1) return null;
  if (!Array.isArray(v.disambiguation) || !Array.isArray(v.phrases)) return null;
  if (v.disambiguation.length > MAX_DISAMBIGUATION_RECORDS) return null;
  if (v.phrases.length > MAX_PHRASES) return null;
  if (!v.disambiguation.every(isDisambiguationPrior)) return null;
  if (!v.phrases.every(isPersonalPhrase)) return null;
  return {
    version: 1,
    disambiguation: v.disambiguation.map((p) => ({
      projectKey: p.projectKey,
      sessionId: p.sessionId,
      title: p.title,
      at: p.at,
    })),
    phrases: v.phrases.map((p) => ({
      phrase: p.phrase,
      expectedType: p.expectedType,
      ...(p.hint !== undefined ? { hint: p.hint } : {}),
    })),
  };
}

/** 规范化词条：短语与提示去首尾空白，空提示省略；非法 → null */
export function normalizePersonalPhrase(entry: PersonalPhrase): PersonalPhrase | null {
  if (!isPersonalPhrase(entry)) return null;
  const phrase = entry.phrase.trim();
  const hint = entry.hint?.trim();
  return {
    phrase,
    expectedType: entry.expectedType,
    ...(hint !== undefined && hint !== "" ? { hint } : {}),
  };
}

// ---------------------------------------------------------------------------
// 可移植：导出/导入纯函数（新电脑复制 memory.json 即迁移；本对函数供程序化迁移用）
// ---------------------------------------------------------------------------

/** 序列化为人可编辑的两空格缩进 JSON；数据非法时受控失败（显式 API 应暴露编程错误） */
export function exportMemory(data: MemoryData): string {
  const parsed = parseMemoryData(data);
  if (parsed === null) {
    throw new EngineConfigError("invalid-memory", "记忆数据未通过 schema/上限校验，无法导出");
  }
  return JSON.stringify(parsed, null, 2);
}

/** 解析并校验；任何非法输入返回 null（不抛出、不产出半份数据） */
export function importMemory(text: string): MemoryData | null {
  if (typeof text !== "string") return null;
  try {
    return parseMemoryData(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 先验加权（纯函数，确定性）
// ---------------------------------------------------------------------------

/** 单个会话的先验强度：count = 窗口内被选次数；score = 近期加权累积 */
export interface PriorWeight {
  readonly count: number;
  readonly score: number;
}

/**
 * 按项目聚合窗口内先验：每次选择贡献 1 + (窗口天数 − 距今天数) / 窗口天数 ∈ [1, 2]
 * （越近期贡献越高；恰在窗口边界记 1，今天记 2）。异项目/窗口外/无效时间不计。
 * 未来时间戳按当下计（时钟偏移容错，取值有界不放大）。
 */
export function disambiguationWeights(
  priors: readonly DisambiguationPrior[],
  projectKey: string,
  now: number,
): Map<string, PriorWeight> {
  const weights = new Map<string, { count: number; score: number }>();
  const windowMs = PRIOR_WINDOW_DAYS * MS_PER_DAY;
  for (const prior of priors) {
    if (!isDisambiguationPrior(prior) || prior.projectKey !== projectKey) continue;
    const parsed = Date.parse(prior.at);
    if (Number.isNaN(parsed)) continue;
    const at = Math.min(parsed, now);
    const age = now - at;
    if (age > windowMs) continue;
    const score = 1 + (PRIOR_WINDOW_DAYS - age / MS_PER_DAY) / PRIOR_WINDOW_DAYS;
    const weight = weights.get(prior.sessionId) ?? { count: 0, score: 0 };
    weight.count += 1;
    weight.score += score;
    weights.set(prior.sessionId, weight);
  }
  return weights;
}

export interface PriorAutoResolution {
  readonly candidate: Candidate;
  readonly weight: PriorWeight;
}

/**
 * 保守自动解析判定：仅在同时满足——
 * ① 候选值均为既有显式指代产生的 history-event 候选（先验不在候选集内则忽略）；
 * ② 首选（权重最高，并列取候选顺序在前者）在窗口内被选 ≥ PRIOR_AUTO_MIN_PICKS 次；
 * ③ 首选权重 ≥ PRIOR_AUTO_DOMINANCE × 次选权重——
 * 时返回首选候选；否则 null（照旧弹 select 并继续学习）。绝不凭先验构造新候选。
 */
export function autoResolvePriorCandidate(
  candidates: readonly Candidate[],
  weights: ReadonlyMap<string, PriorWeight>,
): PriorAutoResolution | null {
  interface Scored {
    readonly candidate: Candidate;
    readonly count: number;
    readonly score: number;
  }
  const scored: Scored[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const value = candidate.value;
    if (!isRecord(value) || value.type !== "history-event") continue; // 先验只服务会话消歧
    const weight = weights.get(value.sessionId);
    scored.push({ candidate, count: weight?.count ?? 0, score: weight?.score ?? 0 });
  }
  if (scored.length === 0) return null;

  let top = scored[0] as Scored;
  for (const s of scored) {
    if (s.score > top.score) top = s; // 严格大于：并列时保持候选顺序在前者
  }
  let runnerScore = 0;
  for (const s of scored) {
    if (s !== top && s.score > runnerScore) runnerScore = s.score;
  }
  if (top.score <= 0) return null; // 无先验命中候选集
  if (top.count < PRIOR_AUTO_MIN_PICKS) return null;
  if (top.score < PRIOR_AUTO_DOMINANCE * runnerScore) return null;
  return { candidate: top.candidate, weight: { count: top.count, score: top.score } };
}

/** 候选按先验权重降序稳定排序（零权重保持原顺序）；返回新数组，不改入参 */
export function rankByPrior(
  candidates: readonly Candidate[],
  weights: ReadonlyMap<string, PriorWeight>,
): Candidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: priorScoreOf(candidate, weights) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.candidate);
}

function priorScoreOf(candidate: Candidate, weights: ReadonlyMap<string, PriorWeight>): number {
  if (!isRecord(candidate)) return 0;
  const value = candidate.value;
  if (!isRecord(value) || value.type !== "history-event") return 0;
  return weights.get(value.sessionId)?.score ?? 0;
}

// ---------------------------------------------------------------------------
// 写入裁剪/upsert（内存与文件实现共享的纯变更）
// ---------------------------------------------------------------------------

/** 追加先验并裁剪：丢弃窗口外与无效时间记录，超上限时保留最新 MAX 条（时间降序存储） */
function appendPrior(data: MemoryData, entry: DisambiguationPrior, now: number): MemoryData {
  const windowMs = PRIOR_WINDOW_DAYS * MS_PER_DAY;
  const kept = [...data.disambiguation, entry].filter((r) => {
    const parsed = Date.parse(r.at);
    if (Number.isNaN(parsed)) return false;
    return now - Math.min(parsed, now) <= windowMs;
  });
  if (kept.length <= MAX_DISAMBIGUATION_RECORDS) return { ...data, disambiguation: kept };
  const capped = kept
    .map((r, i) => ({ r, i, t: Date.parse(r.at) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .slice(0, MAX_DISAMBIGUATION_RECORDS)
    .map((x) => x.r);
  return { ...data, disambiguation: capped };
}

/** 词条 upsert：同短语替换（后写胜）；新增使条数超上限时受控失败 */
function upsertPhrase(data: MemoryData, normalized: PersonalPhrase): MemoryData {
  const exists = data.phrases.some((p) => p.phrase === normalized.phrase);
  if (!exists && data.phrases.length >= MAX_PHRASES) {
    throw new EngineConfigError("invalid-memory", `词条数已达上限 ${MAX_PHRASES}，删除旧词条后再添加`);
  }
  const phrases = exists
    ? data.phrases.map((p) => (p.phrase === normalized.phrase ? normalized : p))
    : [...data.phrases, normalized];
  return { ...data, phrases };
}

// ---------------------------------------------------------------------------
// 存储实现
// ---------------------------------------------------------------------------

/** 内存实现（测试/演示/宿主自管持久化时用；裁剪与封顶语义与文件实现一致） */
export class InMemoryMemoryStore implements MemoryStore {
  private data: MemoryData;

  constructor(
    initial: MemoryData = emptyMemory(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.data = parseMemoryData(initial) ?? emptyMemory();
  }

  async listDisambiguation(): Promise<readonly DisambiguationPrior[]> {
    return [...this.data.disambiguation];
  }

  async listPhrases(): Promise<readonly PersonalPhrase[]> {
    return [...this.data.phrases];
  }

  async recordDisambiguation(entry: DisambiguationPrior): Promise<void> {
    if (!isDisambiguationPrior(entry)) return; // 学习尽力而为：非法输入不抛出
    this.data = appendPrior(this.data, entry, this.now());
  }

  async addPersonalPhrase(entry: PersonalPhrase): Promise<void> {
    const normalized = normalizePersonalPhrase(entry);
    if (normalized === null) {
      throw new EngineConfigError(
        "invalid-memory",
        `词条非法：短语需为 1..${MAX_PHRASE_CHARS} 字符、类型在封闭集内、提示 ≤${MAX_HINT_CHARS} 字符`,
      );
    }
    this.data = upsertPhrase(this.data, normalized);
  }
}

/**
 * 文件持久化实现（参照 FileGrantStore）：~/.subconscious/memory.json。
 * - 原子写：同目录临时文件 + rename；目录不存在则递归创建。
 * - fail-open：读取损坏/不可用 → 空记忆（行为等同今天）；学习写入失败只吞不抛。
 * - 并发写经内部队列串行化。
 */
export class FileMemoryStore implements MemoryStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async read(): Promise<MemoryData> {
    try {
      return importMemory(await readFile(this.filePath, "utf8")) ?? emptyMemory();
    } catch {
      return emptyMemory(); // 损坏 = 空记忆，不注入半可信条目
    }
  }

  private async write(data: MemoryData): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temp, exportMemory(data), "utf8");
      await rename(temp, this.filePath);
    } catch {
      // 记忆持久化失败绝不阻塞用户 prompt（fail-open）
    }
  }

  /** 串行化变更；action 抛错只影响本次调用，队列继续 */
  private run<T>(action: (data: MemoryData) => { data: MemoryData; value: T }): Promise<T> {
    const result = this.queue.then(async () => {
      const outcome = action(await this.read());
      await this.write(outcome.data);
      return outcome.value;
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async listDisambiguation(): Promise<readonly DisambiguationPrior[]> {
    return (await this.read()).disambiguation;
  }

  async listPhrases(): Promise<readonly PersonalPhrase[]> {
    return (await this.read()).phrases;
  }

  recordDisambiguation(entry: DisambiguationPrior): Promise<void> {
    if (!isDisambiguationPrior(entry)) return Promise.resolve(); // 引擎侧学习是尽力而为
    return this.run((data) => ({ data: appendPrior(data, entry, this.now()), value: undefined })).catch(
      () => undefined, // 读/写故障：放弃本次学习，不影响调用方
    );
  }

  addPersonalPhrase(entry: PersonalPhrase): Promise<void> {
    const normalized = normalizePersonalPhrase(entry);
    if (normalized === null) {
      return Promise.reject(
        new EngineConfigError(
          "invalid-memory",
          `词条非法：短语需为 1..${MAX_PHRASE_CHARS} 字符、类型在封闭集内、提示 ≤${MAX_HINT_CHARS} 字符`,
        ),
      );
    }
    return this.run((data) => ({ data: upsertPhrase(data, normalized), value: undefined }));
  }
}
