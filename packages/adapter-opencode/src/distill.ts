/**
 * 惯例蒸馏（M5c-2，DECISIONS D25/D26；docs/CONVENTIONS.md §3/§4）。
 *
 * 调用面核实（锁定版 @opencode-ai/plugin@1.18.30 / @opencode-ai/sdk@1.18.30，
 * 2026-09-15，dist/gen/*.d.ts）：
 * - 触发：`Hooks["event"]: (input: { event: Event }) => Promise<void>`，
 *   `EventSessionIdle = { type: "session.idle"; properties: { sessionID: string } }`
 *   （types.gen.d.ts:413-417；OpenCode 无「会话销毁」事件，session.idle 是最接近
 *   「一轮工作告一段落」的官方信号——每轮回复完成后都会触发，故用冷却窗口去抖，
 *   见 DISTILL_COOLDOWN_MS）；
 * - 执行：**client 侧 LLM 调用面存在且公开**——`client.session.prompt`（POST
 *   /session/{id}/message，sdk.gen.d.ts:174；body { parts: TextPartInput[]; agent?;
 *   system?; tools?: Record<string, boolean> }，响应 `{ info: AssistantMessage;
 *   parts: Part[] }` 即助手回复，types.gen.d.ts:2244-2287）。据此不采用备选的
 *   spawn `opencode run` 子进程；
 * - 临时会话生命周期：`client.session.create`（POST /session，body { title? }，
 *   query { directory? }）+ `client.session.delete`（DELETE /session/{id}）——蒸馏
 *   在临时会话内进行（绝不污染用户会话），完成后即删；删除失败时标题可辨识；
 * - 防自触发：临时会话登记进进程内注册表，本插件对它的 chat.message /
 *   session.idle 一律跳过（蒸馏回复的 idle 不会再触发蒸馏）。
 *
 * 契约：
 * - fire-and-forget：event hook 立即返回，蒸馏在后台 promise 内完成，绝不阻塞
 *   宿主事件流；全程 fail-open（任何失败 = stderr 单行 warn 后静默跳过）；
 * - 素材：session.get（标题/时间）+ session.diff（FileDiff 修改记录），全部经
 *   官方 SDK 客户端，不直读内部存储（D21.3 纪律）；
 * - 去抖：同会话冷却窗口内只蒸馏一次（进程内记忆，Map 上限防膨胀）；
 * - 开关：SUBCONSCIOUS_DISTILL=0 关闭（其余任何值含未设置 = 开）；
 * - 不做网络重试；core 零 LLM 红线不破（蒸馏只由宿主模型经官方 client 执行）。
 *
 * 校验纪律（CONVENTIONS §4，不信模型输出）：JSON 解析失败 → 放弃；逐条形状校验
 * （expression ≤16 字 / content ≤120 字）→ 非法丢弃；超 5 条截断；敏感内容粗筛
 * 命中即丢弃该条；与现有条目逐字节相同的输出直接丢弃（防「洗时间」，core upsert
 * 亦 no-op，双保险）。
 */
import { randomBytes } from "node:crypto";
import { isConvention } from "@subconscious/core";
import type { ConventionEntry, Logger, MemoryStore } from "@subconscious/core";
import { fileMemoryStoreFor, resolveMemoryFilePath } from "./memory.js";
import type { SessionClient } from "./host-env.js";

/** 蒸馏总开关变量：值为 "0" 时关闭（其余任何值含未设置 = 开） */
export const DISTILL_ENV_VAR = "SUBCONSCIOUS_DISTILL";
/** 蒸馏超时覆盖（正整数毫秒；缺省 DEFAULT_DISTILL_TIMEOUT_MS，上限 MAX） */
export const DISTILL_TIMEOUT_ENV_VAR = "SUBCONSCIOUS_DISTILL_TIMEOUT_MS";
/** 单次蒸馏最多采纳的惯例条数（超 5 截断，CONVENTIONS §4 规则 5） */
export const MAX_DISTILL_CONVENTIONS = 5;
/** 组装进提示词的素材字符上限 */
export const DISTILL_MATERIAL_MAX_CHARS = 12_000;
/** 蒸馏默认超时（CONVENTIONS §3：建议 60s 上限） */
export const DEFAULT_DISTILL_TIMEOUT_MS = 60_000;
/** 蒸馏超时上限（防误配） */
export const MAX_DISTILL_TIMEOUT_MS = 300_000;
/**
 * 同会话蒸馏冷却窗口：session.idle 每轮回复后都触发（不是「会话销毁」），每会话
 * 至多一次会把素材冻结在首轮——冷却窗口允许长会话阶段性重蒸馏（upsert 语义下
 * 相同内容 no-op，只有素材演化才更新），又把成本约束在每会话每窗口至多一次。
 */
