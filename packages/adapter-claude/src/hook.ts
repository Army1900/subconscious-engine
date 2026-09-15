/**
 * UserPromptSubmit 主处理器（DESIGN §7.3、§8.2 降级矩阵）。
 *
 * 契约：
 * - 引擎只登记 L0 数据源（子进程 hook 无授权确认通道，L1/L2/L3 一律不启用——
 *   DESIGN §7.3「只服务 L0 数据源 + resolved 态」）。
 * - InteractPort 用录制型 unsupported：confirm/select/acquire 不可用时 core 按
 *   降级路径丢弃该指代；本层把 core 试图发起的交互（候选列表 / 获取提示）转写为
 *   「待确认」注入块，让大模型去问用户——等同现状，不劣化，也不冒充已解析。
 * - 已解析块（core 组装，头 `[潜意识引擎·已解析]`）在前，待确认块（头
 *   `[潜意识引擎·待确认]`）在后，总量受 maxContextChars 界限。
 * - 附件通道在 UserPromptSubmit 协议中不存在（additionalContext 为纯文本）：
 *   出现附件时记 warn 丢弃，不塞 base64 进文本（D8.4 同源纪律）。
 * - 整个流程 try/catch，任何异常返回 undefined（fail-open：表现为「没生效」，
 *   绝不阻塞 hook，DESIGN §5.3）。
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
  Logger,
  SubconsciousEngine,
} from "@subconscious/core";
import { createClaudeHostEnv } from "./host-env.js";
import type { GitExec } from "./host-env.js";
import type { ClaudeHookInput } from "./input.js";
import { createRecordingUnsupportedInteract } from "./interact.js";
import type { InteractionRecord } from "./interact.js";
import { embeddingDetectorResolver } from "./embedding-optin.js";
import type { EmbeddingDetectorResolver } from "./embedding-optin.js";
import { wireMemory } from "./memory.js";

/** 本适配器登记的 L0 数据源（DESIGN §7.3；不含 L1 clipboard / L3 image-acquisition） */
export const CLAUDE_L0_SOURCES: readonly DataSource[] = [
  cwdContextSource,
  activeEditorSource,
  recentSessionsSource,
  sessionContentSource,
];

/** 待确认注入块头（区别于 core 的「已解析」头：不冒充解析完成） */
export const PENDING_HEADER = "[潜意识引擎·待确认]";

/** 待确认行数上限（防御性：注入不因交互风暴膨胀） */
export const MAX_HINT_LINES = 5;

export interface HookHandlerOptions {
  /** 覆盖数据源集合（默认 CLAUDE_L0_SOURCES；宿主如确认有更安全的能力可扩展） */
  sources?: readonly DataSource[];
  /** 引擎界限；缺省 core 默认（timeoutMs=3000 等） */
  limits?: Partial<EngineLimits>;
  logger?: Logger;
  /** 可注入依赖（测试/演示走同一代码路径） */
  deps?: {
    /** git 执行器；缺省真实 node 子进程 */
    exec?: GitExec;
    /** 引擎工厂；缺省 core createEngine（异常注入测试用） */
    createEngineFn?: (options: EngineOptions) => SubconsciousEngine;
    /** embedding 检测器 resolver；缺省模块级单例（SUBCONSCIOUS_EMBEDDING opt-in） */
    embeddingResolver?: EmbeddingDetectorResolver;
    /** env 快照；缺省 process.env（记忆路径 SUBCONSCIOUS_MEMORY_FILE 等测试注入用） */
    env?: NodeJS.ProcessEnv;
  };
}

/** 处理结果：additionalContext 即 hook 协议的 additionalContext 字段载荷 */
export interface HookOutput {
  readonly additionalContext: string;
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

/** 已解析块 + 待确认块 → 最终 additionalContext；两者皆无 → undefined（no-op） */
export function composeAdditionalContext(
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

export async function handleUserPromptSubmit(
  input: ClaudeHookInput,
  options: HookHandlerOptions = {},
): Promise<HookOutput | undefined> {
  const limits: EngineLimits = { ...DEFAULT_ENGINE_LIMITS, ...options.limits };
  const interact = createRecordingUnsupportedInteract();
  const logger = options.logger;
  try {
    const env = createClaudeHostEnv(input, options.deps?.exec !== undefined ? { exec: options.deps.exec } : {});
    const createEngineFn = options.deps?.createEngineFn ?? createEngine;
    // embedding opt-in（SUBCONSCIOUS_EMBEDDING=1）：未 opt-in 时 resolve 立即 undefined，
    // 引擎不传 detector，行为与接线前逐字节一致；不可用/超时同样回退规则（fail-open）
    const embeddingDetector = await (options.deps?.embeddingResolver ?? embeddingDetectorResolver).resolve({ logger });
    // 记忆接线（M5b，D24）：读取词典（本宿主即每 prompt 重读）并组合检测器；store 恒
    // 传入（本宿主 select 不可用故不学习，但共享先验可自动代选）；记忆任何故障
    // fail-open 为无记忆，绝不阻塞 hook（总超时预算内的毫秒级文件读）
    const memory = await wireMemory(embeddingDetector, { env: options.deps?.env, logger });
    const engineOptions: EngineOptions = {
      sources: options.sources ?? CLAUDE_L0_SOURCES,
      interact,
      memory: memory.store,
      ...(memory.detector !== undefined ? { detector: memory.detector } : {}),
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      ...(logger !== undefined ? { logger } : {}),
    };
    const engine = createEngineFn(engineOptions);
    const output = await engine.enrich(input.prompt, env);

    if (output.attachments !== undefined && output.attachments.length > 0) {
      // UserPromptSubmit 的 additionalContext 是纯文本通道：附件丢弃并如实记日志，
      // 绝不把 base64 塞进文本上下文（D8.4）。
      logger?.({
        level: "warn",
        event: "attachments-dropped",
        detail: `UserPromptSubmit 无附件通道，丢弃 ${output.attachments.length} 个附件`,
      });
    }

    const additionalContext = composeAdditionalContext(output, interact.records, limits);
    return additionalContext === undefined ? undefined : { additionalContext };
  } catch (err) {
    // fail-open：返回 undefined，入口输出空、退出 0，prompt 原样透传
    logger?.({ level: "error", event: "hook-error", detail: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}
