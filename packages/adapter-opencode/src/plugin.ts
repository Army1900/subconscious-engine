/**
 * OpenCode plugin 入口（DESIGN §7.4、§8.2 降级矩阵；docs/ACCEPTANCE「OpenCode」行）。
 *
 * 协议事实（@opencode-ai/plugin@1.18.30 dist/index.d.ts + 官方文档
 * https://opencode.ai/docs/plugins ，2026-09-14 核实）：
 * - 插件形态：模块导出 `Plugin = (input: PluginInput, options?) => Promise<Hooks>`，
 *   `PluginInput { client（SDK 客户端）; project; directory; worktree; serverUrl; $ }`；
 *   经 opencode.json 的 `"plugin": [...]`（npm 包）或 `.opencode/plugins/` /
 *   `~/.config/opencode/plugins/`（本地文件）加载，hooks 顺序执行；
 * - 插入点：`Hooks["chat.message"]`——"Called when a new message is received"，
 *   `(input { sessionID, agent?, model?, messageID?, variant? },
 *   output { message: UserMessage; parts: Part[] }) => Promise<void>`。output 按引用
 *   传入，宿主 await 后把同一对象持久化并送 LLM——突变 parts 即改写当前这条用户
 *   消息（官方文档事件列表未单独列出此 hook，以锁定版本类型声明为准，报告已注明）；
 * - 只改当前用户消息：注入走 inject.ts 的 append-only 纪律；不 push 新 part、
 *   不动历史消息（experimental.chat.messages.transform 才触及历史，禁用）；
 * - 无插件可调用的 confirm/select/input/文件选取 API（Tui 客户端有 toast，非对话
 *   式确认通道）→ InteractPort 用录制型 unsupported，降级矩阵同 Claude Code：
 *   ambiguous → 注入候选让 LLM 问用户；need-acquisition → 注入提示；L1/L2 无确认
 *   通道不读取（只登记 L0 数据源）。
 *
 * fail-open：整个流程 try/catch + 总超时（默认 5s = 引擎 3s 机器预算 + 余量，
 * SUBCONSCIOUS_OPENCODE_TIMEOUT_MS 可覆盖），任何失败表现为「没生效」，
 * 绝不阻塞宿主消息流。
 */
import {
  activeEditorSource,
  createEngine,
  cwdContextSource,
  DEFAULT_ENGINE_LIMITS,
  recentSessionsSource,
  sessionContentSource,
  truncate,
} from "@subconscious/core";
import type {
  DataSource,
  EngineLimits,
  EngineOptions,
  EnrichOutput,
  LogEntry,
  Logger,
  SubconsciousEngine,
} from "@subconscious/core";
import type { Plugin } from "@opencode-ai/plugin";
import { extractUserPrompt, injectIntoParts } from "./inject.js";
import type { ChatPartLike } from "./inject.js";
import { createOpenCodeHostEnv } from "./host-env.js";
import type { GitExec, SessionClient } from "./host-env.js";
import { createRecordingUnsupportedInteract } from "./interact.js";
import type { InteractionRecord } from "./interact.js";
import { embeddingDetectorResolver } from "./embedding-optin.js";
import type { EmbeddingDetectorResolver } from "./embedding-optin.js";
import { wireMemory } from "./memory.js";

/** 本适配器登记的 L0 数据源（无确认通道，L1 clipboard / L3 image-acquisition 不注册） */
export const OPENCODE_L0_SOURCES: readonly DataSource[] = [
  cwdContextSource,
  activeEditorSource,
  recentSessionsSource,
  sessionContentSource,
];

/** core 组装器注入头的镜像（core/assembler.ts 固定头；此处仅用于断言/展示对齐） */
export const RESOLVED_HEADER = "[潜意识引擎·已解析]";

/** 待确认注入块头（区别于「已解析」头：不冒充解析完成） */
export const PENDING_HEADER = "[潜意识引擎·待确认]";

/** 待确认行数上限（防御性：注入不因交互风暴膨胀） */
export const MAX_HINT_LINES = 5;

/** 适配器总超时默认 5s（引擎机器预算 3s + 余量；chat.message 是进程内 await） */
export const DEFAULT_TOTAL_TIMEOUT_MS = 5000;

/** 总超时上限（防误配把宿主消息流卡死半分钟以上） */
export const MAX_TOTAL_TIMEOUT_MS = 30000;

