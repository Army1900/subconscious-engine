/**
 * 惯例蒸馏（M5c-2，DECISIONS D25/D26；docs/CONVENTIONS.md §3/§4）。
 *
 * 契约：
 * - 触发：pi `session_shutdown`（quit/new/resume/fork；reload 跳过——扩展重载时会话
 *   仍在继续，此刻蒸馏会把素材冻结在半途，且去抖会挡掉结束时的更完整蒸馏）；
 * - 执行：fire-and-forget 的 headless `pi -p` 子进程（--offline --no-session
 *   --no-extensions --no-skills --no-tools，根 README 已验证的 headless 形态）——
 *   由更长寿的 distill-child.js 监工（spawn/收 stdout/校验/写回），扩展进程立刻
 *   返回，绝不阻塞会话结束（quit 后子进程靠 detached 存活完成写回）；
 * - core 零 LLM 红线不破：本模块在适配器层，蒸馏只由宿主模型执行；
 * - fail-open：任何失败（素材提取/spawn/超时/输出非法/写回）= stderr 单行 warn
 *   后静默跳过，宿主会话零影响；
 * - 去抖：同会话重复 shutdown 只蒸馏一次（进程内记忆；Map 上限防膨胀）；
 * - 开关：SUBCONSCIOUS_DISTILL=0 关闭（其余任何值含未设置 = 开）；
 * - 子进程命令可配置：SUBCONSCIOUS_DISTILL_BIN 覆盖 headless pi 可执行文件
 *   （测试注入假可执行文件，绝不真调宿主 CLI）；
 * - 不做网络重试：一次失败即放弃本次蒸馏。
 *
 * 校验纪律（CONVENTIONS §4，不信模型输出）：JSON 解析失败 → 放弃；逐条形状校验
 * （expression ≤16 字 / content ≤120 字，与提示词一致）→ 非法丢弃；超 5 条截断；
 * 敏感内容粗筛（凭据形态 token / 长随机串）命中即丢弃该条；与现有条目逐字节相同
 * 的输出直接丢弃（防「洗时间」，core upsert 亦 no-op，双保险）。
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { FileMemoryStore, isConvention } from "@subconscious/core";
import type { ConventionEntry, Logger, MemoryStore, SessionChange } from "@subconscious/core";
import { resolveMemoryFilePath } from "./memory.js";

/** 蒸馏总开关变量：值为 "0" 时关闭（其余任何值含未设置 = 开） */
export const DISTILL_ENV_VAR = "SUBCONSCIOUS_DISTILL";
/** headless pi 可执行文件覆盖（测试注入假可执行文件用；缺省 "pi"） */
export const DISTILL_BIN_ENV_VAR = "SUBCONSCIOUS_DISTILL_BIN";
/** 蒸馏子进程超时覆盖（正整数毫秒；缺省 DEFAULT_DISTILL_TIMEOUT_MS，上限 MAX） */
export const DISTILL_TIMEOUT_ENV_VAR = "SUBCONSCIOUS_DISTILL_TIMEOUT_MS";
/** 单次蒸馏最多采纳的惯例条数（超 5 截断，CONVENTIONS §4 规则 5） */
export const MAX_DISTILL_CONVENTIONS = 5;
/** 会话素材读取字节上限（会话 JSONL 尾部有界读取） */
export const DISTILL_MATERIAL_MAX_BYTES = 65_536;
/** 组装进提示词的素材字符上限 */
export const DISTILL_MATERIAL_MAX_CHARS = 12_000;
/** 蒸馏子进程默认超时（CONVENTIONS §3：建议 60s 上限） */
export const DEFAULT_DISTILL_TIMEOUT_MS = 60_000;
/** 蒸馏子进程超时上限（防误配） */
export const MAX_DISTILL_TIMEOUT_MS = 300_000;
/** 去抖记忆容量上限（长寿命进程防无界增长；超出淘汰最早记录） */
export const MAX_DISTILL_DEBOUNCE_ENTRIES = 512;

