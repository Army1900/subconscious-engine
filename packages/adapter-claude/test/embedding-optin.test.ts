/**
 * embedding 检测器可选接线（硬化轮）。
 *
 * 证据边界（监督要求显式区分）：
 * - 离线确定性：fixture 注入 loader/provider（2 轴向量 + 2 条自定义示例），
 *   不依赖 @subconscious/embedding-local、@huggingface/transformers 或本地模型；
 * - 真实模块路径：形状收窄按 @subconscious/embedding-local 的真实导出签名建模，
 *   真实 transformers 推理归 embedding-local 包自身的评估（npm run eval:embedding）。
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddingDetector,
  createEngine,
  type Detector,
  type EmbeddingExample,
  type EmbeddingProvider,
  type EngineOptions,
  type Logger,
  type SubconsciousEngine,
} from "@subconscious/core";
import {
  createEmbeddingDetectorResolver,
  EMBEDDING_ENV_VAR,
  EMBEDDING_LOAD_TIMEOUT_MS,
  embeddingDetectorResolver,
  isEmbeddingOptIn,
  MODEL_DIR_ENV_VAR,
} from "../src/embedding-optin.js";
import { handleUserPromptSubmit } from "../src/hook.js";
import type { ClaudeHookInput } from "../src/input.js";

// ---------------------------------------------------------------------------
// 离线 fixture：规则词典外的表述 → project 指代（2 轴向量空间，确定性）
// ---------------------------------------------------------------------------

/** 规则词典外的表述（硬化轮接线的行为锚点；规则检测器对它必须零命中） */
const OUT_OF_LEXICON_PHRASE = "咱们那个摊子";

function fixtureProvider(): EmbeddingProvider {
  return {
    id: "test:fixture-2axis",
    embed: async (text) => (text.includes(OUT_OF_LEXICON_PHRASE) ? [1, 0] : [0, 1]),
  };
}

const FIXTURE_EXAMPLES: readonly EmbeddingExample[] = [
  { text: OUT_OF_LEXICON_PHRASE, type: "project" },
  { text: "随便聊两句", type: "negative" },
];

/** 捕获 providerOptions 的 fixture 模块 loader（模拟 @subconscious/embedding-local 形状） */
function fixtureLoader(captured?: { providerOptions?: unknown }): () => Promise<unknown> {
  return async () => ({
    createLocalEmbeddingDetector: async (providerOptions?: unknown): Promise<Detector> => {
      if (captured !== undefined) captured.providerOptions = providerOptions;
      return createEmbeddingDetector(fixtureProvider(), { examples: FIXTURE_EXAMPLES });
    },
  });
}

