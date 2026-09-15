/**
 * @subconscious/core 公共接口（DESIGN §6 + docs/DECISIONS.md）。
 *
 * 用法（适配器视角）：
 * ```ts
 * const engine = createEngine({ sources: DEFAULT_SOURCES, interact: myInteractPort });
 * const output = await engine.enrich("把这个函数改成和上次一样的错误处理", env);
 * // output.context 追加注入；无指代时 context 为 undefined（no-op 透传）
 * ```
 */

export type {
  AcquisitionSpec,
  ActiveEditorState,
  AsyncDetector,
  Candidate,
  CwdSnapshot,
  DanglingRef,
  DataSource,
  DataType,
  Detector,
  DetectorContext,
  DisambiguationPrior,
  DropReason,
  EngineLimits,
  EngineOptions,
  EnrichOutput,
  GrantQuery,
  GrantRecord,
  GrantStore,
  GrantWriteOptions,
  HostEnv,
  ImageLike,
  InteractOptions,
  InteractPort,
  LogEntry,
  LogLevel,
  Logger,
  MemoryData,
  MemoryStore,
  PermissionLevel,
  PersonalPhrase,
  ReadRequest,
  Resolution,
  ResolveContext,
  ResolvedValue,
  SessionChange,
  SessionRecord,
  SessionRef,
  SessionSummary,
  SubconsciousEngine,
  Timer,
  TimerHandle,
} from "./types.js";

export { DEFAULT_ENGINE_LIMITS } from "./types.js";

export { RuleDetector, createRuleDetector, isAsyncDetector } from "./detector.js";
export { DataSourceRegistry, isDataType } from "./registry.js";
export { InMemoryGrantStore } from "./grants.js";
export { FileGrantStore } from "./file-grants.js";
export {
  autoResolvePriorCandidate,
  disambiguationWeights,
  exportMemory,
  FileMemoryStore,
  importMemory,
  InMemoryMemoryStore,
  isDisambiguationPrior,
  isPersonalPhrase,
  MAX_DISAMBIGUATION_RECORDS,
  MAX_HINT_CHARS,
  MAX_PHRASES,
  MAX_PHRASE_CHARS,
  parseMemoryData,
  PRIOR_AUTO_DOMINANCE,
  PRIOR_AUTO_MIN_PICKS,
  PRIOR_WINDOW_DAYS,
  rankByPrior,
} from "./memory.js";
export type { PriorAutoResolution, PriorWeight } from "./memory.js";
export { createPersonalPhraseDetector, PERSONAL_PHRASE_CONFIDENCE } from "./phrase-detector.js";
export { UNSUPPORTED_INTERACT, guardInteract } from "./interact.js";
export type { GuardedInteract, GuardedInteractOptions } from "./interact.js";
export { createDeadlineClock } from "./clock.js";
export type { DeadlineClock } from "./clock.js";
export { createSystemTimer, ManualTimer } from "./timer.js";
export { EngineConfigError } from "./errors.js";
export type { EngineErrorCode } from "./errors.js";
export { createEngine, isValidResolvedValue } from "./engine.js";

export {
  DEFAULT_SOURCES,
  activeEditorSource,
  cwdContextSource,
  recentSessionsSource,
  sessionContentSource,
  clipboardSource,
  imageAcquisitionSource,
} from "./sources/index.js";

export { assemble } from "./assembler.js";
export {
  cosineSimilarity,
  createEmbeddingDetector,
  DEFAULT_EMBEDDING_THRESHOLDS,
  EmbeddingDetector,
} from "./embedding.js";
export type {
  EmbeddingDetectorOptions,
  EmbeddingExample,
  EmbeddingExampleLabel,
  EmbeddingProvider,
  EmbeddingThresholds,
  EmbeddingVector,
} from "./embedding.js";
export { DEFAULT_EMBEDDING_EXAMPLES, EMBEDDING_EXAMPLES_VERSION } from "./embedding-examples.js";
export { EMBEDDING_EVAL_SET, embeddingEvalLeakErrors, evaluateRefDetection } from "./embedding-eval.js";
export type { EmbeddingEvalCase, EmbeddingEvalRef, RefDetectionMetrics } from "./embedding-eval.js";
export type { AssembleOptions, DroppedItem, ResolvedItem } from "./assembler.js";
export { isNonEmptyString, truncate, uniquifyLabels } from "./text.js";
