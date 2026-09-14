#!/usr/bin/env node
/**
 * 显式联网下载本地 embedding 模型（一次性 setup 步骤）。
 *
 * 网络边界（监督红线「测试不依赖网络」的对应面）：
 * - 本脚本是 embedding-local 里**唯一**联网入口，且仅在用户显式运行时执行；
 * - 下载后的推理与全部测试（npm run check）都只读本地文件、零网络；
 * - 模型目录默认 packages/embedding-local/models/<模型名>/，已被 .gitignore 排除。
 *
 * 用法：npm run fetch:embedding-model [-- --model Xenova/paraphrase-multilingual-MiniLM-L12-v2]
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const FILES = [
  "config.json",
  "tokenizer_config.json",
  "tokenizer.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];

function parseArgs(argv) {
  const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : DEFAULT_MODEL;
  // 默认官方源；网络受限环境可用 --base https://hf-mirror.com（镜像，内容同源）
  const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "https://huggingface.co";
  return { model, base: base.replace(/\/+$/, "") };
}

async function fetchToFile(url, target) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`下载内容为空：${url}`);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, buf);
  rmSync(target, { force: true });
  writeFileSync(target, buf); // 同目录写入后删 tmp，近似原子
  rmSync(tmp, { force: true });
  return buf.length;
}

async function main() {
  const { model, base } = parseArgs(process.argv.slice(2));
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const modelDir = path.join(packageRoot, "models", ...model.split("/"));
  mkdirSync(path.join(modelDir, "onnx"), { recursive: true });

  console.log(`下载模型 ${model}（源 ${base}）-> ${modelDir}`);
  for (const file of FILES) {
    const url = `${base}/${model}/resolve/main/${file}`;
    const target = path.join(modelDir, file);
    process.stdout.write(`  ${file} ... `);
    const bytes = await fetchToFile(url, target);
    console.log(`${(bytes / 1024 / 1024).toFixed(2)} MiB`);
    if (file.endsWith(".json")) JSON.parse(readFileSync(target, "utf8")); // JSON 完整性校验
  }
  console.log("完成。推理与测试不联网；重跑评估：npm run eval:embedding");
}

main().catch((err) => {
  console.error(`fetch-model: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