const TIMEOUT_ENV_VAR = "SUBCONSCIOUS_OPENCODE_TIMEOUT_MS";

export function resolvePluginTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TIMEOUT_ENV_VAR];
  if (raw === undefined) return DEFAULT_TOTAL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_TOTAL_TIMEOUT_MS;
  return Math.min(n, MAX_TOTAL_TIMEOUT_MS);
}

/** 日志走 stderr JSON 行（进程内插件，stdout/console.log 可能污染宿主输出） */
function stderrLog(entry: LogEntry): void {
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // stderr 写失败（管道已断等）：吞掉，绝不影响注入路径
  }
}

/** 官方 SDK session 客户端的结构子面（真实 client.session 即满足；测试注入假实现） */
export interface SdkSessionClient {
  list(options?: { query?: { directory?: string } }): Promise<{ data?: unknown }>;
  get(options: { path: { id: string } }): Promise<{ data?: unknown }>;
  diff(options: { path: { id: string } }): Promise<{ data?: unknown }>;
}

/** SDK client（heyapi 形状）→ host-env 的窄 SessionClient */
export function toSessionClient(session: SdkSessionClient | undefined): SessionClient | undefined {
  if (session === undefined) return undefined;
  return {
    list: (query) => session.list({ query }),
    get: (id) => session.get({ path: { id } }),
    diff: (id) => session.diff({ path: { id } }),
  };
}

/** chat.message 的请求侧：cwd 只取官方 PluginInput.directory（缺失即 no-op，不猜） */
export interface ChatMessageRequest {
  sessionID: string;
  cwd: string;
  client?: { session?: SdkSessionClient };
}

/** chat.message 的输出侧结构子面（真实 { message: UserMessage; parts: Part[] } 满足） */
export interface ChatMessageOutputLike {
  parts: readonly ChatPartLike[];
}

export interface PluginHandlerOptions {
  /** 覆盖数据源集合（默认 OPENCODE_L0_SOURCES） */
  sources?: readonly DataSource[];
  /** 引擎界限；缺省 core 默认（timeoutMs=3000 等） */
  limits?: Partial<EngineLimits>;
  logger?: Logger;
  /** 适配器总超时；缺省 resolvePluginTimeoutMs() */
  totalTimeoutMs?: number;
  /** 可注入依赖（测试/演示走同一代码路径） */
  deps?: {
    /** git 执行器；缺省真实 node 子进程 */
    exec?: GitExec;
    /** 引擎工厂；缺省 core createEngine（异常/悬挂注入测试用） */
    createEngineFn?: (options: EngineOptions) => SubconsciousEngine;
    /** embedding 检测器 resolver；缺省模块级单例（SUBCONSCIOUS_EMBEDDING opt-in） */
    embeddingResolver?: EmbeddingDetectorResolver;
    /** env 快照；缺省 process.env（记忆路径 SUBCONSCIOUS_MEMORY_FILE 等测试注入用） */
    env?: NodeJS.ProcessEnv;
  };
}

function hintLine(record: InteractionRecord): string {
  switch (record.kind) {
    case "select":
      return `${record.title}候选：${record.labels.join("；")}（本环境无法弹出选择器，请向用户确认后再使用）`;
    case "acquire":
      return `需要补充数据：${record.spec.prompt}（本环境无法自动获取，请向用户询问后补充）`;
    case "confirm":
      return `需要用户确认：${record.prompt}（本环境无确认通道，默认未读取）`;
  }
}

/** 被降级交互 → 待确认注入块；无记录 → undefined */
function composePendingHints(records: readonly InteractionRecord[], limits: EngineLimits): string | undefined {
  if (records.length === 0) return undefined;
  const shown = records.slice(0, MAX_HINT_LINES).map(hintLine);
  const omitted = records.length - shown.length;
  const lines = [...shown.map((line) => `- ${line}`)];
  if (omitted > 0) lines.push(`- [另有 ${omitted} 项待确认交互未列出]`);
  let block = PENDING_HEADER;
  for (const line of lines) block += `\n${line}`;
  return truncate(block, limits.maxContextChars);
}

/** 已解析块（core 组装）+ 待确认块（降级交互）→ 最终注入物；两者皆无 → undefined */
export function composeInjectionContext(
  output: EnrichOutput,
  records: readonly InteractionRecord[],
  limits: EngineLimits,
): string | undefined {
  const blocks: string[] = [];
  if (output.context !== undefined && output.context !== "") blocks.push(output.context);
  const hints = composePendingHints(records, limits);
  if (hints !== undefined) blocks.push(hints);
  if (blocks.length === 0) return undefined;
  return truncate(blocks.join("\n"), limits.maxContextChars);
}

