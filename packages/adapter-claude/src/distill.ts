/**
 * 惯例蒸馏（M5c-2，DECISIONS D25/D26；docs/CONVENTIONS.md §3/§4）。
 *
 * 契约：
 * - 触发：Claude Code hooks `SessionEnd`（stdin JSON，官方 hooks reference 核实：
 *   通用字段 session_id/transcript_path/cwd/permission_mode/hook_event_name + 事件
 *   特有 reason；无 prompt 字段、不使用 matcher 的必要面）；
 * - 执行：SessionEnd hook 进程内 spawn headless `claude -p` 子进程并等待其输出
 *   （有界超时），随后校验写回——hook 进程本身就是「会话结束后」的一次性进程，
 *   等待是完成写回的唯一途径；宿主侧 hook timeout 是最终上限（默认 60s，蒸馏
 *   默认 50s 留出余量）；
 * - 防递归哨兵：蒸馏子进程带 SUBCONSCIOUS_DISTILL_CHILD=1，其内部的任何 hook
 *   触发（UserPromptSubmit 注入 / SessionEnd 再蒸馏）都被 hook-main 顶部哨兵
 *   拦截为 no-op——蒸馏子进程自身绝不再次触发本适配器；
 * - 素材：transcript_path JSONL 的尾部有界原文拼接——**内部结构无官方文档，
 *   不解析任何字段**（近似素材，README 注明）；单条 UTF-8 换行对齐、fatal 解码；
 * - core 零 LLM 红线不破：蒸馏只由宿主模型执行；
 * - fail-open：任何失败（读取/spawn/超时/输出非法/写回）= stderr 单行 warn 后
 *   静默跳过，hook 输出空、退出码恒 0；
 * - 去抖：同会话重复 SessionEnd 事件只蒸馏一次（进程内记忆；跨进程重复事件
 *   属不同会话时刻，按新素材处理）；
 * - 开关：SUBCONSCIOUS_DISTILL=0 关闭（其余任何值含未设置 = 开）；
 * - 子进程命令可配置：SUBCONSCIOUS_DISTILL_BIN 覆盖 claude 可执行文件（测试
 *   注入假可执行文件，绝不真调宿主 CLI）；不做网络重试。
 *
 * 校验纪律（CONVENTIONS §4，不信模型输出）：JSON 解析失败 → 放弃；逐条形状校验
 * （expression ≤16 字 / content ≤120 字）→ 非法丢弃；超 5 条截断；敏感内容粗筛
 * 命中即丢弃该条；与现有条目逐字节相同的输出直接丢弃（防「洗时间」，core upsert
 * 亦 no-op，双保险）。
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { isConvention } from "@subconscious/core";
import type { ConventionEntry, Logger, MemoryStore } from "@subconscious/core";
import { fileMemoryStoreFor, resolveMemoryFilePath } from "./memory.js";

/** 蒸馏总开关变量：值为 "0" 时关闭（其余任何值含未设置 = 开） */
export const DISTILL_ENV_VAR = "SUBCONSCIOUS_DISTILL";
/** headless claude 可执行文件覆盖（测试注入假可执行文件用；缺省 "claude"） */
export const DISTILL_BIN_ENV_VAR = "SUBCONSCIOUS_DISTILL_BIN";
/** 蒸馏子进程超时覆盖（正整数毫秒；缺省 DEFAULT_DISTILL_TIMEOUT_MS，上限 MAX） */
export const DISTILL_TIMEOUT_ENV_VAR = "SUBCONSCIOUS_DISTILL_TIMEOUT_MS";
/** 防递归哨兵：蒸馏子进程内本适配器所有 hook 入口 no-op */
export const DISTILL_CHILD_GUARD_ENV_VAR = "SUBCONSCIOUS_DISTILL_CHILD";
/** 单次蒸馏最多采纳的惯例条数（超 5 截断，CONVENTIONS §4 规则 5） */
export const MAX_DISTILL_CONVENTIONS = 5;
/** transcript 素材读取字节上限（尾部有界读取） */
export const DISTILL_MATERIAL_MAX_BYTES = 65_536;
/** 组装进提示词的素材字符上限 */
export const DISTILL_MATERIAL_MAX_CHARS = 12_000;
/**
 * 蒸馏子进程默认超时：50s（宿主 hook 单命令默认 60s 上限之内，无需额外配置；
 * 调高时需同步调高 settings.json 的 hook timeout，单位为秒）
 */
