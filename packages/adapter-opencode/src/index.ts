/**
 * @subconscious/adapter-opencode 公共接口（DESIGN §7.4、docs/ACCEPTANCE「OpenCode」行）。
 *
 * 两种用法：
 * 1. 插件安装（主用法）：opencode.json `{"plugin": ["@subconscious/adapter-opencode"]}`
 *    或本地引用 `./dist/plugin.js`——见子导出 "./plugin"（SubconsciousPlugin）与包 README；
 * 2. 库式嵌入：`handleChatMessage(...)`（"./plugin"）与 host-env/inject/interact 的
 *    可组合面，适配器/演示/测试复用同一代码路径。
 *
 * 本入口不引用 @opencode-ai/plugin 的类型（peer 可选）：未安装该包的消费者仍可
 * 使用 "." 子导出；插件入口集中在 "./plugin"。
 */
export {
  createOpenCodeHostEnv,
  GIT_STATUS_TIMEOUT_MS,
  MAX_DIR_ENTRIES,
  MAX_SESSION_ENTRIES,
  SESSION_TITLE_MAX_CHARS,
} from "./host-env.js";
export type {
  GitExec,
  GitExecResult,
  OpenCodeHostEnvClients,
  OpenCodeHostEnvSnapshot,
  SessionClient,
} from "./host-env.js";
export { extractUserPrompt, injectIntoParts } from "./inject.js";
export type { ChatPartLike } from "./inject.js";
export { createRecordingUnsupportedInteract } from "./interact.js";
export type { InteractionRecord, RecordingInteractPort } from "./interact.js";
export {
  createEmbeddingDetectorResolver,
  EMBEDDING_ENV_VAR,
  EMBEDDING_LOAD_TIMEOUT_MS,
  embeddingDetectorResolver,
  isEmbeddingOptIn,
  MODEL_DIR_ENV_VAR,
} from "./embedding-optin.js";
export type { EmbeddingDetectorResolver, EmbeddingLoadOptions } from "./embedding-optin.js";