/** 抛错 loader（模拟可选依赖未安装：动态 import ERR_MODULE_NOT_FOUND） */
function missingModuleLoader(): () => Promise<unknown> {
  return async () => {
    throw new Error("Cannot find package '@subconscious/embedding-local'");
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isEmbeddingOptIn：显式 opt-in 语义（缺省/任意其他值 = 关）
// ---------------------------------------------------------------------------

describe("isEmbeddingOptIn", () => {
  it("仅 1/true（大小写不敏感）开启；未设置/空/0/false/其他值一律关闭", () => {
    expect(isEmbeddingOptIn({ [EMBEDDING_ENV_VAR]: "1" })).toBe(true);
    expect(isEmbeddingOptIn({ [EMBEDDING_ENV_VAR]: "true" })).toBe(true);
    expect(isEmbeddingOptIn({ [EMBEDDING_ENV_VAR]: "TRUE" })).toBe(true);
    expect(isEmbeddingOptIn({})).toBe(false);
    expect(isEmbeddingOptIn({ [EMBEDDING_ENV_VAR]: "" })).toBe(false);
    expect(isEmbeddingOptIn({ [EMBEDDING_ENV_VAR]: "0" })).toBe(false);
    expect(isEmbeddingOptIn({ [EMBEDDING_ENV_VAR]: "false" })).toBe(false);
    expect(isEmbeddingOptIn({ [EMBEDDING_ENV_VAR]: "yes" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolver：opt-in 加载 / 失败回退 / 超时 / memoize
// ---------------------------------------------------------------------------

describe("createEmbeddingDetectorResolver().resolve", () => {
  it("未 opt-in → 立即 undefined，且不尝试加载模块（默认行为零开销）", async () => {
    const resolver = createEmbeddingDetectorResolver();
    const loader = vi.fn(missingModuleLoader());
    await expect(resolver.resolve({ env: {}, loader })).resolves.toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });

  it("opt-in + fixture 模块 → 返回检测器（含 providerOptions 透传 modelDir/logger）", async () => {
    const resolver = createEmbeddingDetectorResolver();
    const captured: { providerOptions?: unknown } = {};
    const logger: Logger = () => undefined;
    const detector = await resolver.resolve({
      env: { [EMBEDDING_ENV_VAR]: "1", [MODEL_DIR_ENV_VAR]: "/tmp/sc-models" },
      loader: fixtureLoader(captured),
      logger,
    });
    expect(detector).toBeDefined();
    expect(captured.providerOptions).toEqual({ modelDir: "/tmp/sc-models", logger });
  });

  it("可选依赖未安装（loader 抛错）→ undefined + stderr 单行 warn（诚实回退，不崩）", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const resolver = createEmbeddingDetectorResolver();
    await expect(
      resolver.resolve({ env: { [EMBEDDING_ENV_VAR]: "1" }, loader: missingModuleLoader() }),
    ).resolves.toBeUndefined();
    const lines = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(lines).toContain("embedding-optin-unavailable");
    expect(lines).toContain("@subconscious/embedding-local");
  });

  it("模块形状不符（缺 createLocalEmbeddingDetector）→ undefined + stderr warn", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const resolver = createEmbeddingDetectorResolver();
    await expect(
      resolver.resolve({ env: { [EMBEDDING_ENV_VAR]: "1" }, loader: async () => ({ nope: true }) }),
    ).resolves.toBeUndefined();
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("embedding-optin-unavailable");
  });

  it("createLocalEmbeddingDetector 自身抛错 → undefined + stderr warn（不外溢）", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const resolver = createEmbeddingDetectorResolver();
    const loader = async (): Promise<unknown> => ({
      createLocalEmbeddingDetector: async () => {
        throw new Error("model exploded");
      },
    });
    await expect(resolver.resolve({ env: { [EMBEDDING_ENV_VAR]: "1" }, loader })).resolves.toBeUndefined();
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("model exploded");
  });

  it("冷加载超时 → 本次 undefined（规则回退），后台加载完成后下次 resolve 命中", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const resolver = createEmbeddingDetectorResolver();
    const fastLoader = fixtureLoader();
    const slowLoader = async (): Promise<unknown> => {
      await sleep(80);
      return fastLoader();
    };
    await expect(
      resolver.resolve({ env: { [EMBEDDING_ENV_VAR]: "1" }, loader: slowLoader, loadTimeoutMs: 10 }),
    ).resolves.toBeUndefined();
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("embedding-load-timeout");
    // memoized promise 仍在后台完成：等待后同 resolver 再次 resolve 拿到检测器
    await sleep(150);
    await expect(resolver.resolve({ env: { [EMBEDDING_ENV_VAR]: "1" }, loader: slowLoader })).resolves.toBeDefined();
  });

  it("memoize：同 resolver 同 modelDir 只加载一次，返回同一检测器实例", async () => {
    const resolver = createEmbeddingDetectorResolver();
    const loader = vi.fn(fixtureLoader());
    const env = { [EMBEDDING_ENV_VAR]: "1" };
    const first = await resolver.resolve({ env, loader });
    const second = await resolver.resolve({ env, loader });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("默认有界等待常量为正（防误配为非阻塞）", () => {
    expect(EMBEDDING_LOAD_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("导出模块级单例 resolver（长寿命进程内模型只加载一次）", () => {
    expect(typeof embeddingDetectorResolver.resolve).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// handleUserPromptSubmit 接线：默认行为不变 / opt-in 注入检测器
// ---------------------------------------------------------------------------

describe("handleUserPromptSubmit × embedding opt-in", () => {
  let projectDir: string;

  async function makeProjectDir(): Promise<void> {
    projectDir = await mkdtemp(path.join(tmpdir(), "sc-claude-optin-"));
    await writeFile(path.join(projectDir, "README.md"), "x", "utf8");
  }

  function hookInput(prompt: string): ClaudeHookInput {
    return {
      hookEventName: "UserPromptSubmit",
      sessionId: "current-session",
      transcriptPath: path.join(projectDir, "current-session.jsonl"),
      cwd: projectDir,
      prompt,
    };
  }

  it("默认（未 opt-in）：createEngineFn 收到的 options 不含 detector，行为零变化", async () => {
    await makeProjectDir();
    const received: EngineOptions[] = [];
    const recordingEngine: SubconsciousEngine = {
      enrich: () => Promise.resolve({ prompt: "p", context: undefined, resolvedRefs: [], droppedRefs: [] }),
    };
    const result = await handleUserPromptSubmit(hookInput("直接回答"), {
      deps: {
        createEngineFn: (options) => {
          received.push(options);
          return recordingEngine;
        },
      },
    });
    expect(result).toBeUndefined();
    expect(received).toHaveLength(1);
    expect("detector" in received[0]!).toBe(false);
  });

  it("opt-in（env=1）：fixture 检测器进入引擎，规则外表述端到端解析注入", async () => {
    await makeProjectDir();
    vi.stubEnv(EMBEDDING_ENV_VAR, "1");
    const resolver = createEmbeddingDetectorResolver();
    const expected = await resolver.resolve({ env: { [EMBEDDING_ENV_VAR]: "1" }, loader: fixtureLoader() });
    expect(expected).toBeDefined();

    const received: EngineOptions[] = [];
    const result = await handleUserPromptSubmit(hookInput(`说说${OUT_OF_LEXICON_PHRASE}的情况`), {
      deps: {
        createEngineFn: (options) => {
          received.push(options);
          return createEngine(options);
        },
        embeddingResolver: resolver,
      },
    });
    expect(received[0]!.detector).toBe(expected);
    // 端到端：embedding 命中 project 指代 → cwd-context 解析 → 已解析块注入
    expect(result).toBeDefined();
    expect(result?.additionalContext).toContain("[潜意识引擎·已解析]");
    expect(result?.additionalContext).toContain("工作目录");
  });

  it("同一规则外表述在未 opt-in 时零注入（默认行为不变的端到端证据）", async () => {
    await makeProjectDir();
    const result = await handleUserPromptSubmit(hookInput(`说说${OUT_OF_LEXICON_PHRASE}的情况`));
    expect(result).toBeUndefined();
  });

  it("opt-in 但模块缺失：回退规则检测器，handler 正常完成不崩", async () => {
    await makeProjectDir();
    vi.stubEnv(EMBEDDING_ENV_VAR, "1");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const resolver = createEmbeddingDetectorResolver();
    const received: EngineOptions[] = [];
    const result = await handleUserPromptSubmit(hookInput("介绍一下这个项目"), {
      deps: {
        createEngineFn: (options) => {
          received.push(options);
          return createEngine(options);
        },
        embeddingResolver: { resolve: () => resolver.resolve({ loader: missingModuleLoader() }) },
      },
    });
    expect(result).toBeDefined(); // 规则路径照常注入（项目指代）
    expect("detector" in received[0]!).toBe(false);
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("embedding-optin-unavailable");
  });
});
