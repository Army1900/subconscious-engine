/**
 * 公共类型定义（DESIGN §6 + docs/DECISIONS.md D1/D2/D5/D8/D10）。
 *
 * 设计约束：
 * - core 零宿主依赖：HostEnv 是唯一耦合面，且只含数据与函数，不含宿主类型。
 * - ResolvedValue 为判别联合（D10），禁 unknown/any 载荷。
 * - 所有异步端口（HostEnv provider / InteractPort / DataSource.resolve）都携带取消信号。
 */

// ---------------------------------------------------------------------------
// 封闭类型集与授权级别
// ---------------------------------------------------------------------------

/** 期望数据类型（封闭集，新增需评审；D1 补齐 "project"） */
export type DataType =
  | "file"
  | "code-symbol"
  | "image"
  | "project"
  | "history-event"
  | "history-content"
  | "data-record"
  | "person"
  | "number"
  | "text";

/** 授权级别（DESIGN §5.1） */
export type PermissionLevel =
  | "L0-free"
  | "L1-grant-once"
  | "L2-confirm-each"
  | "L3-acquire";

// ---------------------------------------------------------------------------
// 指代检测
// ---------------------------------------------------------------------------

/** 悬空指代（检测器输出）。span 为原文 [start, end) 的 UTF-16 码元区间，text === prompt.slice(start, end) */
export interface DanglingRef {
  id: string;
  span: readonly [start: number, end: number];
  text: string;
  expectedType: DataType;
  /** 0-1，低于阈值不进入解析（DESIGN §4.1） */
  confidence: number;
}

/** 指代检测器：输入话语，输出显式出现的悬空指代。不做解析、不预测用户没说的需求 */
export interface Detector {
  detect(prompt: string): readonly DanglingRef[];
}

/**
 * 异步检测上下文（M3）：异步检测器与引擎共享同一机器预算（D3 单时钟纪律）。
 * remainingMs 为检测可用的剩余机器预算；signal 中止后不得再发起 embed。
 */
export interface DetectorContext {
  signal: AbortSignal;
  remainingMs(): number;
}

/**
 * 异步增强检测器（M3 embedding）：在同步 Detector 之上提供共享预算的异步检测路径。
 * 契约：同步 detect() 必须始终可用且永不抛出——它是异步路径一切失败（provider 缺失/
 * 加载失败/维度不匹配/预算耗尽/中止）的回退（fail-open，DESIGN §5.3）。
 */
export interface AsyncDetector extends Detector {
  detectAsync(prompt: string, ctx?: DetectorContext): Promise<readonly DanglingRef[]>;
}

// ---------------------------------------------------------------------------
// 解析结果四态（DESIGN §4.3）
// ---------------------------------------------------------------------------

export type ResolvedValue =
  | { type: "file"; path: string; line?: number }
  | { type: "code-symbol"; path: string; line?: number; symbol?: string }
  | { type: "image"; path: string; mediaType: string; base64: string }
  | { type: "project"; cwd: string; summary: string }
  | { type: "history-event"; sessionId: string; path?: string; title: string; at: string }
  | { type: "history-content"; sessionId: string; diff: string }
  | { type: "data-record"; recordId: string; summary: string }
  | { type: "person"; name: string }
  | { type: "number"; value: number }
  | { type: "text"; text: string };

/** 候选项：label 供 UI 展示，value 为选中后直接采用的值（携带稳定 id，D4） */
export interface Candidate {
  id: string;
  label: string;
  value: ResolvedValue;
}

/** 获取动作规格（由宿主适配器执行；触发纪律见 DESIGN §4.4） */
export interface AcquisitionSpec {
  kind: "pick-file" | "pick-image" | "pick-candidate" | "input";
  prompt: string;
  candidates?: readonly Candidate[];
  expectedType: DataType;
}

export type Resolution =
  | { status: "resolved"; value: ResolvedValue; display: string }
  | { status: "ambiguous"; candidates: readonly Candidate[] }
  | { status: "need-acquisition"; acquisition: AcquisitionSpec }
  | { status: "not-found" };

// ---------------------------------------------------------------------------
// 宿主环境快照（D2：每调用传入，昂贵字段惰性）
// ---------------------------------------------------------------------------

/** 数据源读取请求：必须携带取消信号与字节上限（监督红线） */
export interface ReadRequest {
  signal: AbortSignal;
  maxBytes: number;
}

/** 当前编辑器状态（廉价快照数据）。缺失即缺失，core 绝不猜测（D6） */
export interface ActiveEditorState {
  path: string;
  line?: number;
  selection?: string;
}

/** 会话摘要。id 为宿主稳定的会话标识；at 为 ISO 时间字符串 */
export interface SessionSummary {
  id: string;
  path?: string;
  title: string;
  at: string;
}

/** 归一化的会话修改记录（适配器把宿主会话格式映射到此形状；core 做有界 diff 摘要，D9） */
export interface SessionChange {
  at: string;
  tool: "edit" | "write";
  path?: string;
  oldText?: string;
  newText?: string;
  content?: string;
  /** 关联工具结果标记为错误时跳过（D9） */
  isError?: boolean;
}

