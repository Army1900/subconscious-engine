/**
 * embedding 检测器可选接线（硬化轮，DECISIONS D22）。
 *
 * 契约：
 * - 默认行为不变：未设置 SUBCONSCIOUS_EMBEDDING（或值非 1/true）时不做任何加载，
 *   引擎不传 detector（core 默认规则检测器，逐字节等价于接线前）；
 * - 显式 opt-in（SUBCONSCIOUS_EMBEDDING=1）时动态 import @subconscious/embedding-local，
 *   用 createLocalEmbeddingDetector 包规则检测器（模型/依赖缺失时其自身 fail-open
 *   为规则行为；本模块只处理「模块不可用」这一层）；
 * - @subconscious/embedding-local 不是本包的依赖（依赖方向红线：适配器清单只含
 *   core）。未安装/形状不符/构造抛错 → 记 stderr 单行 warn 后返回 undefined（规则），
 *   绝不抛出（fail-open）；
 * - 有界等待：冷加载（动态 import + ONNX 模型加载）超过 EMBEDDING_LOAD_TIMEOUT_MS
 *   时本次回退规则，后台加载继续；长寿命进程内后续调用命中 memoize 结果——
 *   模型每进程至多加载一次，引擎实例仍按事件重建（D11）；
 * - SUBCONSCIOUS_EMBEDDING_MODEL_DIR 透传 provider 的 modelDir（npm tarball 不含
 *   模型文件，真实消费者必须能指向自己的模型目录）。
 *
 * 测试纪律：loader/provider 注入 fixture（离线确定性），不装 transformers、不读模型。
 */
import type {
  Detector,
  EmbeddingDetectorOptions,
  Logger,
} from "@subconscious/core";

export const EMBEDDING_ENV_VAR = "SUBCONSCIOUS_EMBEDDING";
export const MODEL_DIR_ENV_VAR = "SUBCONSCIOUS_EMBEDDING_MODEL_DIR";

/** 冷加载有界等待（ms）：覆盖动态 import + provider 构造；超时本次规则回退 */
export const EMBEDDING_LOAD_TIMEOUT_MS = 2000;

/** 注意：显式注解为 string 以阻止 TS 对动态 import 做模块解析（可选依赖可能不存在） */
const EMBEDDING_LOCAL_MODULE: string = "@subconscious/embedding-local";

/** 显式 opt-in：仅 1/true（大小写不敏感）开启；其余任何值（含未设置）为关 */
export function isEmbeddingOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[EMBEDDING_ENV_VAR];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true";
}

// ---------------------------------------------------------------------------
// @subconscious/embedding-local 结构子面（运行时收窄，不依赖其 .d.ts 存在）
// ---------------------------------------------------------------------------

interface EmbeddingModuleProviderOptions {
  modelDir?: string;
  logger?: Logger;
}

interface EmbeddingModuleLike {
  createLocalEmbeddingDetector(
    providerOptions?: EmbeddingModuleProviderOptions,
    detectorOptions?: EmbeddingDetectorOptions,
  ): Promise<Detector>;
}

function isEmbeddingModule(v: unknown): v is EmbeddingModuleLike {
  if (typeof v !== "object" || v === null) return false;
  const candidate = v as { createLocalEmbeddingDetector?: unknown };
  return typeof candidate.createLocalEmbeddingDetector === "function";
}

async function defaultLoader(): Promise<unknown> {
  return await import(EMBEDDING_LOCAL_MODULE);
}

// ---------------------------------------------------------------------------
// 日志：stderr 单行 JSON（进程内插件，stdout 可能污染宿主输出；同 plugin.ts stderrLog 纪律）
// ---------------------------------------------------------------------------

function stderrWarn(event: string, detail: string): void {
  try {
    process.stderr.write(`${JSON.stringify({ level: "warn", event, detail })}\n`);
  } catch {
    // stderr 写失败（管道已断等）：吞掉，绝不影响主路径
  }
}

// ---------------------------------------------------------------------------
// resolver：opt-in 判定 + 单飞 memoize + 有界等待
// ---------------------------------------------------------------------------

