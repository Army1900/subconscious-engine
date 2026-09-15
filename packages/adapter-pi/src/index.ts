/**
 * 潜意识引擎 pi 扩展入口（DESIGN §7.2）。
 *
 * 加载方式（真实 pi 宿主，M1 不自动安装、不改全局配置）：
 *   1. 本包构建产物 dist/index.js + 依赖（@subconscious/core 与 pi 宿主内同包/等价版本）
 *      放入 ~/.pi/agent/extensions/subconscious/（或以 Pi Package 形式安装，M2 评估）；
 *   2. pi 启动时以默认导出工厂加载本模块。
 *
 * 具名导出供测试/演示直接驱动同一 handler/env/interact 代码路径（离线可验证）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBeforeAgentStartHandler } from "./handler.js";
import { createSessionShutdownHandler } from "./shutdown.js";

export default function subconsciousExtension(pi: ExtensionAPI): void {
  pi.on(
    "before_agent_start",
    createBeforeAgentStartHandler({
      // pi.exec 绑定到 API 实例（不直传方法引用，避免 this 丢失）
      deps: { exec: (command, args, options) => pi.exec(command, args, options) },
      // 注意：不传 activeEditor——pi 无编辑器概念，D6 红线：无当前编辑器不猜文件。
    }),
  );
  // 惯例蒸馏（M5c-2）：会话结束（quit/new/resume/fork；reload 跳过）触发
  // fire-and-forget 蒸馏子进程（SUBCONSCIOUS_DISTILL=0 关闭；详见 distill.ts）
  pi.on("session_shutdown", createSessionShutdownHandler());
}

export { createBeforeAgentStartHandler, toEventResult } from "./handler.js";
export type {
  AdapterDeps,
  BeforeAgentStartHandler,
  HandlerOptions,
  PiBeforeAgentStartEvent,
  PiHandlerContext,
} from "./handler.js";
export { createPiHostEnv } from "./host-env.js";
export type { ListSessionsFn, PiExec, PiHostEnvOptions } from "./host-env.js";
export {
  GIT_STATUS_TIMEOUT_MS,
  MAX_DIR_ENTRIES,
  MAX_SESSION_ENTRIES,
  TITLE_MAX_CHARS,
} from "./host-env.js";
export { createPiInteract } from "./interact.js";
export type { PiInteractPort } from "./interact.js";
export {
  createEmbeddingDetectorResolver,
  EMBEDDING_ENV_VAR,
  EMBEDDING_LOAD_TIMEOUT_MS,
  embeddingDetectorResolver,
  isEmbeddingOptIn,
  MODEL_DIR_ENV_VAR,
} from "./embedding-optin.js";
export type { EmbeddingDetectorResolver, EmbeddingLoadOptions } from "./embedding-optin.js";
export { MEMORY_FILE_ENV_VAR, resolveMemoryFilePath, wireMemory } from "./memory.js";
export type { MemoryWireOptions, MemoryWiring } from "./memory.js";
export {
  composeDistillPrompt,
  createDistillDebouncer,
  DEFAULT_DISTILL_TIMEOUT_MS,
  DISTILL_BIN_ENV_VAR,
  DISTILL_ENV_VAR,
  DISTILL_MATERIAL_MAX_BYTES,
  DISTILL_MATERIAL_MAX_CHARS,
  DISTILL_TIMEOUT_ENV_VAR,
  extractDistillCandidates,
  headlessPiArgs,
  isDistillEnabled,
  looksSensitive,
  MAX_DISTILL_CONVENTIONS,
  MAX_DISTILL_DEBOUNCE_ENTRIES,
  MAX_DISTILL_TIMEOUT_MS,
  renderSessionMaterial,
  resolveDistillTimeoutMs,
  runDistillation,
  spawnHeadlessPi,
  buildConventionEntries,
} from "./distill.js";
export type {
  ConventionBase,
  DistilledCandidate,
  DistillDebouncer,
  DistillExecutor,
  DistillPromptInput,
  DistillRequest,
  DistillRunOptions,
  SessionMaterialInput,
} from "./distill.js";
export {
  createSessionShutdownHandler,
  readTailText,
  triggerSessionDistillation,
} from "./shutdown.js";
export type {
  PiSessionShutdownEvent,
  PiShutdownContext,
  SessionShutdownHandler,
  ShutdownHandlerOptions,
} from "./shutdown.js";
export {
  MAX_CHANGES_PER_SESSION,
  parseSessionJsonl,
  parseUserTurns,
  readSessionChanges,
  resolveContainedPath,
} from "./session-jsonl.js";
export type { ParsedSession } from "./session-jsonl.js";
