/**
 * @subconscious/embedding-local 公共接口。
 *
 * 用法（适配器视角，模型已下载且可选依赖已安装时）：
 * ```ts
 * const detector = await createLocalEmbeddingDetector({ logger });
 * const engine = createEngine({ detector, sources: DEFAULT_SOURCES });
 * // 依赖/模型缺失 → detector 退化为规则检测器，enrich 永不因此失败
 * ```
 */

export {
  createFixtureKeywordProvider,
  fixtureEmbed,
  FIXTURE_DIMENSION,
  FIXTURE_PROVIDER_ID,
} from "./fixture-provider.js";

export {
  createLocalEmbeddingDetector,
  createTransformersProvider,
  DEFAULT_LOCAL_MODEL_NAME,
  DEFAULT_MODEL_ROOT,
  TRANSFORMERS_MODULE,
} from "./transformers-provider.js";
export type { TransformersProviderOptions } from "./transformers-provider.js";
