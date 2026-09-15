/**
 * session.idle → 惯例蒸馏触发（M5c-2，DECISIONS D25/D26；接线见 plugin.ts）。
 *
 * 契约：
 * - 事件窄化：只认 `Event { type: "session.idle"; properties: { sessionID } }`
 *   （锁定版 @opencode-ai/sdk@1.18.30 types.gen.d.ts:413-417）；其余事件忽略；
 * - 蒸馏临时会话的事件忽略（distill.ts 的注册表——蒸馏回复的 idle 不会再触发
 *   蒸馏，结构性防自触发）；
 * - fire-and-forget：本函数永不抛出，调用方（plugin 的 event hook）不等待完成；
 * - 素材：session.get + session.diff（经 host-env 的窄 SessionClient，官方通道）；
 * - 执行：distill.ts 的 distillViaTempSession（临时会话 + client.session.prompt）；
 * - fail-open / 去抖 / 开关纪律见 distill.ts 模块头。
 */
import type { Logger } from "@subconscious/core";
import {
  createDistillDebouncer,
  distillViaTempSession,
  isDistillEnabled,
  isDistillTempSession,
  readSessionMaterial,
  runDistillation,
} from "./distill.js";
import type { DistillDebouncer, DistillExecutor, DistillSessionClient } from "./distill.js";
import type { SessionClient } from "./host-env.js";

/** 官方 Event 判别联合的结构子面（真实 Event 结构性满足；不 import SDK 类型） */
export type IdleEventLike = {
  readonly type: string;
  readonly properties?: unknown;
};

/** session.idle 事件的 sessionID；非该事件或载荷非法 → null */
export function sessionIdOfIdleEvent(event: IdleEventLike): string | null {
  if (event.type !== "session.idle") return null;
  if (typeof event.properties !== "object" || event.properties === null) return null;
  const sessionID = (event.properties as Record<string, unknown>).sessionID;
  return typeof sessionID === "string" && sessionID !== "" ? sessionID : null;
}

/** SDK session 客户端的蒸馏子面来源（真实 client.session 结构性满足；测试可注入假实现） */
export interface SdkDistillSource {
  create?(options?: { body?: { title?: string }; query?: { directory?: string } }): Promise<{ data?: unknown }>;
  prompt?(options: {
    body: {
      parts: Array<{ type: "text"; text: string }>;
      system?: string;
      tools?: Record<string, boolean>;
    };
    path: { id: string };
    query?: { directory?: string };
  }): Promise<{ data?: unknown }>;
  delete?(options: { path: { id: string } }): Promise<{ data?: unknown }>;
}

/** SDK session 客户端 → distill 的窄 DistillSessionClient；三个方法不齐 → undefined */
export function toDistillSessionClient(session: SdkDistillSource | undefined): DistillSessionClient | undefined {
  if (session === undefined) return undefined;
  const create = session.create;
  const prompt = session.prompt;
  const remove = session.delete;
  if (create === undefined || prompt === undefined || remove === undefined) return undefined;
  return {
    create: (options) => create(options),
    prompt: (options) => prompt(options),
    delete: (options) => remove(options),
  };
}

export interface IdleDistillInput {
  /** 触发事件的会话（素材来源 + 溯源） */
  readonly sessionID: string;
  /** 插件工作目录（PluginInput.directory，官方字段；缺失传空串 → 跳过） */
  readonly directory: string;
  /** 素材读取客户端（session.get/diff；缺省不可用 → 跳过） */
  readonly session?: SessionClient;
  /** 蒸馏执行客户端（create/prompt/delete；缺省不可用 → 跳过） */
  readonly distill?: DistillSessionClient;
}

export interface IdleDistillOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  /** 去抖器；缺省进程内单例（冷却窗口 DISTILL_COOLDOWN_MS） */
  readonly debouncer?: DistillDebouncer;
  /** 蒸馏执行器；缺省 distillViaTempSession（需 input.distill 可用） */
  readonly executor?: DistillExecutor;
}

/** 进程内去抖单例（长寿命插件进程；冷却窗口内同会话只蒸馏一次） */
const debouncer = createDistillDebouncer();

/**
 * session.idle 触发蒸馏：检查开关/临时会话/去抖 → 读素材 → 后台执行蒸馏写回。
 * 返回是否发起了蒸馏；永不抛出（任何失败 = 单行 warn 后放弃）。
 */
export async function triggerIdleDistillation(input: IdleDistillInput, options: IdleDistillOptions = {}): Promise<boolean> {
  const logger = options.logger;
  const env = options.env ?? process.env;
  try {
    if (!isDistillEnabled(env)) return false;
    if (input.directory === "") return false; // 官方 directory 缺失即 no-op，不猜
    if (isDistillTempSession(input.sessionID)) return false;
    const executor: DistillExecutor | undefined =
      options.executor ??
      (input.distill !== undefined
        ? (prompt, timeoutMs) => distillViaTempSession(prompt, input.distill as DistillSessionClient, input.directory, timeoutMs)
        : undefined);
    if (executor === undefined) {
      logger?.({ level: "warn", event: "distill-skipped", detail: "蒸馏 client 不可用（session.create/prompt/delete 缺失），跳过" });
      return false;
    }
    if (input.session === undefined) {
      logger?.({ level: "warn", event: "distill-skipped", detail: "素材 client 不可用（session.get/diff 缺失），跳过" });
      return false;
    }
    if (!(options.debouncer ?? debouncer).shouldDistill(input.sessionID, Date.now())) return false;
    const material = await readSessionMaterial(input.session, input.sessionID);
    if (material === null || material.material.trim() === "") {
      logger?.({ level: "warn", event: "distill-skipped", detail: `会话 ${input.sessionID} 素材不可读或为空，跳过蒸馏` });
      return false;
    }
    logger?.({ level: "info", event: "distill-started", detail: `会话 ${input.sessionID} 空闲，开始蒸馏` });
    await runDistillation(
      {
        projectKey: input.directory,
        sessionId: input.sessionID,
        sessionTitle: material.sessionTitle,
        material: material.material,
      },
      { env, logger, executor },
    );
    return true;
  } catch (err) {
    // fail-open：任何异常只记 warn（runDistillation 内部已兜底，此处防御未来改动）
    logger?.({ level: "warn", event: "distill-skipped", detail: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
