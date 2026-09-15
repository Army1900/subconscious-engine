# subconscious-engine

在用户话语到达模型前，本地识别“上次”“这个文件”“一样的错误处理”等悬空指代，并在有证据时注入可追溯的上下文。无法可靠解析时保持原话，不猜测。

## 能力（M1–M5c）

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

### 个人记忆层 v0（M5a：消歧先验 + 个人惯用语词典）

记忆只服务**用户说出口的指代**，不做预测注入。位置 `~/.subconscious/memory.json`（与 grants.json 同目录；原子写，损坏 fail-open 为空记忆 = 行为等同今天）：

```json
{
  "version": 2,
  "disambiguation": [
    { "projectKey": "/work/proj", "sessionId": "abc", "title": "错误处理改造", "at": "2026-09-14T10:00:00.000Z" }
  ],
  "phrases": [
    { "phrase": "咱们那个摊子", "expectedType": "project", "hint": "指当前主力仓库（可选）" }
  ],
  "conventions": [
    { "id": "c-…", "projectKey": "/work/proj", "expression": "错误处理", "content": "统一 try/catch 包裹并 log 错误，不吞异常",
      "basedOnSessionId": "abc", "basedOnSessionTitle": "错误处理改造",
      "generatedAt": "2026-09-15T10:00:00.000Z", "lastHitAt": "2026-09-15T10:00:00.000Z", "hitCount": 0 }
  ]
}
```

- **消歧先验**（`createEngine({ memory: store })`）：你在 select 消歧中亲选历史会话时记录一条先验（同项目、近期的选择权重高）；再次遇到多候选时按先验排序，仅当同项目同一会话 14 天内被选 ≥2 次且权重 ≥2× 次选时代选，注入标注 `（按你的常用选择）（来源：recent-sessions）` 可审计；否则照旧弹选择器并继续学习。先验绝不把你没提到的会话加进候选。
- **个人惯用语词典**：`addPersonalPhrase()` 显式注册（或直接手工编辑 phrases 数组），`createPersonalPhraseDetector(检测器, 词条)` 接入检测——短语说出口才触发，命中产出带真实 span 的指代走正常解析；零词条时不包装（默认行为逐字节不变）。v0 不自动学习（错学成本不对称）；「照旧/老规矩 → 惯例值」的惯例蒸馏设计稿见 `docs/CONVENTIONS.md`。
- **查看 / 清除 / 迁移**：文件为两空格缩进 JSON，打开即可查看与手工编辑；删除文件即清零（或清空对应数组）；新电脑复制该文件即完成迁移，程序化迁移用 `exportMemory` / `importMemory` 纯函数。
- **隐私**：内容是你自己选择的记录（项目路径 + 会话标题 + 自注册短语），本地存储、本地消费、不离开设备，按 L0 对待；引擎不传 `memory` 选项时不学习不读取，行为与无此层完全一致。上限：先验 100 条（写入时裁剪 14 天窗口外记录）、词条 200 条、短语 ≤64 字符。
- **适配器接线（M5b，默认启用）**：三个适配器在引擎构造时读取 `~/.subconscious/memory.json`（`SUBCONSCIOUS_MEMORY_FILE` 可覆盖路径，空白视为未设置）。pi 有真实 select 通道 → 亲选即学习；claude / opencode 无 select 通道 → 不学习，但共享同一记忆文件的先验可自动代选（跨宿主共享：pi 学、处处用）。每事件重建引擎（D11）→ 词典每 prompt 重读，手工编辑即时生效。文件缺失 / 损坏 fail-open 为空记忆，绝不阻塞宿主；各包测试经 vitest setup 把路径钉到临时目录，不触真实 `~/.subconscious`。

### 项目惯例蒸馏（M5c：会话结束 → 宿主 LLM 总结 → memory.json `conventions`）

「照旧 / 按老规矩 / 咱们那套」类指代解析为**蒸馏后的惯例值**（设计稿 `docs/CONVENTIONS.md`，裁定 D25，适配器接线 D26）。数据流：会话结束事件 → 适配器组装素材 → **宿主 LLM headless 总结**（core 零 LLM 红线不破）→ 适配器校验（JSON 解析 / 逐条形状 `isConvention` / 超 5 条截断 / 敏感内容粗筛 / 与现有条目逐字节相同丢弃）→ `addConvention` 写回 memory.json。注入侧（M5c-1 已交付）：惯例优先于会话绑定；首次注入经 **L1 授权**（pi 弹 confirm，claude / opencode 注入「待确认」块让模型问用户），授权后本项目自动使用、display 恒带生成出处；90 天未命中写时淘汰、同名后写胜。

