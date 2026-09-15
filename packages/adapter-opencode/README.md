# @subconscious/adapter-opencode

OpenCode plugin 适配器：在用户消息到达模型之前，经 `chat.message` hook 本地解析
「上次」「这个项目」等悬空指代，把接地上下文 append-only 追加到**当前用户消息**。
无法可靠解析时原样透传，绝不阻塞宿主消息流。M5c-2 起兼承 `event` hook 的
`session.idle`：会话空闲时做**项目惯例蒸馏**（见下文「惯例蒸馏」）。

## 工作方式

OpenCode 插件协议（官方文档 <https://opencode.ai/docs/plugins> 与锁定版本
`@opencode-ai/plugin@1.18.30` 类型声明，2026-09-14 核实）：

- **插件形态**：模块导出 `Plugin` 函数，收 `{ client, project, directory, worktree,
  serverUrl, $ }` 返回 hooks 对象；npm 包经 `opencode.json` 的 `"plugin": [...]`
  加载，本地文件放 `.opencode/plugins/`（项目级）或 `~/.config/opencode/plugins/`
  （全局）；所有 hooks 顺序执行。
- **插入点 `chat.message`**：`(input { sessionID, agent?, … }, output { message:
  UserMessage; parts: Part[] }) => Promise<void>`——output 按引用传入，宿主 await
  后把同一对象持久化并送 LLM。`UserMessage` 本体无文本字段，用户话语在非合成
  text part。⚠️ 官方文档事件列表未单独列出此 hook，以锁定版本的类型声明
  （"Called when a new message is received"）为准。
- **只改当前用户消息**：注入物以 `\n\n` 追加到第一个非合成 text part 的尾部，
  原文逐字节前缀保持；不 push 新 part、不动其他 part、不动历史消息
  （`experimental.chat.messages.transform` 才触及历史，本适配器禁用）。
- **fail-open**：整个流程 try/catch + 总超时（默认 5000ms = 引擎机器预算 3000ms
  + 余量；`SUBCONSCIOUS_OPENCODE_TIMEOUT_MS` 可覆盖，正整数，上限 30000），任何
  失败表现为「没生效」。

## 安装

把本仓库放进项目（或子模块），先构建：

```sh
npm ci && npm run build
# 产物：packages/adapter-opencode/dist/plugin.js
```

