# @subconscious/adapter-claude

Claude Code hooks 适配器：在用户 prompt 到达模型之前，经 `UserPromptSubmit` hook
本地解析「上次」「这个项目」等悬空指代并注入接地上下文。无法可靠解析时输出空、
原样透传，绝不阻塞 hook。

## 工作方式

Claude Code 对 `UserPromptSubmit` hook 的调用协议（官方 hooks reference，
<https://docs.claude.com/en/docs/claude-code/hooks>，2026-09-14 核实）：

- **输入**：stdin 一次性 JSON，字段 `session_id` / `transcript_path` / `cwd` /
  `permission_mode` / `hook_event_name` / `prompt`；
- **输出**：stdout 单行 JSON
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}`，
  `additionalContext` 会被追加进模型上下文；
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
`UserPromptSubmit` 不使用 matcher，`timeout` 单位为秒）：

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
    ]
  }
}
```

同目录 `examples/settings.json` 是同一片段。`/hooks` 菜单确认注册即可。也可用 npm
bin 安装后直接写 `subconscious-claude-hook`。环境变量
`SUBCONSCIOUS_HOOK_TIMEOUT_MS`（正整数，上限 30000）可覆盖总超时（默认 5000ms，
内部引擎机器预算 3000ms）。

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

## 诚实边界（不猜测）

- hooks 协议不提供编辑器状态 → `activeEditor` 缺失，文件/符号指代诚实丢弃。
- 会话 JSONL 的**内部结构**无官方文档 → `readSessionContent` 不提供：历史内容
  （「一样的错误处理」）不注入；仅当官方文档化后开放。
- 会话标题无法核实 → 候选标签由文件名 + mtime 派生（`Claude 会话 <id>`）。
- `UserPromptSubmit` 无附件通道 → 附件（若有）丢弃并记日志，不把 base64 塞进文本。
- 全流程 try/catch + 总超时；任何失败输出空、退出码 0。

## 测试

`npm test -w @subconscious/adapter-claude`：输入解析、HostEnv 快照、降级端口、
处理器降级矩阵、以及**真实子进程协议测试**（spawn `node dist/hook-main.js`，
经 stdin/stdout JSON 验证注入、no-op、fail-open 与总超时；不用进程内 mock 冒充
协议测试）。

## 依赖

运行时只依赖 `@subconscious/core`（hooks 是协议级集成，无需宿主 SDK）。