export interface EmbeddingLoadOptions {
  /** env 快照（缺省 process.env；测试注入显式 env 而不改全局） */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  /** 模块 loader（缺省动态 import @subconscious/embedding-local；测试注入 fixture） */
  readonly loader?: () => Promise<unknown>;
  /** 有界等待覆盖（缺省 EMBEDDING_LOAD_TIMEOUT_MS） */
  readonly loadTimeoutMs?: number;
}

export interface EmbeddingDetectorResolver {
  /** 永不 reject：不可用/超时一律 resolve undefined（= 规则检测器） */
  resolve(options?: EmbeddingLoadOptions): Promise<Detector | undefined>;
}

export function createEmbeddingDetectorResolver(): EmbeddingDetectorResolver {
  /** memoize 按 modelDir 分键；promise 永不 reject（迟到失败不外溢，D16 同源纪律） */
  const cache = new Map<string, Promise<Detector | undefined>>();

  /** 首次调用的 loader 随 memoize 固化（测试注入 fixture；生产恒为 defaultLoader） */
  const load = (
    modelDir: string | undefined,
    logger: Logger | undefined,
    loader: (() => Promise<unknown>) | undefined,
  ): Promise<Detector | undefined> =>
    (async () => {
      const loadFn = loader ?? defaultLoader;
      try {
        const mod: unknown = await loadFn();
        if (!isEmbeddingModule(mod)) {
          const detail = `${EMBEDDING_LOCAL_MODULE} 模块形状不符（缺 createLocalEmbeddingDetector），回退规则检测器`;
          stderrWarn("embedding-optin-unavailable", detail);
          logger?.({ level: "warn", event: "embedding-optin-unavailable", detail });
          return undefined;
        }
        return await mod.createLocalEmbeddingDetector({
          ...(modelDir !== undefined ? { modelDir } : {}),
          ...(logger !== undefined ? { logger } : {}),
        });
      } catch (err) {
        const detail = `embedding opt-in 不可用（${
          err instanceof Error ? err.message : String(err)
        }）。安装可选包并下载模型后重试：npm install @subconscious/embedding-local @huggingface/transformers；本次回退规则检测器`;
        stderrWarn("embedding-optin-unavailable", detail);
        logger?.({ level: "warn", event: "embedding-optin-unavailable", detail });
        return undefined;
      }
    })();

  return {
    async resolve(options: EmbeddingLoadOptions = {}): Promise<Detector | undefined> {
      const env = options.env ?? process.env;
      if (!isEmbeddingOptIn(env)) return undefined; // 默认路径零开销：不 import、不计时
      const modelDirRaw = env[MODEL_DIR_ENV_VAR];
      const modelDir = typeof modelDirRaw === "string" && modelDirRaw !== "" ? modelDirRaw : undefined;
      const key = modelDir ?? "";
      let cached = cache.get(key);
      if (cached === undefined) {
        cached = load(modelDir, options.logger, options.loader);
        cache.set(key, cached);
      }
      const timeoutMs = options.loadTimeoutMs ?? EMBEDDING_LOAD_TIMEOUT_MS;
      if (!(timeoutMs > 0)) return undefined;
      return await new Promise<Detector | undefined>((resolve) => {
        const timer = setTimeout(() => {
          const detail = `embedding 冷加载超过 ${timeoutMs}ms，本次回退规则检测器（后台加载继续，后续调用生效）`;
          stderrWarn("embedding-load-timeout", detail);
          options.logger?.({ level: "warn", event: "embedding-load-timeout", detail });
          resolve(undefined);
        }, timeoutMs);
        cached!.then((detector) => {
          clearTimeout(timer); // 对称清理（D16）
          resolve(detector);
        });
      });
    },
  };
}

/** 模块级单例：长寿命宿主进程内模型至多加载一次（引擎实例仍按事件重建，D11） */
export const embeddingDetectorResolver: EmbeddingDetectorResolver = createEmbeddingDetectorResolver();
