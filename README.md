# subconscious-engine

在用户话语到达模型前，本地识别“上次”“这个文件”“一样的错误处理”等悬空指代，并在有证据时注入可追溯的上下文。无法可靠解析时保持原话，不猜测。

## 能力（M1–M4）

### 核心引擎（`@subconscious/core`，零运行时依赖）

- 中英文规则检测、历史会话/变更上下文、当前工作目录与 active-editor 的保守解析；无法可靠解析时原样透传。
- 两波解析与历史绑定（history-content 绑定所选会话）、并行解析、总超时保留已完成项、迟到回调无新副作用。
- 文件持久化授权清单（`sourceId + scope` 精确匹配，原子写、损坏 fail-open 为未授权）；L1 clipboard 只在确认后读取；L2 永不落盘；L3 获取动作先轻量确认。
- 明确图片指代经确认后使用 macOS 原生选择框，限 PNG/JPEG/GIF/WebP、5 MiB，走附件通道（结构上不可能把 base64 写进 context）。

### 宿主适配器

| 适配器 | 插入点 | 注入方式 | 交互降级 |
|---|---|---|---|
| `@subconscious/adapter-pi` | `before_agent_start` | 可见 custom message（display: true） | 宿主 UI 全量（confirm/select/input/acquire） |
| `@subconscious/adapter-claude` | Claude Code `UserPromptSubmit` hook | stdout `additionalContext`（单行 hook JSON，退出码恒 0） | 无 UI：候选列表注入「待确认」块 |
| `@subconscious/adapter-opencode` | OpenCode `chat.message` | append-only 追加到当前用户消息 text part | 无 UI：同 Claude Code 降级矩阵 |

- pi：真实 pi `SessionManager` 读写 fixture 会话（临时目录），不触碰 `~/.pi`；会话内容按 edit/write diff 提取。
- claude：stdin hook JSON → stdout 合法 hook JSON，日志仅 stderr；只登记 L0 数据源，`transcript` 内部结构无官方文档 → 历史内容诚实 not-found。
- opencode：会话数据全走官方 SDK 客户端（`session.list/get/diff`），不直读内部存储；`@opencode-ai/plugin` 为 optional peer（type-only import，产物零宿主引用）。

### 可选 embedding 检测器（`@subconscious/embedding-local`）

- 规则词典外的表述（如「照老规矩」）经进程内本地向量近邻分类检出；core 保持零依赖，transformers.js（`@huggingface/transformers`）为该包**可选 peer**，模型本地 ONNX 离线推理。
- **适配器 opt-in 接线（硬化轮）**：三个适配器默认只用规则检测器；设 `SUBCONSCIOUS_EMBEDDING=1` 即动态 import 该包接入（`SUBCONSCIOUS_EMBEDDING_MODEL_DIR` 指模型目录）。包未安装 / 模型缺失 / 加载失败 / 冷加载超 2s → stderr 单行 warn 后回退规则，宿主永不因此中断。
- 离线评估：`npm run eval:embedding:fixture`（无需模型）；真实模型 `npm run eval:embedding`（见下）。

### 工程与验证

- `npm run check`（strict TS 类型检查 + 全部测试，离线）、`npm run check-deps`（R1–R8 依赖契约：peer 锁定、core 零依赖方向、可选依赖形态、适配器不依赖 embedding-local）。
- `npm run smoke:pack`：core / adapter-claude / adapter-opencode / embedding-local 四包 `npm pack` → 临时目录 tarball 安装 → 导入 + 最小功能断言（纯离线，registry 指向不可达地址自证；opencode/claude 未装 peer 导入不抛错）。
- `npm run demo`：离线端到端演示（真实 SessionManager fixture + 真实 adapter handler 代码路径）。
- CI（`.github/workflows/ci.yml`）依次运行以上四项。

## 本地验证

需要 Node.js 22 或更新版本：

```sh
npm ci
npm run check
npm run check-deps
npm run demo
npm run smoke:pack
```

M3 embedding 评估（均离线可复现；真实模型模式需一次性 setup，见 `packages/embedding-local/README.md`）：

```sh
npm run eval:embedding:fixture   # 离线确定性评估（无需模型与可选依赖）
npm run eval:embedding           # 真实本地模型评估（Xenova/paraphrase-multilingual-MiniLM-L12-v2，q8）
```

实测（2026-09-14，34 例中英文 held-out 评估集，泄漏检查程序化通过）：真实模型 precision 96.4% / recall 90.0% / F1 93.1%，规则基线同集 recall 50%；规则外表述子集 recall 80%（规则 0%）。

真实 pi 最小加载验证：

```sh
pi --offline --no-session --no-extensions --no-skills \
  --extension "$PWD/packages/adapter-pi/dist/index.js" --no-tools -p "hello"
```

## 验证状态与边界（诚实声明）

**已验证（离线 / 协议级）**：

- 全部单元与集成测试离线运行（无网络、无真实账户）；embedding 接线测试用 fixture provider 注入，不依赖真实模型。
- adapter-claude：真实子进程协议测试（spawn `dist/hook-main.js`，stdin/stdout JSON 往返）；监督者 M4a 验收时亲测子进程协议。
- adapter-opencode：`SubconsciousPlugin` 通过锁定版本 `@opencode-ai/plugin@1.18.30` 类型检查（协议形状证据）+ heyapi 形状假客户端驱动真实 core 引擎全链路；监督者 M4b 验收时亲测 dist 零 `@opencode-ai` 运行时引用与 dist/plugin.js 真实加载导出。
- adapter-pi：本机 `pi 0.85.1` 真实扩展加载（`--offline --no-session`）。
- tarball 独立消费者 smoke：四包 npm pack 后在全新目录安装导入并运行最小功能断言。

**未做（不以 mock 冒充）**：

- 没有真人 pi / Claude Code / OpenCode 宿主端到端验证（监督约束禁止改全局宿主配置或接触私人会话/剪贴板）；安装后建议先用无指代语句冒烟（行为应与裸宿主一致）。
- macOS 图片选择仅在 macOS 可用；纯终端 pi 无 active editor 时文件指代被诚实丢弃。
- adapter-claude 的历史内容注入受限于 transcript 结构无官方文档，诚实 not-found。
- 真实模型评估中裸 "that"（"I like that idea"）存在已知误检（保留为已知边界，不以牺牲 7 个 TP 的 margin 换取单个 FP 消除）。
