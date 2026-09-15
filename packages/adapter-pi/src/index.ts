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

export default function subconsciousExtension(pi: ExtensionAPI): void {
  pi.on(
    "before_agent_start",
    createBeforeAgentStartHandler({
      // pi.exec 绑定到 API 实例（不直传方法引用，避免 this 丢失）
      deps: { exec: (command, args, options) => pi.exec(command, args, options) },
      // 注意：不传 activeEditor——pi 无编辑器概念，D6 红线：无当前编辑器不猜文件。
    }),
  );
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
  MAX_CHANGES_PER_SESSION,
  parseSessionJsonl,
  readSessionChanges,
  resolveContainedPath,
} from "./session-jsonl.js";
export type { ParsedSession } from "./session-jsonl.js";
