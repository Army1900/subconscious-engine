# @subconscious/embedding-local

M3 可选的进程内本地向量 provider：transformers.js（ONNX）+ 本地模型文件，离线推理。未安装依赖或缺少模型时，`@subconscious/core` 的 `EmbeddingDetector` 自动回退规则检测器——`npm run check` 与 enrich 都不因此失败（fail-open）。

## 网络边界

- 本包唯一联网入口是 `scripts/fetch-model.mjs`（一次性下载模型，用户显式运行；受限网络可用 `--base https://hf-mirror.com`）。
- 下载后，推理与全部测试只读本地文件；`createTransformersProvider` 设置 `env.allowRemoteModels = false`，模型缺失时受控失败，绝不回退联网下载。
- 模型目录 `packages/embedding-local/models/` 已被 .gitignore 排除，不入库。

## 一次性 setup（真实模型评估）

```sh
npm install --no-save @huggingface/transformers@^3
npm run fetch:embedding-model            # 或: --base https://hf-mirror.com
npm run eval:embedding                   # 真实模型评估（P/R/F1 + 规则基线对照）
```

不装依赖/不下载模型也可运行离线确定性评估：

```sh
npm run eval:embedding:fixture
```

## 当前评估结果（2026-09-14，Xenova/paraphrase-multilingual-MiniLM-L12-v2，q8）

| 检测器 | precision | recall | F1 | 句子准确率 |
|---|---|---|---|---|
| 规则 ∪ embedding（默认阈值 accept .65 / margin .1） | 96.4% | 90.0% | 93.1% | 88.2% |
| 规则基线（同一评估集） | 100% | 50.0% | 66.7% | 58.8% |

规则外表述子集（评估集 origin=embedding，15 条期望指代）：合并检测器 recall 80%，规则基线 0%。评估集与训练示例的程序化泄漏检查内置于脚本与测试（`embeddingEvalLeakErrors`）。

## 依赖形态

`@huggingface/transformers` 是**可选 peer**（`^3.8.1` + `peerDependenciesMeta.optional`）：npm 默认不安装它，普通 `npm install` 不拉取 onnxruntime 等重依赖。源码通过动态 import + 运行时结构收窄使用它——**没有该依赖时本包的类型检查与测试依然通过**（对应用例自动跳过，回退路径用例仍验证）。

在适配器中使用：

```ts
import { createLocalEmbeddingDetector } from "@subconscious/embedding-local";
import { createEngine, DEFAULT_SOURCES } from "@subconscious/core";

const detector = await createLocalEmbeddingDetector({ logger }); // 失败不抛出 → 规则回退
const engine = createEngine({ detector, sources: DEFAULT_SOURCES });
```

## 在宿主适配器中启用（硬化轮 opt-in）

三个适配器（pi / claude / opencode）默认只用规则检测器；设置环境变量即可接入本包，
无需改代码（适配器以动态 import 加载本包，**不在其依赖清单中**）：

```sh
export SUBCONSCIOUS_EMBEDDING=1                      # 显式 opt-in（仅 1/true 生效）
export SUBCONSCIOUS_EMBEDDING_MODEL_DIR=/path/to/models  # 可选：模型根目录
```

本包未安装 / 模型缺失 / 加载失败 / 冷加载超过 2s 时，适配器记 stderr 单行 warn
后回退规则检测器（fail-open），宿主行为永不因此中断。