export const DEFAULT_DISTILL_TIMEOUT_MS = 50_000;
/** 蒸馏子进程超时上限（防误配） */
export const MAX_DISTILL_TIMEOUT_MS = 300_000;
/** 去抖记忆容量上限（防御性；hook 进程通常一次性） */
export const MAX_DISTILL_DEBOUNCE_ENTRIES = 512;

/**
 * 敏感内容粗筛（CONVENTIONS §4 规则 2 的适配器侧防线，正则粗筛不追求完备）：
 * 私钥块、常见服务凭据前缀（sk- 与 gh 系列、xox 系列、AKIA）、Bearer 令牌、
 * 40+ 连续无分隔字符的随机串形态（base64/hex 载荷）。
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

/** 防递归哨兵命中：本进程是蒸馏子进程 → 所有 hook 入口一律 no-op */
export function isDistillChildGuard(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DISTILL_CHILD_GUARD_ENV_VAR] === "1";
}

export function resolveDistillTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DISTILL_TIMEOUT_ENV_VAR];
  if (raw === undefined) return DEFAULT_DISTILL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_DISTILL_TIMEOUT_MS;
  return Math.min(n, MAX_DISTILL_TIMEOUT_MS);
}

/**
 * headless claude 执行器（`claude -p`，headless print 模式）。
 * 子进程带防递归哨兵（其内部 hook 触发被 hook-main 拦截为 no-op）。
 * 超时/非零退出/spawn 失败 → reject（调用方 fail-open 放弃本次蒸馏）。
 */
export function spawnHeadlessClaude(
  prompt: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const bin = env[DISTILL_BIN_ENV_VAR]?.trim() || "claude";
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ["-p", prompt], {
      env: { ...env, [DISTILL_CHILD_GUARD_ENV_VAR]: "1" },
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
      else reject(new Error(`headless claude 退出码 ${String(code)}`));
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
 * 超 MAX_DISTILL_CONVENTIONS 条截断。
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
// transcript 素材（尾部有界原文拼接；不解析内部字段——结构无官方文档）
// ---------------------------------------------------------------------------

/**
 * 尾部有界读取：读文件末尾 ≤ maxBytes 字节并对齐到首个换行（丢弃被截断的半行），
 * fatal 解码保证合法 UTF-8。任何失败 → null（fail-open 跳过本次蒸馏）。
 */
export async function readTailText(filePath: string, maxBytes: number): Promise<string | null> {
  const handle = await open(filePath, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    let bytes = buffer.subarray(0, bytesRead);
    if (bytesRead < size && bytesRead > 0) {
      // 从尾部截断时首行大概率是半行：对齐到换行后（对齐失败则整段放弃，不猜）
      const newline = bytes.indexOf(10);
      if (newline < 0) return null;
      bytes = bytes.subarray(newline + 1);
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return text.startsWith("\uFEFF") ? text.slice(1) : text;
    } catch {
      return null; // 编码非法 → 不可用
    }
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * transcript 尾部原文 → 蒸馏素材：只做有界拼接，不解析任何 JSONL 内部字段
 * （结构无官方文档；近似素材，模型自行阅读原始行）。
 */
export function renderTranscriptMaterial(tail: string): string {
  const header = "（素材说明：以下为会话 transcript 尾部原始 JSONL 文本，未解析内部字段，"
    + "可能含结构噪声；请从中识别工作惯例）";
  return `${header}\n${tail}`.slice(0, DISTILL_MATERIAL_MAX_CHARS);
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
  const executor = options.executor ?? spawnHeadlessClaude;
  try {
    if (req.material.trim() === "") return 0; // 无素材不蒸馏
    const store = options.store ?? fileMemoryStoreFor(resolveMemoryFilePath(env));
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
