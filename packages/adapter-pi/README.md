# @subconscious/adapter-pi

pi 扩展适配器：在用户 prompt 到达 agent 之前，经 `before_agent_start` 事件本地解析
「上次」「这个项目」等悬空指代并注入接地上下文（可见 custom message，display:
true）。无法可靠解析时 no-op 透传，绝不影响 pi 行为。M5c-2 起兼承
`session_shutdown`：会话结束时做**项目惯例蒸馏**（见下文）。

## 工作方式

pi 官方扩展协议（锁定版 `@earendil-works/pi-coding-agent@0.85.1` 类型声明 +
`.supervision/pi-extensions.md` 锁定文档快照，2026-09-13/15 核实）：

- **插入点**：`pi.on("before_agent_start", handler)`；返回
  `{ message: { customType, content, display: true } }` 注入持久化、发给 LLM、
  用户可见的消息；无 context → `undefined`（no-op）。
- **交互**：`ctx.ui.confirm / select / input`（原生 `{ signal, timeout }`）——
  pi 是三宿主中唯一有完整确认通道的：L1 授权确认、候选消歧选择器都真实可用。
- **惯例蒸馏触发**：`pi.on("session_shutdown", handler)`
  （`SessionShutdownEvent { reason: "quit" | "reload" | "new" | "resume" | "fork" }`）。

## 安装

构建后把产物放入 `~/.pi/agent/extensions/subconscious/`（或以 Pi Package 形式
安装）：

```sh
npm ci && npm run build
# 产物：packages/adapter-pi/dist/index.js（入口）与 dist/*.js（含 distill-child.js）
```

本机最小加载验证（根 README 同款）：

```sh
pi --offline --no-session --no-extensions --no-skills \
  --extension "$PWD/packages/adapter-pi/dist/index.js" --no-tools -p "hello"
```

## 惯例蒸馏（M5c-2，默认启用）

会话结束时把会话中反复出现的工作惯例蒸馏进 `~/.subconscious/memory.json` 的
`conventions` 段，供「照旧 / 老规矩」类指代解析（设计稿 `docs/CONVENTIONS.md`，
DECISIONS D25/D26）：

- **时机**：`session_shutdown` 的 quit / new / resume / fork（该会话的结束信号）；
  **reload 跳过**——扩展重载时会话仍在继续，此刻蒸馏会把素材冻结在半途，且去抖
  会挡掉结束时的更完整蒸馏。
- **执行（fire-and-forget）**：扩展进程把蒸馏请求写入 0600 临时文件后 detached
  spawn `node dist/distill-child.js <请求文件>` 并立即返回（**绝不阻塞会话结束**；
  quit 后子进程靠 detached 存活完成全流程）。子进程执行 headless
  `pi --offline --no-session --no-extensions --no-skills --no-tools -p "<提示词>"`
  （根 README 已验证的 headless 形态；`--no-extensions` 结构性杜绝蒸馏再触发本
  扩展），收 stdout → 校验 → 写回 memory.json → 删除请求文件。
- **素材**：当前会话 JSONL 的**尾部 64KB 有界读取**（newline 对齐、fatal UTF-8、
  realpath 限 sessionDir 内），复用 session-jsonl 解析提取**用户话语 + edit/write
  修改记录**（跳过失败修改），加会话名，条数与字符双重上限。
- **校验（不信模型输出）**：JSON 解析失败放弃；逐条形状校验（expression ≤16 字 /
  content ≤120 字）非法丢弃；超 5 条截断；敏感内容粗筛（凭据形态 / 长随机串）
  命中丢弃；与现有条目逐字节相同丢弃（防「洗时间」）。
- **开关与配置**：`SUBCONSCIOUS_DISTILL=0` 关闭（其余任何值含未设置 = 开）；
  `SUBCONSCIOUS_DISTILL_TIMEOUT_MS` 覆盖蒸馏超时（正整数，默认 60000，上限
  300000）；`SUBCONSCIOUS_DISTILL_BIN` 覆盖 headless pi 可执行文件（测试注入假
  可执行文件用）。
- **去抖 / fail-open**：同会话重复 shutdown（quit 前的 new/resume/fork 往返）只
  蒸馏一次（进程内记忆）；蒸馏任何失败 = stderr 单行 warn 后静默跳过，绝不影响
  pi 关闭流程；不做网络重试。
- **隐私**：素材经 headless pi 处理——`--offline` 时为本地离线模型推理，完全不
  出设备（与其他宿主经云端模型的暴露面不同）；素材中转文件 0600 权限、读完即删；
  产物只落本地 memory.json。**清除** = 清空 `conventions` 数组（或删文件）；
  **完全关闭** = `SUBCONSCIOUS_DISTILL=0`。
- **注入侧授权**：蒸馏写入不需授权；惯例**注入**走 L1-grant-once——pi 有真实
  confirm 通道，首次注入弹确认（「按惯例…注入？以后本项目自动使用，可随时撤销」），
  授权后不再打扰、display 恒带生成出处；grants.json 可撤销。

## 个人记忆层与可选 embedding（见根 README）

- 记忆接线（M5b）：`~/.subconscious/memory.json`（`SUBCONSCIOUS_MEMORY_FILE`
  覆盖）；pi 有真实 select 通道 → 消歧亲选即学习先验；词典每 prompt 重读，手工
  编辑即时生效。
- embedding opt-in：`SUBCONSCIOUS_EMBEDDING=1` 动态接入
  `@subconscious/embedding-local`（需自行安装）；失败回退规则检测器。

## 测试与验证边界

`npm test -w @subconscious/adapter-pi`（先 build 再 vitest）：handler 全链路
（真实 SessionManager fixture 会话，临时目录、不触真实 `~/.pi`）、HostEnv 快照、
pi UI 交互端口、session-jsonl 解析（含蒸馏素材的 parseUserTurns）、蒸馏校验单元
组（假执行器注入）、**蒸馏子进程全链路**（真实 `dist/distill-child.js` 子进程 +
detached 触发路径 + 假 headless pi 可执行文件回放固定 JSON，绝不真调宿主 CLI）。

**mock ≠ 真实宿主**：没有真人 pi 交互式端到端（M1 定界）；蒸馏的真人端到端（真实
`pi -p` 蒸馏子进程）同样未做——监督约束禁触真实会话。安装后建议先用无指代语句
冒烟（行为应与裸 pi 一致）。

## 依赖

运行时只依赖 `@subconscious/core`；`@earendil-works/pi-coding-agent` 为
peerDependencies（`^0.85.1`，宿主内自带；devDependencies 精确锁定 `0.85.1`
供类型检查与 fixture 测试）。