export interface SessionRecord {
  sessionId: string;
  changes: readonly SessionChange[];
}

export interface CwdSnapshot {
  cwd: string;
  gitStatus?: string;
  dirSummary?: string;
}

/** 绑定的会话引用：id 必须是 wave 1 解析或用户选择得到的稳定标识，不凭任意 ID 拼路径 */
export interface SessionRef {
  id: string;
  path?: string;
  title?: string;
}

/**
 * 宿主环境快照：core 唯一感知宿主的方式（DESIGN §6）。
 * D2：enrich(prompt, env) 每次调用显式传入；惰性 provider 未命中指代类型则永不被调用。
 * provider 返回 null 表示不可用/超限/编码非法，core 一律按 not-found 处理。
 */
export interface HostEnv {
  cwd: string;
  activeEditor?: ActiveEditorState | null;
  listRecentSessions?(req: ReadRequest): Promise<SessionSummary[] | null>;
  readSessionContent?(session: SessionRef, req: ReadRequest): Promise<SessionRecord | null>;
  readCwdContext?(req: ReadRequest): Promise<CwdSnapshot | null>;
  readClipboardText?(req: ReadRequest): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// 数据源与解析上下文
// ---------------------------------------------------------------------------

/** 解析上下文（D2.4）：取消信号 + 剩余预算 + 界限 + 历史绑定（wave 2 注入） */
export interface ResolveContext {
  signal: AbortSignal;
  remainingMs(): number;
  /** 引擎合并后的界限（字节/条数/片段上限；数据源只读） */
  limits: EngineLimits;
  /** wave 2（history-content）专用：绑定的会话；缺失时 session-content 源不得读取（双保险） */
  boundSession?: SessionRef;
}

/** 数据源：声明式登记服务类型与授权级别（DESIGN §4.2） */
export interface DataSource {
  id: string;
  types: readonly DataType[];
  permission: PermissionLevel;
  grantScope?: string;
  resolve(ref: DanglingRef, env: HostEnv, ctx: ResolveContext): Promise<Resolution>;
}

// ---------------------------------------------------------------------------
// 授权清单（DESIGN §5.2；M1 范围见 D7）
// ---------------------------------------------------------------------------

export interface GrantRecord {
  sourceId: string;
  scope?: string;
  grantedAt: string;
  /** ISO 时间；过期即失效 */
  expiresAt?: string;
}

export interface GrantQuery {
  sourceId: string;
  scope?: string;
}

export interface GrantWriteOptions {
  expiresAt?: string;
}

/** 授权清单读写接口。M1 交付内存实现；文件持久化归 M2（D7） */
export interface GrantStore {
  has(query: GrantQuery): Promise<boolean>;
  grant(query: GrantQuery, options?: GrantWriteOptions): Promise<void>;
  revoke(query: GrantQuery): Promise<void>;
  list(): Promise<readonly GrantRecord[]>;
}

// ---------------------------------------------------------------------------
// 交互端口（DESIGN §6 + D5：显式建模 unsupported，方法可带取消与超时）
// ---------------------------------------------------------------------------

export interface InteractOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface InteractPort {
  confirm(prompt: string, opts?: InteractOptions): Promise<"yes" | "no" | "unsupported">;
  select(title: string, options: readonly string[], opts?: InteractOptions): Promise<string | null | "unsupported">;
  acquire(spec: AcquisitionSpec, opts?: InteractOptions): Promise<ResolvedValue | null | "unsupported">;
}

// ---------------------------------------------------------------------------
// 组装输出（DESIGN §6 + D8：dropReasons 扩展、附件结构分离）
// ---------------------------------------------------------------------------

export interface ImageLike {
  mediaType: string;
  base64: string;
}

export type DropReason =
  | "low-confidence"
  | "no-source"
  | "not-found"
  | "permission-denied"
  | "interaction-unsupported"
  | "user-cancelled"
  | "acquisition-declined"
  | "no-binding"
  | "budget-exhausted"
  | "error";

export interface EnrichOutput {
  /** 结构化注入文本；无已解析项时为 undefined（no-op 透传） */
  context?: string;
  /** 图片附件走宿主图片通道，结构上不可能进入 context 文本（D8.4） */
  attachments?: ImageLike[];
  /** 供 UI 展示的已解析项 */
  resolvedRefs: ReadonlyArray<{ refId: string; display: string }>;
  /** 放弃的指代 id（透明性；DESIGN 原字段保持） */
  droppedRefs: readonly string[];
  /** 放弃原因映射（D8.3 兼容扩展） */
  dropReasons?: Readonly<Record<string, DropReason>>;
  /** 本次调用是否触达预算截止（透明性） */
  timedOut?: boolean;
}

// ---------------------------------------------------------------------------
// 个人记忆层（M5a：消歧先验 + 个人惯用语词典；见 docs/DECISIONS.md D24）
// ---------------------------------------------------------------------------

/**
 * 消歧先验：用户在 select 消歧中选定某历史会话的一次记录。
 * 只用于对既有显式指代的候选做排序/保守代选，绝不用于注入用户没提到的会话。
 */
export interface DisambiguationPrior {
  /** 项目标识：消歧发生时的 cwd（同项目 = 同路径字符串，精确匹配） */
  projectKey: string;
  sessionId: string;
  title: string;
  /** 选择发生时间（ISO 字符串） */
  at: string;
}

/**
 * 个人惯用语词条：短语 → 期望类型 + 可选解析提示。
 * v0 只显式注册（addPersonalPhrase / memory.json 手工编辑），不自动学习；
 * hint 仅存储与文档化，v0 不进入解析路径（预留）。
 */
export interface PersonalPhrase {
  phrase: string;
  expectedType: DataType;
  hint?: string;
}

/** ~/.subconscious/memory.json 文件形状（version 1） */
export interface MemoryData {
  version: 1;
  disambiguation: readonly DisambiguationPrior[];
  phrases: readonly PersonalPhrase[];
}

/**
 * 个人记忆存储端口。记忆是持久数据源而非引擎会话状态：
 * 引擎每次 enrich 按需读取，不跨请求缓存选择结果（快照纪律不变）。
 */
export interface MemoryStore {
  listDisambiguation(): Promise<readonly DisambiguationPrior[]>;
  /** 学习入口（引擎内只在用户显式选择后调用；非法输入由实现方受控忽略） */
  recordDisambiguation(entry: DisambiguationPrior): Promise<void>;
  listPhrases(): Promise<readonly PersonalPhrase[]>;
  /** 显式注册词条；非法词条受控失败（EngineConfigError "invalid-memory"） */
  addPersonalPhrase(entry: PersonalPhrase): Promise<void>;
}

// ---------------------------------------------------------------------------
// 引擎配置
// ---------------------------------------------------------------------------

/** 机器预算与交互预算分离的双时钟（D3.1）；所有上下文/读取界限（监督红线） */
export interface EngineLimits {
  /** 总机器预算，默认 3000ms */
  timeoutMs: number;
  /** 单次用户交互上限，默认 30000ms；等待用户期间机器时钟暂停 */
  interactTimeoutMs: number;
  /** 置信度阈值，低于此值不进入解析 */
  minConfidence: number;
  /** 注入文本总上限，超出截断并标注 */
  maxContextChars: number;
  /** 单次数据源读取字节上限 */
  maxSourceBytes: number;
  /** 列表类读取（会话/候选）条数上限 */
  maxListItems: number;
  /** 候选选择器条数上限 */
  maxCandidates: number;
  /** 单条 diff 片段字符上限 */
  maxDiffSnippetChars: number;
  /** 会话修改记录条数上限 */
  maxDiffEntries: number;
  /** 会话 diff 摘要总字符上限 */
  maxDiffChars: number;
  /** 单个指代展示文本上限 */
  maxRefDisplayChars: number;
}

export const DEFAULT_ENGINE_LIMITS: Readonly<EngineLimits> = {
  timeoutMs: 3000,
  interactTimeoutMs: 30000,
  minConfidence: 0.5,
  maxContextChars: 4000,
  maxSourceBytes: 64000,
  maxListItems: 10,
  maxCandidates: 8,
  maxDiffEntries: 20,
  maxDiffSnippetChars: 400,
  maxDiffChars: 1600,
  maxRefDisplayChars: 1200,
};

/** 计时器抽象：显式来源，测试可注入手动时钟（监督要求取消/计时类型不靠传递依赖偶然引入） */
export type TimerHandle = unknown;

export interface Timer {
  now(): number;
  set(fn: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  event: string;
  refId?: string;
  sourceId?: string;
  detail?: string;
}

export type Logger = (entry: LogEntry) => void;

export interface EngineOptions {
  /** 默认规则版检测器 */
  detector?: Detector;
  /** 数据源集合；重复 id / 未知类型在构造期抛 EngineConfigError（受控失败） */
  sources: readonly DataSource[];
  /** 授权清单；默认内存实现（D7） */
  grants?: GrantStore;
  /** 交互端口；默认全 unsupported（降级路径，D5） */
  interact?: InteractPort;
  limits?: Partial<EngineLimits>;
  /** 个人记忆层（M5a）：消歧先验的学习与加权；缺省无记忆，行为与无此层一致 */
  memory?: MemoryStore;
  /** 计时器；默认系统时钟，测试注入手动时钟 */
  timer?: Timer;
  /** 日志；故障被吞掉前记录（DESIGN §8.1） */
  logger?: Logger;
}

/** 引擎实例。enrich 永不抛出（fail-open）；构造期校验失败抛 EngineConfigError */
export interface SubconsciousEngine {
  /**
   * 主流程：输入原话与本次环境快照，输出注入物。
   * env 每次调用显式传入（D2），不跨请求串历史选择。
   */
  enrich(prompt: string, env: HostEnv): Promise<EnrichOutput>;
}