/**
 * 敏感内容粗筛（CONVENTIONS §4 规则 2 的适配器侧防线，正则粗筛不追求完备）：
 * 私钥块、常见服务凭据前缀（sk- 与 gh 系列、xox 系列、AKIA）、Bearer 令牌、
 * ≥40 连续无分隔字符的随机串形态（base64/hex 载荷）。
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._+/-]{20,}/,
  /[A-Za-z0-9+/]{40,}/,
];

export function looksSensitive(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isDistillEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DISTILL_ENV_VAR] !== "0";
}

export function resolveDistillTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DISTILL_TIMEOUT_ENV_VAR];
  if (raw === undefined) return DEFAULT_DISTILL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_DISTILL_TIMEOUT_MS;
  return Math.min(n, MAX_DISTILL_TIMEOUT_MS);
}

/** headless pi 命令（根 README 已验证形态；--no-extensions 结构性杜绝蒸馏再触发本扩展） */
export function headlessPiArgs(prompt: string): string[] {
  return ["--offline", "--no-session", "--no-extensions", "--no-skills", "--no-tools", "-p", prompt];
}

/**
 * headless pi 执行器（distill-child 内使用；测试经 DISTILL_BIN_ENV_VAR 注入假可执行文件）。
 * 超时/非零退出/spawn 失败 → reject（调用方 fail-open 放弃本次蒸馏）；stdout 为模型输出。
 */
