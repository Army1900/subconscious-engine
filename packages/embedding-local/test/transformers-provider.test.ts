import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createLocalEmbeddingDetector,
  createTransformersProvider,
  DEFAULT_LOCAL_MODEL_NAME,
  TRANSFORMERS_MODULE,
  type TransformersProviderOptions,
} from "../src/transformers-provider.js";
import {
  DEFAULT_EMBEDDING_EXAMPLES,
  EMBEDDING_EVAL_SET,
  embeddingEvalLeakErrors,
  evaluateRefDetection,
  isAsyncDetector,
} from "@subconscious/core";

/**
 * transformers.js provider：进程内、离线（本地模型目录 + allowRemoteModels=false）。
 *
 * 测试纪律（监督红线"测试不依赖网络"）：
 * - 可选依赖未安装 → 对应用例跳过，但"受控报错"用例仍验证（拔掉依赖路径仍全绿）；
 * - 依赖已安装但模型未下载 → 只验证受控失败，绝不触发下载；
 * - 依赖与模型都在 → 真实推理 smoke（仅此分支触碰真实模型文件，仍是本地离线推理）。
 */

const modulePresent = await import(TRANSFORMERS_MODULE)
  .then(() => true)
  .catch(() => false);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultModelFile = path.join(packageRoot, "models", ...DEFAULT_LOCAL_MODEL_NAME.split("/"), "onnx", "model_quantized.onnx");
const modelPresent = existsSync(defaultModelFile);

function tempModelRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "embedding-local-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe.skipIf(!modulePresent)("transformers 模块已安装", () => {
  it("模型目录缺失 → 受控失败（不联网、不抛裸错误）", async () => {
    const options: TransformersProviderOptions = { modelDir: tempModelRoot() };
    await expect(createTransformersProvider(options)).rejects.toThrow(/\[embedding-local\].*本地模型/);
  });

  it.skipIf(!modelPresent)("真实本地模型：嵌入有限、维度恒定、缓存一致", async () => {
    const provider = await createTransformersProvider({});
    const a = await provider.embed("把这个函数改成和上次一样的错误处理");
    const b = await provider.embed("把这个函数改成和上次一样的错误处理");
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    for (const x of a) expect(Number.isFinite(x)).toBe(true);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3); // normalize: true
  });

  it.skipIf(!modelPresent)("接入 core 检测器：真实模型下规则外表述可检出", async () => {
    const detector = await createLocalEmbeddingDetector({});
    expect(isAsyncDetector(detector)).toBe(true);
    const refs = await detector.detectAsync("照老规矩处理这段代码");
    expect(refs.some((r) => r.expectedType === "history-content")).toBe(true);
  });

  it.skipIf(!modelPresent)("真实模型评估下限（默认阈值）：P/R ≥ 0.8，规则外子集 recall ≥ 0.6", async () => {
    expect(embeddingEvalLeakErrors(DEFAULT_EMBEDDING_EXAMPLES, EMBEDDING_EVAL_SET)).toEqual([]);
    const detector = await createLocalEmbeddingDetector({}); // 默认阈值（核心内 DEFAULT_EMBEDDING_THRESHOLDS）
    const predictions = new Map();
    for (const c of EMBEDDING_EVAL_SET) {
      predictions.set(c.prompt, await detector.detectAsync(c.prompt));
    }
    const overall = evaluateRefDetection(EMBEDDING_EVAL_SET, (p) => predictions.get(p) ?? []);
    expect(overall.precision).toBeGreaterThanOrEqual(0.8);
    expect(overall.recall).toBeGreaterThanOrEqual(0.8);

    const embeddingOnly = EMBEDDING_EVAL_SET.map((c) => ({
      prompt: c.prompt,
      expected: c.expected.filter((e) => e.origin === "embedding"),
    })).filter((c) => c.expected.length > 0);
    const sub = evaluateRefDetection(embeddingOnly, (p) => predictions.get(p) ?? []);
    expect(sub.recall).toBeGreaterThanOrEqual(0.6); // 规则检测器在该子集上为 0
  });
});

describe.skipIf(modulePresent)("transformers 模块未安装（拔掉依赖路径）", () => {
  it("createTransformersProvider 受控失败；createLocalEmbeddingDetector 永不抛出（规则回退）", async () => {
    await expect(createTransformersProvider({ modelDir: tempModelRoot() })).rejects.toThrow(
      /\[embedding-local\]/,
    );
    const detector = await createLocalEmbeddingDetector({ modelDir: tempModelRoot() });
    expect(isAsyncDetector(detector)).toBe(true);
    // provider 不可用 → 同步与异步路径都等于规则检测器输出
    expect(detector.detect("这个函数")).toHaveLength(1);
    expect(await detector.detectAsync("这个函数")).toHaveLength(1);
  });
});
