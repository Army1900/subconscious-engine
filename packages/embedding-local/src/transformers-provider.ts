import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEmbeddingDetector,
  type EmbeddingDetector,
  type EmbeddingDetectorOptions,
  type EmbeddingProvider,
  type EmbeddingVector,
  type Logger,
} from "@subconscious/core";

/**
 * transformers.js 本地向量 provider（进程内、离线推理；DESIGN §11 非目标 6：
 * 不做本地推理服务，不做网络请求）。
 *
 * 关键纪律：
 * - 依赖为**可选 peer**（@huggingface/transformers）：未安装时本包仍可构建与测试
 *   （动态 import + 结构收窄，源码零静态 import，类型检查不依赖该包存在）；
 * - 只加载本地模型目录（env.allowRemoteModels = false），缺模型受控失败，
 *   绝不回退联网下载（监督红线：测试与推理不依赖网络）；
 * - 任何失败抛受控错误（带 [embedding-local] 前缀），由 core 的 EmbeddingDetector
 *   记录并回退规则检测器（fail-open）。
 */

/** 注意：显式注解为 string 以阻止 TS 对动态 import 做模块解析（可选依赖可能不存在） */
export const TRANSFORMERS_MODULE: string = "@huggingface/transformers";

export const DEFAULT_LOCAL_MODEL_NAME = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

export const DEFAULT_MODEL_ROOT: string = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  "models",
);

// ---------------------------------------------------------------------------
// transformers.js 结构类型（运行时收窄，不依赖其 .d.ts）
// ---------------------------------------------------------------------------

interface EmbeddingTensorLike {
  readonly data: ArrayLike<number>;
}

type FeatureExtractor = (
  texts: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<EmbeddingTensorLike>;

type PipelineFactory = (
  task: "feature-extraction",
  model: string,
  options?: { dtype?: string },
) => Promise<FeatureExtractor>;

function isTransformersModule(v: unknown): v is { pipeline: unknown; env: Record<string, unknown> } {
  if (typeof v !== "object" || v === null) return false;
  const candidate = v as { pipeline?: unknown; env?: unknown };
  return typeof candidate.pipeline === "function" && typeof candidate.env === "object" && candidate.env !== null;
}

function fail(message: string): never {
  throw new Error(`[embedding-local] ${message}`);
}

// ---------------------------------------------------------------------------
// provider 构造
// ---------------------------------------------------------------------------

export interface TransformersProviderOptions {
  /** 本地模型根目录（其下按模型名分目录）；默认 <本包根>/models */
  readonly modelDir?: string;
  /** 模型名（目录名）；默认 DEFAULT_LOCAL_MODEL_NAME */
  readonly modelName?: string;
  /** ONNX 精度，默认 "q8"（model_quantized.onnx） */
  readonly dtype?: string;
  /** 嵌入缓存条数上限（FIFO 全清），默认 512 */
  readonly cacheLimit?: number;
  readonly logger?: Logger;
}

function expectedModelFile(modelDir: string, modelName: string, dtype: string): string {
  const onnxName = dtype === "q8" ? "model_quantized.onnx" : "model.onnx";
  return path.join(modelDir, ...modelName.split("/"), "onnx", onnxName);
}

export async function createTransformersProvider(
  options: TransformersProviderOptions = {},
): Promise<EmbeddingProvider> {
  const modelDir = options.modelDir ?? DEFAULT_MODEL_ROOT;
  const modelName = options.modelName ?? DEFAULT_LOCAL_MODEL_NAME;
  const dtype = options.dtype ?? "q8";
  const cacheLimit = options.cacheLimit ?? 512;

  const modelFile = expectedModelFile(modelDir, modelName, dtype);
  if (!existsSync(modelFile)) {
    fail(
      `本地模型不存在：${modelFile}（运行 npm run fetch:embedding-model 下载；推理过程不联网）`,
    );
  }

  const mod: unknown = await import(TRANSFORMERS_MODULE).catch((err: unknown) => {
    fail(
      `可选依赖 ${TRANSFORMERS_MODULE} 未安装，无法构建本地向量 provider（安装：npm install --no-save ${TRANSFORMERS_MODULE}@^3）。原因：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  if (!isTransformersModule(mod)) {
    fail(`${TRANSFORMERS_MODULE} 模块形状不符合预期（缺 pipeline/env）`);
  }

  // 只允许本地模型：禁止运行期联网下载（监督红线）
  mod.env.allowLocalModels = true;
  mod.env.allowRemoteModels = false;
  mod.env.localModelPath = modelDir;

  const pipeline = mod.pipeline as PipelineFactory;
  let extractor: FeatureExtractor;
  try {
    extractor = await pipeline("feature-extraction", modelName, { dtype });
  } catch (err) {
    fail(`模型加载失败（${modelName}，目录 ${modelDir}）：${err instanceof Error ? err.message : String(err)}`);
  }

  const cache = new Map<string, EmbeddingVector>();
  options.logger?.({ level: "info", event: "transformers-provider-ready", detail: `${modelName} @ ${modelDir}` });

  return {
    id: `transformers:${modelName}`,
    async embed(text: string): Promise<EmbeddingVector> {
      const cached = cache.get(text);
      if (cached !== undefined) return cached;
      const tensor = await extractor(text, { pooling: "mean", normalize: true });
      const raw = tensor.data;
      if (raw === null || raw === undefined || raw.length === 0) {
        fail(`嵌入输出为空（${modelName}）`);
      }
      const vec: EmbeddingVector = Array.from(raw, (x) => Number(x));
      if (vec.some((x) => !Number.isFinite(x))) {
        fail(`嵌入输出含非有限值（${modelName}）`);
      }
      if (cache.size >= cacheLimit) cache.clear();
      cache.set(text, vec);
      return vec;
    },
  };
}

/**
 * 便捷构造：provider 创建失败（依赖缺失/模型缺失/加载失败）时不抛出，
 * 返回绑定 null provider 的 EmbeddingDetector——同步/异步路径均为规则检测器（fail-open）。
 */
export async function createLocalEmbeddingDetector(
  providerOptions: TransformersProviderOptions = {},
  detectorOptions?: EmbeddingDetectorOptions,
): Promise<EmbeddingDetector> {
  let provider: EmbeddingProvider | null = null;
  try {
    provider = await createTransformersProvider(providerOptions);
  } catch (err) {
    const logger = providerOptions.logger;
    logger?.({
      level: "warn",
      event: "embedding-provider-unavailable",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  return createEmbeddingDetector(provider, detectorOptions);
}