export function spawnHeadlessPi(
  prompt: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const bin = env[DISTILL_BIN_ENV_VAR]?.trim() || "pi";
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, headlessPiArgs(prompt), {
      env,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.on("error", (err: Error) => reject(err));
    child.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`headless pi 退出码 ${String(code)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// 提示词组装（CONVENTIONS §4 草案，占位符 {{PROJECT_KEY}}/{{EXISTING}}/{{SESSION_EXCERPT}}）
// ---------------------------------------------------------------------------

export interface DistillPromptInput {
  readonly projectKey: string;
  readonly existingExpressions: readonly string[];
  readonly material: string;
}

export function composeDistillPrompt(input: DistillPromptInput): string {
  const existing =
    input.existingExpressions.length > 0 ? input.existingExpressions.map((e) => `「${e}」`).join("、") : "（无）";
  return [
    "你在为编码助手「潜意识引擎」做会话惯例蒸馏。请阅读下面这段会话记录，找出其中",
    "【反复出现、明确成型的项目工作惯例】（如错误处理方式、命名风格、提交信息格式、",
    "目录组织、测试约定），输出 JSON。",
    "",
    "规则：",
    "1. 宁缺毋滥：只有当会话中有明确证据（用户明确要求过、或双方确认过且被执行）时才",
    "   输出；单次出现、猜测的、用户否决过的做法，一律不输出；",
    "2. 不蒸馏敏感内容（凭据、私人文本、与工作惯例无关的个人信息）；",
    "3. 每条惯例：expression=惯例名（≤16 字，领域名词，如「错误处理」），",
    "   content=惯例内容（≤120 字，可执行的具体描述，如「统一 try/catch 包裹并 log",
    "   错误，不吞异常」）；",
    "4. 与现有惯例同名的：若本会话做法与之冲突，输出新版本（后写胜）；一致则不重复输出；",
    `5. 只输出 JSON 数组，无其他文本：[{"expression":"...","content":"..."}]，最多 ${MAX_DISTILL_CONVENTIONS} 条。`,
    "",
    `项目：${input.projectKey}`,
    `现有惯例：${existing}`,
    "会话记录：",
    input.material,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 输出校验（不信模型输出；任何非法 = 丢弃该条，整体解析失败 = 放弃本次）
// ---------------------------------------------------------------------------

export interface DistilledCandidate {
  readonly expression: string;
  readonly content: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 剥离代码围栏（模型常见包装形态；确定性字符串操作） */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced !== null ? (fenced[1] as string) : trimmed;
}

/**
 * 解析模型输出为候选列表：JSON 解析失败 → null（放弃本次蒸馏）；
 * 非数组 / 条目非 {expression,content} 非空字符串 → 逐条丢弃；
 * 超 MAX_DISTILL_CONVENTIONS 条截断；敏感命中即丢弃该条（由调用方记 warn）。
 */
export function extractDistillCandidates(raw: string): DistilledCandidate[] | null {
  let text = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 第二次机会：模型在 JSON 前后夹带说明文字时取首个 '[' 到末个 ']' 的切片
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    text = text.slice(start, end + 1);
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const candidates: DistilledCandidate[] = [];
  for (const item of parsed.slice(0, MAX_DISTILL_CONVENTIONS)) {
    if (!isRecord(item)) continue;
    const expression = typeof item.expression === "string" ? item.expression.trim() : "";
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (expression === "" || content === "") continue;
    candidates.push({ expression, content });
  }
  return candidates;
}

export interface ConventionBase {
  readonly projectKey: string;
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly now: Date;
}

/** 候选 → 完整惯例条目（id/时间/溯源由适配器补齐），形状或上限非法 → 丢弃 */
export function buildConventionEntries(
  candidates: readonly DistilledCandidate[],
  base: ConventionBase,
): ConventionEntry[] {
  const entries: ConventionEntry[] = [];
  for (const candidate of candidates) {
    const entry: ConventionEntry = {
      id: `c-${Math.floor(base.now.getTime() / 1000).toString(36)}-${randomBytes(3).toString("hex")}`,
      projectKey: base.projectKey,
      expression: candidate.expression,
      content: candidate.content,
      basedOnSessionId: base.sessionId,
      basedOnSessionTitle: base.sessionTitle,
      generatedAt: base.now.toISOString(),
      lastHitAt: base.now.toISOString(),
      hitCount: 0,
    };
    if (!isConvention(entry)) continue; // expression ≤16 字 / content ≤120 字等上限
    entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 会话素材组装（有界；用户话语 + 修改记录，CONVENTIONS §2）
// ---------------------------------------------------------------------------

export interface SessionMaterialInput {
  readonly sessionTitle: string;
  readonly userTurns: readonly string[];
  readonly changes: readonly SessionChange[];
}

/** 素材内单条用户话语字符上限 */
export const MATERIAL_TURN_MAX_CHARS = 200;
/** 素材内用户话语条数上限 */
export const MATERIAL_MAX_TURNS = 40;
/** 素材内单条修改记录 old/new 各自字符上限 */
export const MATERIAL_CHANGE_MAX_CHARS = 160;
/** 素材内修改记录条数上限 */
export const MATERIAL_MAX_CHANGES = 60;

function renderChange(change: SessionChange): string {
  const at = change.path !== undefined ? `${change.path}：` : "";
  if (change.tool === "write" && change.content !== undefined) {
    return `- [write] ${at}写入 ${JSON.stringify(change.content.slice(0, MATERIAL_CHANGE_MAX_CHARS))}`;
  }
  const oldText = change.oldText ?? "";
  const newText = change.newText ?? "";
  return `- [edit] ${at}${JSON.stringify(oldText.slice(0, MATERIAL_CHANGE_MAX_CHARS))} → ${JSON.stringify(newText.slice(0, MATERIAL_CHANGE_MAX_CHARS))}`;
}

/** 会话素材 → 提示词文本（标题 + 用户话语 + 非错误修改记录，双重字符上限） */
export function renderSessionMaterial(input: SessionMaterialInput): string {
  const lines: string[] = [];
  const title = input.sessionTitle.trim();
  lines.push(`会话标题：${title === "" ? "（无标题）" : title}`);
  const turns = input.userTurns.slice(0, MATERIAL_MAX_TURNS);
  lines.push(`用户话语（${turns.length} 条）：`);
  for (const turn of turns) lines.push(`- ${turn.slice(0, MATERIAL_TURN_MAX_CHARS).replace(/\s+/g, " ").trim()}`);
  const changes = input.changes.filter((c) => c.isError !== true).slice(0, MATERIAL_MAX_CHANGES);
  lines.push(`修改记录（${changes.length} 条，edit/write 摘录）：`);
  for (const change of changes) lines.push(renderChange(change));
  return lines.join("\n").slice(0, DISTILL_MATERIAL_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// 去抖（进程内记忆；同会话重复结束事件只蒸馏一次）
// ---------------------------------------------------------------------------

export interface DistillDebouncer {
  /** true = 本次应蒸馏并已记录；false = 冷却窗口内重复事件，跳过 */
  shouldDistill(key: string, now: number): boolean;
}

/** Map 保序做 FIFO 淘汰；cooldownMs = Infinity 即「每会话至多一次」 */
export function createDistillDebouncer(
  cooldownMs: number = Number.POSITIVE_INFINITY,
  maxEntries: number = MAX_DISTILL_DEBOUNCE_ENTRIES,
): DistillDebouncer {
  const seen = new Map<string, number>();
  return {
    shouldDistill(key: string, now: number): boolean {
      const last = seen.get(key);
      if (last !== undefined && now - last < cooldownMs) return false; // 冷却窗口内（含 Infinity：每会话至多一次）
      if (seen.size >= maxEntries) {
        const oldest = seen.keys().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      seen.set(key, now);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 蒸馏主流程（校验 → 写回；永不抛出）
// ---------------------------------------------------------------------------

export interface DistillRequest {
  readonly projectKey: string;
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly material: string;
}

/** 蒸馏执行器：提示词 → 模型原始输出（适配器/测试可注入；失败 reject） */
export type DistillExecutor = (prompt: string, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<string>;

export interface DistillRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  readonly store?: MemoryStore;
  readonly executor?: DistillExecutor;
  readonly now?: () => number;
}

function warn(logger: Logger | undefined, detail: string): void {
  logger?.({ level: "warn", event: "distill-skipped", detail });
}

/**
 * 执行一次蒸馏并写回（CONVENTIONS §2 数据流的适配器侧）。
 * 返回写回条数；任何失败 = 单行 warn 后返回 0（fail-open，绝不抛出）。
 */
export async function runDistillation(req: DistillRequest, options: DistillRunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const logger = options.logger;
  const executor = options.executor ?? spawnHeadlessPi;
  try {
    if (req.material.trim() === "") return 0; // 无素材不蒸馏（空会话）
    // 蒸馏写回经独立 FileMemoryStore（distill-child 自身进程内队列串行化；
    // 与扩展进程的先验写入跨进程并发时 rename 原子性保证不损坏，最坏丢一次学习）
    const store = options.store ?? new FileMemoryStore(resolveMemoryFilePath(env));
    let existing: readonly ConventionEntry[] = [];
    try {
      existing = await store.listConventions(req.projectKey);
    } catch {
      existing = []; // 读取失败按无现有惯例处理（提示词 {{EXISTING}} 为空）
    }
    const prompt = composeDistillPrompt({
      projectKey: req.projectKey,
      existingExpressions: existing.map((c) => c.expression),
      material: req.material,
    });
    const raw = await executor(prompt, resolveDistillTimeoutMs(env), env);
    const candidates = extractDistillCandidates(raw);
    if (candidates === null) {
      warn(logger, "模型输出不是合法 JSON，放弃本次蒸馏");
      return 0;
    }
    const now = options.now ?? (() => Date.now());
    let entries = buildConventionEntries(candidates, {
      projectKey: req.projectKey,
      sessionId: req.sessionId,
      sessionTitle: req.sessionTitle,
      now: new Date(now()),
    });
    // 敏感粗筛 + 与现有条目逐字节相同去重（防「洗时间」；core upsert 亦 no-op，双保险）
    entries = entries.filter((entry) => {
      if (looksSensitive(entry.expression) || looksSensitive(entry.content)) {
        warn(logger, `惯例「${entry.expression}」命中敏感内容粗筛，丢弃`);
        return false;
      }
      const duplicate = existing.some(
        (c) => c.projectKey === entry.projectKey && c.expression === entry.expression && c.content === entry.content,
      );
      return !duplicate;
    });
    let written = 0;
    for (const entry of entries) {
      try {
        await store.addConvention(entry);
        written += 1;
      } catch (err) {
        warn(logger, `惯例「${entry.expression}」写回失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (written > 0) logger?.({ level: "info", event: "distill-written", detail: `写回 ${written} 条惯例（依据会话 ${req.sessionId}）` });
    return written;
  } catch (err) {
    warn(logger, `蒸馏失败：${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
