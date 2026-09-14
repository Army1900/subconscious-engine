#!/usr/bin/env node
/**
 * M3 embedding 检测器可复现评估（docs/ACCEPTANCE.md「M3 embedding」行的证据来源）。
 *
 * 用法（先构建）：
 *   npm run eval:embedding           # 真实本地模型（transformers.js + 本地 ONNX）
 *   npm run eval:embedding:fixture   # 离线确定性 fixture（无需模型与可选依赖）
 * 可选参数：--provider fixture|transformers --accept 0.6 --margin 0.1
 *
 * 判定口径（与 packages/core/test/embedding-data.test.ts 一致）：
 * - 命中（TP）= 预测指代与期望指代 span 重叠且类型一致；
 * - FP = 预测未命中任何期望；FN = 期望未被命中；负例的任何预测都是 FP；
 * - precision = TP/(TP+FP)，recall = TP/(TP+FN)，F1 为两者调和平均；
 * - 句子准确率 = 预测集合与期望集合完全一致的用例占比。
 *
 * 网络边界：fixture 模式零依赖零网络；transformers 模式只读本地模型目录，
 * 依赖或模型缺失时打印 SKIP 并以退出码 0 结束（不伪造结果）。
 */
import {
  DEFAULT_EMBEDDING_EXAMPLES,
  DEFAULT_EMBEDDING_THRESHOLDS,
  EMBEDDING_EVAL_SET,
  createEmbeddingDetector,
  createRuleDetector,
  embeddingEvalLeakErrors,
  evaluateRefDetection,
} from "@subconscious/core";
import { createFixtureKeywordProvider, createTransformersProvider } from "../dist/index.js";

function parseArgs(argv) {
  const read = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    provider: read("--provider", "transformers"),
    accept: Number(read("--accept", String(DEFAULT_EMBEDDING_THRESHOLDS.accept))),
    margin: Number(read("--margin", String(DEFAULT_EMBEDDING_THRESHOLDS.margin))),
  };
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

async function buildDetector(args) {
  const detectorOptions = { thresholds: { accept: args.accept, margin: args.margin } };
  if (args.provider === "fixture") {
    return {
      detector: createEmbeddingDetector(createFixtureKeywordProvider(), detectorOptions),
      providerId: "fixture:keyword-v1",
    };
  }
  const provider = await createTransformersProvider({});
  return { detector: createEmbeddingDetector(provider, detectorOptions), providerId: provider.id };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!["fixture", "transformers"].includes(args.provider)) {
    console.error(`未知 provider：${args.provider}`);
    process.exit(1);
  }

  const leaks = embeddingEvalLeakErrors(DEFAULT_EMBEDDING_EXAMPLES, EMBEDDING_EVAL_SET);
  if (leaks.length > 0) {
    console.error("评估集泄漏检查失败：");
    for (const line of leaks) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log(`泄漏检查通过：${EMBEDDING_EVAL_SET.length} 例（期望指代与 ${DEFAULT_EMBEDDING_EXAMPLES.length} 条训练示例无重叠）`);

  let built;
  try {
    built = await buildDetector(args);
  } catch (err) {
    console.log(`SKIP: provider 不可用（${err instanceof Error ? err.message : String(err)}）`);
    console.log("     setup：npm install --no-save @huggingface/transformers@^3 && npm run fetch:embedding-model [-- --base https://hf-mirror.com]");
    process.exit(0);
  }
  const { detector, providerId } = built;

  const startedAt = Date.now();
  const predictions = new Map();
  for (const c of EMBEDDING_EVAL_SET) {
    predictions.set(c.prompt, await detector.detectAsync(c.prompt));
  }
  const detectMs = Date.now() - startedAt;

  const rule = createRuleDetector();
  const overall = evaluateRefDetection(EMBEDDING_EVAL_SET, (p) => predictions.get(p) ?? []);
  const ruleBase = evaluateRefDetection(EMBEDDING_EVAL_SET, (p) => rule.detect(p));
  const embeddingOnly = EMBEDDING_EVAL_SET.map((c) => ({
    prompt: c.prompt,
    expected: c.expected.filter((e) => e.origin === "embedding"),
  })).filter((c) => c.expected.length > 0);
  const embOnly = evaluateRefDetection(embeddingOnly, (p) => predictions.get(p) ?? []);
  const embOnlyRule = evaluateRefDetection(embeddingOnly, (p) => rule.detect(p));

  console.log(`\nprovider=${providerId}  thresholds: accept=${args.accept} margin=${args.margin}  detect 总耗时 ${detectMs}ms`);
  console.log("\n== 整体（规则 ∪ embedding 合并检测器）==");
  console.log(`  TP=${overall.tp} FP=${overall.fp} FN=${overall.fn}  precision=${pct(overall.precision)} recall=${pct(overall.recall)} F1=${pct(overall.f1)} 句子准确率=${pct(overall.sentenceAccuracy)}`);
  console.log("== 规则基线（同一评估集）==");
  console.log(`  TP=${ruleBase.tp} FP=${ruleBase.fp} FN=${ruleBase.fn}  precision=${pct(ruleBase.precision)} recall=${pct(ruleBase.recall)} F1=${pct(ruleBase.f1)} 句子准确率=${pct(ruleBase.sentenceAccuracy)}`);
  console.log("== embedding 专属子集（规则外表述）==");
  console.log(`  合并检测器: TP=${embOnly.tp} FP=${embOnly.fp} FN=${embOnly.fn} recall=${pct(embOnly.recall)}`);
  console.log(`  规则基线 : TP=${embOnlyRule.tp} FN=${embOnlyRule.fn} recall=${pct(embOnlyRule.recall)}`);
  if (overall.falsePositives.length > 0) {
    console.log("  FP 明细:");
    for (const fp of overall.falsePositives) {
      console.log(`    "${fp.text}"（${fp.type}）@ ${fp.prompt}`);
    }
  }
  console.log(
    `\n${JSON.stringify({
      type: "embedding-eval",
      provider: providerId,
      accept: args.accept,
      margin: args.margin,
      detectMs,
      precision: Number(overall.precision.toFixed(4)),
      recall: Number(overall.recall.toFixed(4)),
      f1: Number(overall.f1.toFixed(4)),
      sentenceAccuracy: Number(overall.sentenceAccuracy.toFixed(4)),
      embeddingOnlyRecall: Number(embOnly.recall.toFixed(4)),
      ruleBaselineRecall: Number(ruleBase.recall.toFixed(4)),
    })}`,
  );

  if (args.provider === "fixture" && (overall.precision < 0.85 || overall.recall < 0.85)) {
    console.error("fixture 模式指标低于回归下限（0.85）");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`eval-embedding: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