/** 总超时 race：超时/异常都 resolve undefined（fail-open），绝不 reject；迟到 rejection 不外溢 */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * chat.message 主处理器：提取用户话语 → 引擎 enrich（机器预算内）→ 组装注入物 →
 * append-only 追加到当前用户消息。返回是否注入成功；永不抛出（fail-open）。
 */
export async function handleChatMessage(
  req: ChatMessageRequest,
  output: ChatMessageOutputLike,
  options: PluginHandlerOptions = {},
): Promise<boolean> {
  const logger = options.logger;
  if (req.cwd === "") return false; // 官方 directory 缺失即 no-op，不回退 process.cwd()
  const prompt = extractUserPrompt(output.parts);
  if (prompt === "") return false; // 无用户话语可解析（合成/纯附件消息）
  const interact = createRecordingUnsupportedInteract();
  const limits: EngineLimits = { ...DEFAULT_ENGINE_LIMITS, ...options.limits };
  const totalTimeoutMs = options.totalTimeoutMs ?? resolvePluginTimeoutMs();
  try {
    const env = createOpenCodeHostEnv(
      { cwd: req.cwd, ...(req.sessionID !== "" ? { currentSessionId: req.sessionID } : {}) },
      {
        session: toSessionClient(req.client?.session),
        ...(options.deps?.exec !== undefined ? { exec: options.deps.exec } : {}),
      },
    );
    const createEngineFn = options.deps?.createEngineFn ?? createEngine;
    // embedding opt-in（SUBCONSCIOUS_EMBEDDING=1）：未 opt-in 时 resolve 立即 undefined，
    // 引擎不传 detector，行为与接线前逐字节一致；不可用/超时同样回退规则（fail-open）
    const embeddingDetector = await (options.deps?.embeddingResolver ?? embeddingDetectorResolver).resolve({ logger });
    // 记忆接线（M5b，D24）：每条消息重读词典（D11 → 手工编辑热生效）并组合检测器；
    // store 恒传入（本宿主 select 不可用故不学习，但共享先验可自动代选）；记忆任何
    // 故障 fail-open 为无记忆，绝不阻塞宿主消息流
    const memory = await wireMemory(embeddingDetector, { env: options.deps?.env, logger });
    const engine = createEngineFn({
      sources: options.sources ?? OPENCODE_L0_SOURCES,
      interact,
      memory: memory.store,
      ...(memory.detector !== undefined ? { detector: memory.detector } : {}),
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      ...(logger !== undefined ? { logger } : {}),
    });
    const enriched = await withTimeout(engine.enrich(prompt, env), totalTimeoutMs, () => {
      logger?.({ level: "warn", event: "plugin-timeout", detail: `总超时 ${totalTimeoutMs}ms，放弃注入` });
    });
    if (enriched === undefined) return false;

    if (enriched.attachments !== undefined && enriched.attachments.length > 0) {
      // 本注入通道是用户消息的 text part：附件丢弃并如实记日志，绝不塞 base64（D8.4）
      logger?.({
        level: "warn",
        event: "attachments-dropped",
        detail: `chat.message 文本注入通道不支持附件，丢弃 ${enriched.attachments.length} 个附件`,
      });
    }

    const context = composeInjectionContext(enriched, interact.records, limits);
    if (context === undefined) return false;
    return injectIntoParts(output.parts, context);
  } catch (err) {
    // fail-open：任何异常表现为「没生效」，parts 原样透传
    logger?.({ level: "error", event: "plugin-error", detail: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * 官方 Plugin 入口：安装方式（任选其一）：
 * - npm：opencode.json `{"plugin": ["@subconscious/adapter-opencode"]}`；
 * - 本地：把构建产物 dist/plugin.js 以 ESM 引用放入 `.opencode/plugins/`。
 * 每次 chat.message 重建引擎实例（D11 同源：避免跨事件缓存宿主对象）。
 */
export const SubconsciousPlugin: Plugin = async (input) => ({
  "chat.message": (hookInput, hookOutput) =>
    handleChatMessage(
      { sessionID: hookInput.sessionID, cwd: input.directory, client: input.client },
      hookOutput,
      { logger: stderrLog },
    ).then(() => undefined),
});
