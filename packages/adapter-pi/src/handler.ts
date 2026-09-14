/**
 * before_agent_start 处理器（DESIGN §7.1/§7.2、DECISIONS D11）。
 *
 * 契约：
 * - 每次事件重建引擎与 HostEnv（D11：不跨事件缓存 ctx，避免 pi 会话切换后的失效引用）；
 * - enrich 输出无 context → 返回 undefined（no-op 透传，pi 行为与裸 pi 一致）；
 * - 有 context → 返回持久化、发给 LLM、用户可见的 custom message（display: true）；
 *   dropped/resolved 明细放 details（pi 协议中 details 不进 LLM 上下文，仅供 UI/审计）；
 * - 任何异常：记日志后返回 undefined，prompt 原样透传（DESIGN §5.3 fail-open 红线——
 *   本引擎的故障必须表现为「它没生效」，绝不能表现为「agent 不能用了」）；
 * - 附件（attachments）在 M1 不注入（监督定界：图片通道/附件大小/已有附件合并归 M2），
 *   出现时记 warn 并丢弃附件、保留已解析文本——不虚构完成。
 */
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import {
  createEngine,
  DEFAULT_SOURCES,
} from "@subconscious/core";
import type {
  ActiveEditorState,
  EngineLimits,
  EngineOptions,
  EnrichOutput,
  Logger,
  SubconsciousEngine,
} from "@subconscious/core";
import { createPiHostEnv } from "./host-env.js";
import type { ListSessionsFn, PiExec, PiHostContext } from "./host-env.js";
import { createPiInteract } from "./interact.js";
import type { PiUiContext } from "./interact.js";

/**
 * 本 handler 依赖的事件/上下文子面。真实 BeforeAgentStartEvent 与 ExtensionContext
 * 结构性满足（参数逆变），因此 index.ts 里对真实 ExtensionAPI 的注册行
 * `pi.on("before_agent_start", handler)` 直接通过官方类型检查——这是
 * 「官方 SDK 类型通过」的编译期证据。
 */
export type PiBeforeAgentStartEvent = Pick<BeforeAgentStartEvent, "type" | "prompt">;

export interface PiHandlerContext extends PiHostContext, PiUiContext {}

export type BeforeAgentStartHandler = (
  event: PiBeforeAgentStartEvent,
  ctx: PiHandlerContext,
) => Promise<BeforeAgentStartEventResult | undefined> | BeforeAgentStartEventResult | undefined;

/** 可注入依赖（测试/演示走同一代码路径；缺省用真实实现） */
export interface AdapterDeps {
  /** pi.exec；缺省时 cwd-context 的 git 部分不可用（目录摘要仍可用） */
  exec?: PiExec;
  /** 会话列表；缺省 SessionManager.list */
  listSessions?: ListSessionsFn;
  /** 引擎工厂；缺省 core createEngine（异常注入测试用） */
  createEngineFn?: (options: EngineOptions) => SubconsciousEngine;
}

export interface HandlerOptions {
  deps?: AdapterDeps;
  /** 宿主编辑器状态夹具：真实 pi 不提供（D6）；仅 demo/宿主夹具使用 */
  activeEditor?: ActiveEditorState | null;
  /** 引擎界限；缺省 core 默认（timeoutMs=3000 等） */
  limits?: Partial<EngineLimits>;
  logger?: Logger;
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** EnrichOutput → pi 注入结果。无 context → undefined（no-op） */
export function toEventResult(output: EnrichOutput, logger?: Logger): BeforeAgentStartEventResult | undefined {
  if (output.context === undefined || output.context === "") return undefined;
  if (output.attachments !== undefined && output.attachments.length > 0) {
    // M1 定界（DECISIONS 附）：附件通道（宿主消息协议、大小上限、已有附件合并）归 M2。
    // 已解析文本照常注入，附件不注入不谎报；M2 交付时移除此分支。
    logger?.({
      level: "warn",
      event: "attachments-unsupported-m1",
      detail: `丢弃 ${output.attachments.length} 个附件：附件通道归 M2`,
    });
  }
  return {
    message: {
      customType: "subconscious",
      content: output.context,
      display: true, // 透明性：注入对用户可见（DESIGN §4.5）
      details: {
        resolvedRefs: output.resolvedRefs,
        droppedRefs: output.droppedRefs,
        dropReasons: output.dropReasons,
        timedOut: output.timedOut,
      },
    },
  };
}

export function createBeforeAgentStartHandler(options: HandlerOptions = {}): BeforeAgentStartHandler {
  const deps = options.deps ?? {};
  const createEngineFn = deps.createEngineFn ?? createEngine;
  return async (event, ctx) => {
    try {
      // 每次事件重建 env 与引擎（D11）；enrich 内部自带 3s 机器预算与交互双时钟
      const env = createPiHostEnv(ctx, {
        ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
        ...(deps.listSessions !== undefined ? { listSessions: deps.listSessions } : {}),
        ...(options.activeEditor !== undefined ? { activeEditor: options.activeEditor } : {}),
      });
      const engineOptions: EngineOptions = {
        sources: DEFAULT_SOURCES,
        interact: createPiInteract(ctx),
        ...(options.limits !== undefined ? { limits: options.limits } : {}),
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
      };
      const engine = createEngineFn(engineOptions);
      const output = await engine.enrich(event.prompt, env);
      return toEventResult(output, options.logger);
    } catch (err) {
      // 异常原样透传：返回 undefined，用户 prompt 不受影响（DESIGN §7.1.3/§5.3）
      options.logger?.({ level: "error", event: "handler-error", detail: messageOf(err) });
      return undefined;
    }
  };
}