npm 方式（项目 `opencode.json`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@subconscious/adapter-opencode"]
}
```

本地方式（`.opencode/plugins/subconscious.js`，本地插件可经配置目录 package.json
引外部依赖）：

```js
export { SubconsciousPlugin } from "<本仓库绝对路径>/packages/adapter-opencode/dist/plugin.js";
```

## 能力与降级（DESIGN §7.4 / §8.2）

OpenCode 插件 API 没有 confirm / select / input / 文件选取对话框（TUI 客户端有
toast，属被动通知而非确认通道；`permission.ask` 只服务工具授权），本适配器按
降级矩阵实现（同 Claude Code 形态）：

| 能力 | 实现 |
|---|---|
| confirm（授权确认） | unsupported → L1/L2 数据源不启用 |
| select（候选消歧） | unsupported → 把候选列表注入为「待确认」块，让模型问用户 |
| acquire（获取动作） | unsupported → 注入「需要补充数据」提示，或放弃 |

- **只服务 L0 数据源**：`cwd-context`、`active-editor`、`recent-sessions`、
  `session-content`（`OPENCODE_L0_SOURCES`）。clipboard（L1）在无确认通道下不
  注册，结构上不可读。
- **注入块**：已解析项进 `[潜意识引擎·已解析]`（core 组装，带来源标注）；被降级
  的交互进 `[潜意识引擎·待确认]`，不冒充已解析结论。
- **HostEnv 快照**：`cwd` 取官方 `PluginInput.directory`（缺失即 no-op）；会话
  数据走官方 SDK 客户端（`session.list` 按 directory 过滤本项目会话并排除当前
  `sessionID`、`time.updated` 降序；`session.get` + `session.diff` 取绑定会话的
  FileDiff 作历史内容），不直读 `~/.local/share/opencode` 存储——经官方 API 的
  字段与语义均可核实；`cwd-context` 为有界目录摘要 + `git status --porcelain`。

## 可选 embedding 检测器（opt-in）

默认只用规则检测器（不装任何额外依赖即工作）。设置 `SUBCONSCIOUS_EMBEDDING=1`
后，本适配器会动态 import `@subconscious/embedding-local`（**需自行安装**，含可
选依赖 `@huggingface/transformers` 与本地模型），用其 `createLocalEmbeddingDetector`
包规则检测器，额外检出规则词典外的表述（如「照老规矩」）：

- `SUBCONSCIOUS_EMBEDDING_MODEL_DIR`：模型根目录（npm 包不含模型文件；缺省为
  embedding-local 包内 `models/`，需一次性 `npm run fetch:embedding-model` 下载）；
- 包未安装 / 模型缺失 / 加载失败 / 冷加载超过 2s：记 stderr 单行 warn 后回退
  规则检测器，插件永不因此失败或阻塞（fail-open）；插件进程长寿命，模型至多
  加载一次，首次调用超时只影响该次（后续调用命中已就绪的检测器）。

## 个人记忆层（M5b 接线，默认启用）

引擎构造时读取个人记忆 `~/.subconscious/memory.json`（与 grants.json 同目录；
schema 与阈值见根 README「个人记忆层 v0」）：

- **路径覆盖**：`SUBCONSCIOUS_MEMORY_FILE` 指向其他路径（推荐绝对路径；测试/多
  配置隔离用），空白视为未设置。
- **个人惯用语词典**：`phrases` 非空时以 `createPersonalPhraseDetector` 包住当前
  检测器（规则或 opt-in embedding；个人短语优先于基座命中）——短语说出口才触发。
  插件每条 `chat.message` 重建引擎（D11），语义即「每条消息重读」：手工编辑
  memory.json 即时生效，无需重启 OpenCode。
- **消歧先验（本宿主只读不写）**：插件 API 无 confirm/select，亲选学习在本宿主
  结构性不发生；但 pi 等宿主学到（或手工写入）的先验在此可用——达门槛（同项目
  同会话 14 天内被选 ≥2 次且权重 ≥2× 次选）自动代选并标注
  `（按你的常用选择）`，否则照旧注入「待确认」候选。自动代选不回写（防自增强）。
- **fail-open**：文件缺失 / 损坏 / 读取失败 = 空记忆，行为与无此层完全一致，绝不
  阻塞宿主消息流（store 按路径 memoize，进程内写队列串行化）。
- **查看 / 清除 / 迁移**：文件为两空格缩进 JSON，打开即可查看与手工编辑；删除
  文件（或清空对应数组）即清零；新电脑复制该文件即完成迁移。

## 惯例蒸馏（M5c-2，默认启用）

会话空闲时把会话中反复出现的工作惯例蒸馏进 memory.json 的 `conventions` 段，
供「照旧 / 老规矩」类指代解析（设计稿 `docs/CONVENTIONS.md`，DECISIONS D25/D26）：

- **触发**：`event` hook 的 `session.idle`（`EventSessionIdle { properties:
  { sessionID } }`，锁定版 `@opencode-ai/sdk@1.18.30` types.gen.d.ts 核实）。
  OpenCode 无「会话销毁」事件，session.idle 每轮回复完成后都会触发——按会话
  **冷却窗口去抖（默认 30 分钟）**：窗口内同会话只蒸馏一次，窗口过后允许重蒸馏
  （upsert 语义下相同内容 no-op，只有素材演化才更新），把成本约束在每会话每窗口
  至多一次。
- **执行（官方 client 侧 LLM 调用面）**：`client.session.prompt`（POST
  /session/{id}/message，sdk.gen.d.ts:174；响应即 `{ info: AssistantMessage,
  parts }` 助手回复）——**蒸馏在临时会话内进行**（`session.create` → prompt →
  `session.delete`），绝不污染用户会话；`tools: {}` 结构性禁用工具 + 系统提示
  约束 JSON 输出。备选的 spawn `opencode run` 子进程方案**未采用**（client 面已
  公开且足够，D26 记录证据）。
- **素材**：`session.get`（标题）+ `session.diff`（FileDiff 修改记录），全走官方
  SDK 客户端、不直读内部存储（D21.3 纪律）；条数与字符双重上限。
- **防自触发**：临时会话登记进进程内注册表，本插件对它的 `chat.message` /
  `session.idle` 一律跳过（蒸馏回复的 idle 不会再触发蒸馏、蒸馏消息不被注入）。
- **校验（不信模型输出）**：JSON 解析失败放弃；逐条形状校验（expression ≤16 字 /
  content ≤120 字）非法丢弃；超 5 条截断；敏感内容粗筛命中丢弃；与现有条目逐字节
  相同丢弃（防「洗时间」）。
- **开关与配置**：`SUBCONSCIOUS_DISTILL=0` 关闭（其余任何值含未设置 = 开）；
  `SUBCONSCIOUS_DISTILL_TIMEOUT_MS` 覆盖蒸馏超时（正整数，默认 60000，上限
  300000）。
- **fire-open**：蒸馏在后台 promise 内完成（event hook 立即返回，绝不阻塞宿主
  事件流）；任何失败 = stderr 单行 warn 后静默跳过；不做网络重试。
- **隐私**：素材是会话标题与修改记录，交给你正在使用的 OpenCode 模型处理（与你
  在该会话中对话的暴露面一致）；临时会话完成即删（删除失败时标题可辨识
  「subconscious 惯例蒸馏（临时，可删除）」）；产物只落本地 memory.json；
  **清除** = 清空 `conventions` 数组（或删文件）；**完全关闭** =
  `SUBCONSCIOUS_DISTILL=0`。
- **注入侧授权**：蒸馏写入不需授权；惯例**注入**走 L1-grant-once（首次注入经
  「待确认」块让模型问用户——本宿主无确认通道，core 已处理），grants.json 可撤销。

## 诚实边界（不猜测）

- 插件 API 无编辑器状态 → `activeEditor` 缺失，文件/符号指代诚实丢弃。
- 会话 `time.updated` 缺失 → 时间为空串（core 按无效时间排后），不猜。
- 注入通道是 text part → 附件（若有）丢弃并记日志，不把 base64 塞进文本。
- 日志走 stderr JSON 行；`chat.message` 是进程内 await，总超时保证有界返回。

## 测试与验证边界

`npm test -w @subconscious/adapter-opencode`：HostEnv 快照（heyapi 形状假客户端，
离线）、parts 读写纪律、降级端口、`handleChatMessage` 全链路（真实 core 引擎 +
假宿主客户端：注入 / no-op / 待确认降级 / fail-open / 总超时）、官方 `Plugin`
类型接线（`SubconsciousPlugin` 通过 `@opencode-ai/plugin@1.18.30` 的类型检查即
协议形状证据）、蒸馏全链路（假 SDK 客户端：临时会话 create/prompt/delete 调用
记录断言、`session.idle` 触发写回、临时会话防自触发、冷却窗口去抖、开关与
fail-open）。

**mock ≠ 真实宿主**：本包未做真实 OpenCode 宿主端到端验证（监督约束禁止改全局
宿主配置）；安装后建议先用无指代语句冒烟（行为应与裸 OpenCode 完全一致），再用
「分析这个项目的结构」验证注入。

## 依赖

运行时只依赖 `@subconscious/core`；`@opencode-ai/plugin` 为 optional peer
（类型来源，devDependencies 精确锁定 `1.18.30`，代码仅 type-only import，
编译后零宿主引用）。