| 宿主 | 触发事件 | 蒸馏执行 | 会话素材 |
|---|---|---|---|
| pi | `session_shutdown`（quit/new/resume/fork；reload 跳过） | fire-and-forget detached 子进程 `node distill-child.js` → headless `pi --offline --no-session --no-extensions --no-skills --no-tools -p` | 会话 JSONL 尾部有界读取（≤64KB）→ 用户话语 + edit/write 修改记录 |
| Claude Code | hooks `SessionEnd`（同一 bin 双注册） | hook 进程内 spawn headless `claude -p`（带防递归哨兵 `SUBCONSCIOUS_DISTILL_CHILD=1`，其内部 hook 一律 no-op） | transcript JSONL 尾部有界**原文拼接**（内部结构无官方文档、不解析字段——近似素材） |
| OpenCode | `event` hook 的 `session.idle`（每轮触发，按会话冷却 30 分钟去抖） | 官方 client 侧 LLM 调用 `client.session.prompt`（临时会话内进行、`tools:{}` 结构性禁用工具、完成即删；临时会话的事件/消息本插件跳过，防自触发） | `session.get`（标题）+ `session.diff`（FileDiff），全走官方 SDK |

- **开关**：`SUBCONSCIOUS_DISTILL=0` 关闭（其余任何值含未设置 = 开）；`SUBCONSCIOUS_DISTILL_TIMEOUT_MS` 覆盖蒸馏超时（pi/opencode 默认 60s、claude 默认 50s，上限 300s；claude 调高时需同步调高 settings.json 的 hook `timeout`）；pi/claude 的 headless 命令可经 `SUBCONSCIOUS_DISTILL_BIN` 覆盖（测试注入假可执行文件用）。
- **去抖**：同会话重复结束事件只蒸馏一次（进程内记忆；pi 的 quit 前 new/resume/fork 往返不重复蒸馏）。
- **fail-open**：蒸馏任何失败（素材读取 / 子进程 / 超时 / 输出非法 / 写回）= stderr 单行 warn 后静默跳过，宿主会话与退出流程零影响；不做网络重试。
- **隐私**：蒸馏素材是会话内容，交给你正在使用的宿主模型处理（pi `--offline` 除外——离线模型本地推理；claude/opencode 走宿主自身的模型服务，与你在该会话中对话的暴露面一致）；蒸馏产物只落本地 memory.json（打开即可查看/编辑）；pi 的素材中转文件 0600 权限、读完即删；opencode 临时会话完成即删（删除失败时标题可辨识「subconscious 惯例蒸馏（临时，可删除）」）。**清除**：清空 memory.json 的 `conventions` 数组（或删文件）即清零；**完全关闭蒸馏**：设 `SUBCONSCIOUS_DISTILL=0`。
- **授权与撤销**：蒸馏**写入**不需授权（本地文件）；**注入**走 L1（grants.json 的 `conventions` 条目，删该条即撤销授权）。错误蒸馏的纠正：手工编辑/删除对应条目，或话语否定（「这次别按老规矩」单次跳过）。
- **验证边界（mock vs 真实）**：蒸馏链路的测试全部离线——headless 宿主 CLI 用**假可执行文件**（shell 脚本回放固定 JSON）与注入的假执行器/假 SDK 客户端驱动，hook/child 是真实编译产物子进程；**没有真人 pi / Claude Code / OpenCode 宿主端到端蒸馏验证**（监督约束禁改全局宿主配置、不触真实会话）。

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
- adapter-claude：真实子进程协议测试（spawn `dist/hook-main.js`，stdin/stdout JSON 往返；SessionEnd 蒸馏路径同法——假 headless claude 可执行文件回放）；监督者 M4a 验收时亲测子进程协议。
- adapter-opencode：`SubconsciousPlugin` 通过锁定版本 `@opencode-ai/plugin@1.18.30` 类型检查（协议形状证据）+ heyapi 形状假客户端驱动真实 core 引擎全链路（蒸馏执行面同为假客户端：临时会话 create/prompt/delete 全记录断言）；监督者 M4b 验收时亲测 dist 零 `@opencode-ai` 运行时引用与 dist/plugin.js 真实加载导出。
- adapter-pi：本机 `pi 0.85.1` 真实扩展加载（`--offline --no-session`）；蒸馏链路经真实 `dist/distill-child.js` 子进程 + 假 headless pi 可执行文件驱动（detached fire-and-forget 全链路写回断言）。
- tarball 独立消费者 smoke：四包 npm pack 后在全新目录安装导入并运行最小功能断言。

**未做（不以 mock 冒充）**：

- 没有真人 pi / Claude Code / OpenCode 宿主端到端验证（监督约束禁止改全局宿主配置或接触私人会话/剪贴板）；**含 M5c 惯例蒸馏的真人端到端（真实宿主 CLI 蒸馏子进程）同样未做**——测试中宿主 CLI 一律为假可执行文件。安装后建议先用无指代语句冒烟（行为应与裸宿主一致）。
- macOS 图片选择仅在 macOS 可用；纯终端 pi 无 active editor 时文件指代被诚实丢弃。
- adapter-claude 的历史内容注入受限于 transcript 结构无官方文档，诚实 not-found；蒸馏素材因此用 transcript 尾部**原文近似**（不解析字段）。
- 真实模型评估中裸 "that"（"I like that idea"）存在已知误检（保留为已知边界，不以牺牲 7 个 TP 的 margin 换取单个 FP 消除）。
- 蒸馏质量（提示词/门槛）未做人工标注评估（CONVENTIONS D-B：属 `.supervision/` 评估面）。