export const DISTILL_COOLDOWN_MS = 30 * 60_000;
/** 去抖记忆容量上限（长寿命插件进程防无界增长；超出淘汰最早记录） */
export const MAX_DISTILL_DEBOUNCE_ENTRIES = 512;
/** 临时会话注册表容量上限（同上） */
export const MAX_TEMP_SESSIONS = 256;
/** 临时蒸馏会话标题（删除失败时用户可辨识并手工清理） */
export const DISTILL_TEMP_SESSION_TITLE = "subconscious 惯例蒸馏（临时，可删除）";

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

export function resolveDistillTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DISTILL_TIMEOUT_ENV_VAR];
  if (raw === undefined) return DEFAULT_DISTILL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_DISTILL_TIMEOUT_MS;
  return Math.min(n, MAX_DISTILL_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// 临时会话注册表（防自触发：本插件对蒸馏临时会话的事件/消息一律跳过）
// ---------------------------------------------------------------------------

const tempSessions = new Set<string>();

/** 登记蒸馏临时会话（create 后、prompt 前调用） */
export function markDistillTempSession(sessionID: string): void {
  if (tempSessions.size >= MAX_TEMP_SESSIONS) {
    const oldest = tempSessions.values().next();
    if (!oldest.done) tempSessions.delete(oldest.value);
  }
  tempSessions.add(sessionID);
}

/** 是否为蒸馏临时会话（chat.message / session.idle 跳过用） */
export function isDistillTempSession(sessionID: string): boolean {
  return tempSessions.has(sessionID);
}

// ---------------------------------------------------------------------------
// 蒸馏执行面：临时会话 + client.session.prompt（官方 client 侧 LLM 调用）
// ---------------------------------------------------------------------------

/**
 * 官方 session 客户端的蒸馏子面（真实 client.session 结构性满足；测试注入假实现）。
 * prompt 响应载荷为 unknown：宿主 API 可能来自 JS，形状校验在本模块完成。
 */
export interface DistillSessionClient {
  create(options?: { body?: { title?: string }; query?: { directory?: string } }): Promise<{ data?: unknown }>;
  prompt(options: {
    body: {
      parts: Array<{ type: "text"; text: string }>;
      system?: string;
      tools?: Record<string, boolean>;
    };
    path: { id: string };
    query?: { directory?: string };
  }): Promise<{ data?: unknown }>;
  delete(options: { path: { id: string } }): Promise<{ data?: unknown }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 从 prompt 响应提取助手回复文本：{ info, parts } 里 text part 拼接；形状非法 → null */
function extractAssistantText(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const info = data.info;
  if (isRecord(info) && info.error !== undefined) return null; // AssistantMessage.error → 蒸馏失败
  if (!Array.isArray(data.parts)) return null;
  const texts: string[] = [];
  for (const part of data.parts) {
    if (!isRecord(part) || part.type !== "text") continue;
    if (typeof part.text === "string" && part.text !== "") texts.push(part.text);
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/** 无 reject 外溢的总超时 race：超时 → reject（调用方 fail-open），迟到 rejection 就地吞掉 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`蒸馏超时 ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * 蒸馏执行器：临时会话内 prompt 官方 client（tools 全禁用 + 系统提示约束 JSON
 * 输出），读完回复即删临时会话。任何失败 reject（调用方 fail-open 放弃本次蒸馏）。
 */
export async function distillViaTempSession(
  prompt: string,
  client: DistillSessionClient,
  directory: string,
  timeoutMs: number,
): Promise<string> {
  const created = await withTimeout(
    client.create({ body: { title: DISTILL_TEMP_SESSION_TITLE }, ...(directory !== "" ? { query: { directory } } : {}) }),
    timeoutMs,
  );
  const sessionID = isRecord(created.data) && typeof created.data.id === "string" ? created.data.id : "";
  if (sessionID === "") throw new Error("临时会话创建失败（响应缺 id）");
  markDistillTempSession(sessionID);
  try {
    const replied = await withTimeout(
      client.prompt({
        body: {
          parts: [{ type: "text", text: "请阅读系统提示中的会话记录并开始蒸馏。" }],
          system: prompt,
          tools: {}, // 蒸馏不需要任何工具：结构性禁用（宁可用不上，不可误用）
        },
        path: { id: sessionID },
        ...(directory !== "" ? { query: { directory } } : {}),
      }),
      timeoutMs,
    );
    const text = extractAssistantText(replied.data);
    if (text === null) throw new Error("蒸馏回复不可用（缺 text part 或携带错误）");
    return text;
  } finally {
    await client.delete({ path: { id: sessionID } }).catch(() => undefined); // 删除失败：标题可辨识，不阻塞
  }
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
// 会话素材（session.get + session.diff，全走官方 SDK 客户端；任务书 M5c-2 定界）
// ---------------------------------------------------------------------------

/** 素材内修改记录条数上限 */
export const MATERIAL_MAX_CHANGES = 60;
/** 素材内单条 FileDiff 的 before/after 摘录字符上限 */
export const MATERIAL_DIFF_MAX_CHARS = 80;
/** 素材内标题字符上限 */
export const MATERIAL_TITLE_MAX_CHARS = 80;

export interface SessionMaterial {
  readonly sessionTitle: string;
  readonly material: string;
}

/**
 * 读取会话素材：session.get（标题/时间）+ session.diff（FileDiff 列表）。
 * 任何失败 → null（fail-open 跳过本次蒸馏）；不直读内部存储。
 */
export async function readSessionMaterial(session: SessionClient, sessionID: string): Promise<SessionMaterial | null> {
  let info: { data?: unknown };
  try {
    info = await session.get(sessionID);
  } catch {
    return null;
  }
  if (!isRecord(info.data)) return null;
  const title = typeof info.data.title === "string" ? info.data.title : "";
  let diff: { data?: unknown };
  try {
    diff = await session.diff(sessionID);
  } catch {
    return null;
  }
  if (!Array.isArray(diff.data)) return null;
  const lines: string[] = [`会话标题：${title === "" ? "（无标题）" : title.slice(0, MATERIAL_TITLE_MAX_CHARS)}`];
  const changes: string[] = [];
  for (const raw of diff.data) {
    if (!isRecord(raw)) continue;
    const { file, before, after } = raw;
    if (typeof file !== "string" || file === "") continue;
    if (typeof before !== "string" || typeof after !== "string") continue;
    const additions = typeof raw.additions === "number" ? raw.additions : 0;
    const deletions = typeof raw.deletions === "number" ? raw.deletions : 0;
    changes.push(
      `- [edit] ${file}（+${additions}/-${deletions}）：${JSON.stringify(before.slice(0, MATERIAL_DIFF_MAX_CHARS))} → ${JSON.stringify(after.slice(0, MATERIAL_DIFF_MAX_CHARS))}`,
    );
    if (changes.length >= MATERIAL_MAX_CHANGES) break;
  }
  lines.push(`修改记录（FileDiff，${changes.length} 条）：`);
  for (const change of changes) lines.push(change);
  return { sessionTitle: title.slice(0, MATERIAL_TITLE_MAX_CHARS), material: lines.join("\n").slice(0, DISTILL_MATERIAL_MAX_CHARS) };
}

// ---------------------------------------------------------------------------
// 去抖（进程内记忆；同会话冷却窗口内只蒸馏一次）
// ---------------------------------------------------------------------------

export interface DistillDebouncer {
  /** true = 本次应蒸馏并已记录；false = 冷却窗口内重复事件，跳过 */
  shouldDistill(key: string, now: number): boolean;
}

/** Map 保序做 FIFO 淘汰；cooldownMs 缺省 DISTILL_COOLDOWN_MS（session.idle 每轮触发） */
export function createDistillDebouncer(
  cooldownMs: number = DISTILL_COOLDOWN_MS,
  maxEntries: number = MAX_DISTILL_DEBOUNCE_ENTRIES,
): DistillDebouncer {
  const seen = new Map<string, number>();
  return {
    shouldDistill(key: string, now: number): boolean {
      const last = seen.get(key);
      if (last !== undefined && now - last < cooldownMs) return false; // 冷却窗口内
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
  const executor = options.executor ?? ((_prompt: string) => Promise.reject(new Error("缺少蒸馏 client（session 不可用）")));
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
