# @subconscious/adapter-claude

Claude Code hooks 适配器：在用户 prompt 到达模型之前，经 `UserPromptSubmit` hook
本地解析「上次」「这个项目」等悬空指代并注入接地上下文。无法可靠解析时输出空、
原样透传，绝不阻塞 hook。M5c-2 起同一 bin 兼承 `SessionEnd` hook：会话结束时做
**项目惯例蒸馏**（见下文「惯例蒸馏」）。

## 工作方式

Claude Code 对 `UserPromptSubmit` hook 的调用协议（官方 hooks reference，
<https://docs.claude.com/en/docs/claude-code/hooks>，2026-09-14 核实；SessionEnd
事件面 2026-09-15 核实）：

- **输入**：stdin 一次性 JSON，通用字段 `session_id` / `transcript_path` / `cwd` /
  `permission_mode` / `hook_event_name`；`UserPromptSubmit` 另有 `prompt`，
  `SessionEnd` 另有 `reason`（如 clear / logout / prompt_input_exit）；
- **输出（UserPromptSubmit）**：stdout 单行 JSON
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}`，
  `additionalContext` 会被追加进模型上下文；
- **输出（SessionEnd）**：**无 stdout JSON**（SessionEnd 无上下文通道），只做蒸馏，
  日志 stderr；
- **日志**：只写 stderr（`UserPromptSubmit` 的 stdout 会被并入上下文，任何非载荷
  输出都是污染）；
- **阻塞语义**：`decision:"block"` / 退出码 2 会阻断并抹除用户 prompt——本适配器
  结构上不使用，退出码恒为 0（fail-open）。

## 安装（settings.json 片段）

把本仓库放进项目（或子模块），先构建：

```sh
npm ci && npm run build
# 产物：packages/adapter-claude/dist/hook-main.js
```

在**项目**设置 `.claude/settings.json`（不要改全局 `~/.claude/settings.json`；
`UserPromptSubmit` 不使用 matcher，`timeout` 单位为秒；`SessionEnd` 复用同一 bin，
若开启惯例蒸馏建议 `timeout` 给足蒸馏预算）：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/packages/adapter-claude/dist/hook-main.js",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/packages/adapter-claude/dist/hook-main.js",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

同目录 `examples/settings.json` 是同一片段。`/hooks` 菜单确认注册即可。也可用 npm
bin 安装后直接写 `subconscious-claude-hook`。环境变量
`SUBCONSCIOUS_HOOK_TIMEOUT_MS`（正整数，上限 30000）可覆盖 UserPromptSubmit 总超时
（默认 5000ms，内部引擎机器预算 3000ms）；SessionEnd 蒸馏有自己的超时预算
（见下文，默认 50s，不受该值约束）。

## 能力与降级（DESIGN §7.3 / §8.2）

hook 是子进程 JSON 协议，没有对话式 UI，本适配器按降级矩阵实现：

| 能力 | 实现 |
|---|---|
| confirm（授权确认） | unsupported → L1/L2 数据源不启用 |
| select（候选消歧） | unsupported → 把候选列表注入为「待确认」块，让模型问用户 |
| acquire（获取动作） | unsupported → 注入「需要补充数据」提示，或放弃 |

- **只服务 L0 数据源**：`cwd-context`、`active-editor`、`recent-sessions`、
  `session-content`（`CLAUDE_L0_SOURCES`）。clipboard（L1）在无确认通道下不注册，
  结构上不可读。
- **注入块**：已解析项进 `[潜意识引擎·已解析]`（core 组装，带来源标注）；被降级
  的交互进 `[潜意识引擎·待确认]`（候选列表 / 获取提示），不冒充已解析结论。
- **HostEnv 快照**：`cwd` 取 hook 输入的 `cwd` 字段；`transcript_path` 同目录的
  `*.jsonl` 兄弟文件作为本项目历史会话（排除当前 `session_id`，按 mtime 降序），
  会话元数据只取文件名与 mtime，不解析文件内容。

## 可选 embedding 检测器（opt-in）

默认只用规则检测器（不装任何额外依赖即工作）。设置 `SUBCONSCIOUS_EMBEDDING=1`
后，本适配器会动态 import `@subconscious/embedding-local`（**需自行安装**，含可
选依赖 `@huggingface/transformers` 与本地模型），用其 `createLocalEmbeddingDetector`
包规则检测器，额外检出规则词典外的表述（如「照老规矩」）：

- `SUBCONSCIOUS_EMBEDDING_MODEL_DIR`：模型根目录（npm 包不含模型文件；缺省为
  embedding-local 包内 `models/`，需一次性 `npm run fetch:embedding-model` 下载）；
- 包未安装 / 模型缺失 / 加载失败 / 冷加载超过 2s：记 stderr 单行 warn 后回退
  规则检测器，hook 永不因此失败或阻塞（fail-open）；
- hook 是一次性子进程，冷加载计入总超时预算——开启后建议把
  `SUBCONSCIOUS_HOOK_TIMEOUT_MS` 调到 10000 左右，并为 Claude Code 设置的
  `timeout`（秒）留出余量。

## 个人记忆层（M5b 接线，默认启用）

引擎构造时读取个人记忆 `~/.subconscious/memory.json`（与 grants.json 同目录；
schema 与阈值见根 README「个人记忆层 v0」）：

- **路径覆盖**：`SUBCONSCIOUS_MEMORY_FILE` 指向其他路径（推荐绝对路径；测试/多
  配置隔离用），空白视为未设置。
- **个人惯用语词典**：`phrases` 非空时以 `createPersonalPhraseDetector` 包住当前
  检测器（规则或 opt-in embedding；个人短语优先于基座命中）——短语说出口才触发。
  hook 是每 prompt 一次性子进程，语义即「每 prompt 重读」：手工编辑 memory.json
  即时生效，无需重启宿主。
- **消歧先验（本宿主只读不写）**：UserPromptSubmit 无 select 通道，亲选学习在本
  宿主结构性不发生；但 pi 等宿主学到（或手工写入）的先验在此可用——达门槛（同
  项目同会话 14 天内被选 ≥2 次且权重 ≥2× 次选）自动代选并标注
  `（按你的常用选择）`，否则照旧注入「待确认」候选。自动代选不回写（防自增强）。
- **fail-open**：文件缺失 / 损坏 / 读取失败 = 空记忆，行为与无此层完全一致，绝不
  阻塞 hook；读写为毫秒级文件操作，不占用总超时预算的可感知份额。
- **查看 / 清除 / 迁移**：文件为两空格缩进 JSON，打开即可查看与手工编辑；删除
  文件（或清空对应数组）即清零；新电脑复制该文件即完成迁移。

## 惯例蒸馏（M5c-2，默认启用）

会话结束（`SessionEnd` hook）时把会话中反复出现的工作惯例蒸馏进 memory.json 的
`conventions` 段，供「照旧 / 老规矩」类指代解析（设计稿 `docs/CONVENTIONS.md`，
DECISIONS D25/D26）：

- **时机**：`SessionEnd`（stdin JSON：通用字段 + `reason`；reason 仅记日志，不作为
  门槛）。hook 进程内 spawn headless `claude -p "<提示词>"` 并等待输出（默认 50s，
  在宿主 hook 默认 60s 上限内），随后校验写回——hook 进程本身即「会话结束后」的
  一次性进程，等待是完成写回的唯一途径。
- **素材（近似，如实注明）**：`transcript_path` JSONL 的**尾部 64KB 原文拼接**——
  transcript 内部结构无官方文档，本适配器不解析任何字段，素材是原始 JSONL 行的
  近似（模型自行阅读，可能含结构噪声）；尾部换行对齐、fatal UTF-8 校验。
- **防递归哨兵**：蒸馏子进程带 `SUBCONSCIOUS_DISTILL_CHILD=1`，其内部触发的任何
  hook（UserPromptSubmit 注入 / SessionEnd 再蒸馏）都被入口顶部哨兵拦截为 no-op。
- **校验（不信模型输出）**：JSON 解析失败放弃；逐条形状校验（expression ≤16 字 /
  content ≤120 字）非法丢弃；超 5 条截断；敏感内容粗筛（凭据形态 / 长随机串）
  命中丢弃；与现有条目逐字节相同丢弃（防「洗时间」）。
- **开关与配置**：`SUBCONSCIOUS_DISTILL=0` 关闭（其余任何值含未设置 = 开）；
  `SUBCONSCIOUS_DISTILL_TIMEOUT_MS` 覆盖蒸馏超时（正整数，上限 300000；调高时
  settings.json 的 hook `timeout` 需同步给足，单位为秒）；`SUBCONSCIOUS_DISTILL_BIN`
  覆盖 headless claude 可执行文件（测试注入假可执行文件用）。
- **去抖 / fail-open**：同会话重复 SessionEnd 只蒸馏一次（进程内记忆；hook 是一次性
  子进程，跨进程重复事件按不同会话时刻处理）；蒸馏任何失败 = stderr 单行 warn 后
  静默跳过，输出空、退出码 0，绝不影响会话结束；不做网络重试。
- **隐私**：素材是会话 transcript 内容，交给你正在使用的 claude 模型处理（与你在
  该会话中对话的暴露面一致）；产物只落本地 memory.json；**清除** = 清空
  `conventions` 数组（或删文件）；**完全关闭** = `SUBCONSCIOUS_DISTILL=0`。
- **注入侧授权**：蒸馏写入不需授权；惯例**注入**走 L1-grant-once（首次注入经
  「待确认」块让模型问用户——本宿主无确认通道，core 已处理），grants.json 可撤销。

## 诚实边界（不猜测）

- hooks 协议不提供编辑器状态 → `activeEditor` 缺失，文件/符号指代诚实丢弃。
- 会话 JSONL 的**内部结构**无官方文档 → `readSessionContent` 不提供：历史内容
  （「一样的错误处理」）不注入；仅当官方文档化后开放。**惯例蒸馏的素材因此是
  transcript 尾部原文近似**（不解析字段，见「惯例蒸馏」节）。
- 会话标题无法核实 → 候选标签由文件名 + mtime 派生（`Claude 会话 <id>`）；蒸馏
  条目的 `basedOnSessionTitle` 为空（display 回退会话 id，不虚构标题）。
- `UserPromptSubmit` 无附件通道 → 附件（若有）丢弃并记日志，不把 base64 塞进文本。
- 全流程 try/catch + 总超时；任何失败输出空、退出码 0。

## 测试

`npm test -w @subconscious/adapter-claude`：输入解析（含 SessionEnd）、HostEnv 快照、
降级端口、处理器降级矩阵、蒸馏校验单元组（假执行器注入）、以及**真实子进程协议
测试**（spawn `node dist/hook-main.js`，经 stdin/stdout JSON 验证注入、no-op、
fail-open 与总超时；SessionEnd 蒸馏路径同法——headless claude 用**假可执行文件**
回放固定 JSON，绝不真调宿主 CLI；不用进程内 mock 冒充协议测试）。

## 依赖

运行时只依赖 `@subconscious/core`（hooks 是协议级集成，无需宿主 SDK）。
