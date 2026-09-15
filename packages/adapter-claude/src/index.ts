/**
 * @subconscious/adapter-claude 公共接口（DESIGN §7.3、docs/ACCEPTANCE「Claude」行）。
 *
 * 两种用法：
 * 1. hook 安装（主用法）：settings.json 的 UserPromptSubmit 命令指向
 *    `node .../adapter-claude/dist/hook-main.js`（见包 README / examples）；
 * 2. 库式嵌入：`handleUserPromptSubmit(parseUserPromptSubmitInput(raw), opts)`，
 *    适配器/演示/测试复用同一代码路径。
 *
 * 本适配器只依赖 @subconscious/core；协议事实与降级矩阵见 hook-main.ts / hook.ts
 * 模块头注释。
 */
export { parseUserPromptSubmitInput } from "./input.js";
export type { ClaudeHookInput } from "./input.js";
export { createClaudeHostEnv, GIT_STATUS_TIMEOUT_MS, MAX_SESSION_ENTRIES } from "./host-env.js";
export type { ClaudeHostEnvOptions, GitExec, GitExecResult } from "./host-env.js";
export { createRecordingUnsupportedInteract } from "./interact.js";
export type { InteractionRecord, RecordingInteractPort } from "./interact.js";
export {
  CLAUDE_L0_SOURCES,
  composeAdditionalContext,
  handleUserPromptSubmit,
  MAX_HINT_LINES,
  PENDING_HEADER,
} from "./hook.js";
export type { HookHandlerOptions, HookOutput } from "./hook.js";
export { readAllStdin, MAX_STDIN_BYTES } from "./stdin.js";
// 注意：超时配置从无副作用的 timeout.ts re-export（hook-main.ts 是可执行入口，
// 导入即读 stdin + 注册全局处理器——"." 入口不得触碰，见 index-entry.proc.test.ts）
export { DEFAULT_TOTAL_TIMEOUT_MS, MAX_TOTAL_TIMEOUT_MS, resolveTotalTimeoutMs } from "./timeout.js";
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
