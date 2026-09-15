# M1 设计决策记录（DECISIONS）

本文档解决 DESIGN.md v0.1 草案在 M1 实现前暴露的矛盾与未决项。每条决策标注：**矛盾/问题 → 决策 → 理由与设计目标的保留**。设计目标（fail-open、纯 core、透明注入、封闭类型集、不猜测）全部保留；本文只做不违背它们的收紧或补齐。

| 项 | 值 |
|---|---|
| 文档版本 | 1.9（M5c-2：新增 D26 适配器惯例蒸馏接线——三宿主事件/执行面核实与选择） |
| 关联 | [DESIGN.md](../DESIGN.md)、[SUPERVISION.md](SUPERVISION.md)、[CONVENTIONS.md](CONVENTIONS.md) |

---

## D1. `DataType` 缺失 `project` 类型

**矛盾**：DESIGN §4.2 首批数据源表中 `cwd-context` 的服务类型为 `project`，但 §6 `DataType` 封闭集里没有 `"project"`。按原文实现则 `cwd-context` 无法声明其类型。

**决策**：在 `DataType` 封闭集中补齐 `"project"`。封闭集纪律不变：今后新增类型仍需评审；本次仅补齐设计内部已经隐含引用的类型。

**理由**：这是草案遗漏而非新需求；`cwd-context` 是 M1 验收必需数据源。

## D2. `HostEnv` 的传参时机与惰性化

**矛盾**：DESIGN §6 中 `createEngine(options)` 不接收 env，`enrich(prompt)` 也不接收 env，但 `DataSource.resolve(ref, env)` 需要 env；§7.1 又要求适配器"会话开始时 + 每次调用前增量更新"快照。env 到底从哪进、何时构建，未定义。另外 §6 把 `recentSessions` 定义为**内联数据数组**，意味着即使话语无任何指代（no-op 路径）也必须先取好数据，违反"无指代零开销透传"（§8.1）与监督红线"无指代不得读取数据源"。

**决策**：

1. env 按**每次调用**传入：`engine.enrich(prompt: string, env: HostEnv)`。适配器每次在插入点构建（便宜字段内联，昂贵字段惰性），cwd 时效性由每次传入保证。
2. `HostEnv` 的数据字段全部改为**惰性 provider**（可选函数），未命中指代类型则对应 provider 永不被调用：
   - `activeEditor?: ActiveEditorState | null`（快照数据，本身廉价）
   - `listRecentSessions?(req) => Promise<SessionSummary[] | null>`
   - `readSessionContent?(sessionId, req) => Promise<SessionContent | null>`
   - `readCwdContext?(req) => Promise<CwdSnapshot | null>`（新增，`cwd-context` 源需要）
3. `req: ReadRequest = { signal: AbortSignal; maxBytes: number }`：读取必须带取消信号与字节上限（监督红线："为异步端口传取消信号"、"有上下文/附件大小界限"）。provider 返回 `null` 表示不可用/超限/编码非法，core 一律按 not-found 处理，绝不注入半可信数据。
4. `DataSource.resolve(ref, env, ctx)` 增加第三参 `ResolveContext { signal, remainingMs(), boundSessionId?, maxBytes }`（DESIGN §6 本就注明 HostEnv"按 M2/M3 需要扩展"）。

**设计目标保留**：HostEnv 仍是 core 与宿主之间唯一耦合面；core 仍零宿主依赖（env 是数据 + 函数，无宿主类型）。

## D3. 总超时保留已完成项 + 迟到回调无新副作用

**矛盾**：DESIGN §5.3/§8.1 要求"总超时（默认 3s）放弃未完成项，用已完成部分注入"，但未定义：超时后已发起的异步回调是否还能写授权（grants）、迟到结果是否还可能进入注入；监督红线明确"迟到回调不得写 grants 或注入"。

**决策**：

1. **机器预算与用户交互分离的双时钟**：`timeoutMs`（默认 3000）只计机器工作时间；`interactTimeoutMs`（默认 30000）约束单次用户交互。等待用户点击期间机器时钟**暂停**（理由：交互本来就是用户在场时阻塞 prompt 的设计意图，把用户思考时间计入 3s 机器预算会使消歧选择器永远不可用）。
2. 超时语义（`DeadlineClock`）：
   - 预算耗尽 → 引擎**不再发起**任何新的数据源调用或交互（循环入口检查 `expired()`）；
   - 已完成的 resolved 项**保留**并进入注入；
   - 未完成项丢弃（`dropReasons: "budget-exhausted"`），在 `droppedRefs` 中对用户透明。
3. 迟到副作用防护：
   - 授权写入（L1 confirm 后写 grants）在写之前检查引擎 AbortSignal，已中止则**不写**；
   - 数据源 promise 被预算 race 击败后，其 resolve 值直接丢弃（引擎不再 await 它，且附加空 catch 防未处理 rejection）；
   - `enrich()` 返回前统一 `abort()` 引擎信号，关闭一切仍在等待的交互对话框。
4. 所有异步端口（HostEnv providers、InteractPort）都接收该 AbortSignal。

## D4. 历史事件 → 历史内容关联（绑定）

**矛盾**：DESIGN §3.3 的示例要求"一样的错误处理"（history-content）解析出"那次修改的 diff"，但 diff 必须来自"上次"（history-event）选中的会话；设计未定义两者如何关联，也未定义"上次"消歧失败时 content 该怎么办。监督红线："历史内容必须绑定所选会话"、"多个候选未消歧时不注入确定结论"。

**决策**：

1. **两波解析**：wave 1 解析所有非 `history-content` 指代；wave 2 再解析 `history-content` 指代。绑定值 = wave 1 中最后一个 resolved 的 `history-event` 值的 `sessionId`（含用户在候选选择器中明确选择的会话）。两波顺序使绑定不受指代在句中出现的先后影响。
2. **无绑定不调用、不注入**：wave 2 开始时若不存在绑定，`history-content` 指代直接丢弃（`dropReasons: "no-binding"`），`session-content` 数据源**不会被调用**（`session-content` 源内部对缺绑定同样防御性返回 not-found，双保险）。
3. 绑定未消歧（用户取消选择 / 交互不可用）→ 绑定不存在 → 同样走 2。
4. M1 不做"哪一段内容匹配'一样的错误处理'"的语义匹配（不引入 LLM 摘要，保持离线确定性）：注入的是绑定会话的**修改记录（edit/write 的 old/new 文本 diff）**，有界截断，交大模型自行取用。见 D9。

## D5. 交互超时与取消

**矛盾**：DESIGN §6 的 `InteractPort` 方法无超时/取消参数；§8.2 的降级矩阵要求 unsupported 时降级而非报错；监督要求"为异步端口传取消信号"、获取动作"触发前必须有一次轻量确认"。

**决策**：

1. `InteractPort` 三个方法统一增加 `opts?: { signal?: AbortSignal; timeoutMs?: number }`。
2. 引擎内部用包装器为每次交互施加：`interactTimeoutMs` 超时 + 引擎信号透传（pi 的 `ctx.ui.*` 原生支持 `{ signal, timeout }`，直接映射）。
3. 超时/取消的语义取**安全侧**：`confirm` 超时 → `"no"`（不授权、不读取）；`select` 超时/取消 → `null`（放弃消歧，不注入候选结论）；`acquire` → `null`。
4. 获取动作纪律（§4.4 安全红线）：`need-acquisition` → 先 `confirm`（轻量确认）→ yes 才 `acquire`；no/unsupported/超时 → 放弃（`dropReasons: "acquisition-declined"` / `"interaction-unsupported"`）。
5. ambiguous 且 select 不可用（unsupported）：M1 默认**丢弃**该指代（`onAmbiguousNoSelect: "drop"`）；预留 `"list"` 模式（把候选作为"候选清单"注入，注明未消歧）给 M4 无 UI 宿主（DESIGN §7.3 Claude Code 的预期降级）。两种模式都**不注入任何确定结论**。

## D6. `active-editor` 在 pi 下的取值（开放问题 12.2.1）

**矛盾**：DESIGN 开放问题 12.2.1 提出 pi 无编辑器概念时用"最近 read/edit 的文件"近似；但监督红线是"无当前编辑器不能猜文件"、"不猜测当前文件"。"最近编辑过的文件"是**有证据但非当前**的状态，注入它伪装成"当前文件"违反透明性与不猜测原则。

**决策**：

1. core 红线不变：`env.activeEditor` 缺省（`undefined`/`null`）时 `active-editor` 源返回 not-found，**绝不**回退到目录扫描或其他源冒充。
2. M1 的 pi 适配器**不提供** `activeEditor`（pi 无编辑器概念，不近似）。"这个函数/这个文件"类指代在 pi 下诚实 dropped（透明性：`droppedRefs` 可见），交大模型按现状反问。
3. "最近 read/edit 文件"若 M2 引入，必须以**显式候选选择器**形式呈现（用户一次点击确认），不得自动当作当前文件。12.2.1 就此关闭。

## D7. 授权清单的 M1 范围

**决策**：M1 交付 `GrantStore` 接口 + `InMemoryGrantStore` + 完整的门禁语义（L0 直通 / L1 查授权→确认→落盘 / L2 每次确认永不落盘 / L3 走获取动作流程），并以测试锁定"拒绝即不读取"、"L2 不持久化"、"迟到不写 grants"。`~/.subconscious/grants.json` 文件持久化、scope 细粒度（12.2.3）按监督计划归 M2。M1 交付的四个数据源全部 L0，不触发授权路径（设计 §5.3"默认只有 L0 参与"）。

## D8. 注入格式、界限与透明性扩展

**决策**：

1. 注入头 `[潜意识引擎·已解析]` 固定；每行 `- "{指代原文}" → {解析展示}（来源：{sourceId}）`，来源标注满足 §12.1"注入物带来源标注"。
2. 界限：`maxContextChars`（默认 4000）总注入上限，超限截断并显式标注 `[已截断…]`；`maxSourceBytes`（默认 64000）单次数据源读取上限；diff 条数/单条长度、目录条目数在源内另行有界。
3. `EnrichOutput` 扩展 `dropReasons?: Record<refId, DropReason>`（DESIGN 形状的兼容扩展）：`droppedRefs` 仍是 id 数组（保持原 API），原因映射供 UI/审计展示透明性。
4. 附件走 `attachments` 通道（`ImageLike { mediaType, base64 }`），组装器**不可能**把 base64 写进 `context` 文本（结构上分离，测试锁定）。

## D9. `session-content` 的提取方式

**决策**：从绑定会话中提取 `edit` / `write` 工具调用的参数（`oldText`/`newText`/`content`，兼容旧参数形状）构造 diff 摘要，按时间序有界输出；跳过 `isError` 的工具结果；不做语义筛选、不做 LLM 摘要（离线确定性、可测试）。12.2.5（recentSessions 摘要如何生成）随之关闭：M1 用 `name ?? firstMessage 截断`作标题，不调用 LLM。

## D10. `ResolvedValue` 强类型化

**决策**：DESIGN §6 的 `ResolvedValue { type; value: unknown }` 收紧为判别联合（`{ type: "file"; path; line?; snippet? } | { type: "history-event"; sessionId; ... } | …`），禁 `unknown`/`any` 载荷。候选选择后的值构造按 `expectedType` 显式分派，未覆盖类型直接丢弃（不猜）。接口形状变化不改变四态解析语义。

## D11. pi 适配器与引擎实例的生命周期

**决策**：pi 的 `before_agent_start` 每次事件重建 `createEngine({...})`（每次传入该事件的 `ctx.ui` 派生的 InteractPort）。引擎构造零状态（M1 无持久授权），重建无成本；避免跨事件缓存 `ctx`（pi 会话切换后旧 ctx 失效，见官方文档 Session replacement footguns）。M2 引入持久 grants 后改为模块级 store + 每次注入。

## 附：pi 官方 API 核实记录（不虚构接口的依据）

以下接口**全部**经两处核实：官方仓库文档（main 分支，读取于 2026-09-13）与 npm 安装包类型声明（`node_modules/@earendil-works/pi-coding-agent/dist/*.d.ts`，npm 最新版 **0.85.1**，2026-09-05 发布）。

| 用途 | 核实的接口 | 文档来源 |
|---|---|---|
| 插入点 | `pi.on("before_agent_start", handler)`；`BeforeAgentStartEvent { prompt: string; images?: ImageContent[]; ... }` | `docs/extensions.md` §before_agent_start；`dist/core/extensions/types.d.ts:538` |
| 注入 | 返回 `BeforeAgentStartEventResult { message?: Pick<CustomMessage, "customType" \| "content" \| "display" \| "details">; systemPrompt? }`；`CustomMessage.content: string \| (TextContent \| ImageContent)[]` | 同上 `types.d.ts:845`、`dist/core/messages.d.ts:32` |
| 交互 | `ExtensionUIContext.confirm(title, message, opts?): Promise<boolean>`；`select(title, options: string[], opts?): Promise<string \| undefined>`；`input(title, placeholder?, opts?): Promise<string \| undefined>`；`ExtensionUIDialogOptions { signal?: AbortSignal; timeout?: number }`；`ExtensionContext { ui; hasUI; mode; cwd; sessionManager }` | `docs/extensions.md` §Dialogs；`dist/core/extensions/types.d.ts:36,70-74,209` |
| 会话列表 | `SessionManager.list(cwd, sessionDir?): Promise<SessionInfo[]>`；`SessionInfo { path; id; cwd; name?; created; modified; messageCount; firstMessage; allMessagesText }` | `docs/extensions.md` §switchSession 示例；`dist/core/session-manager.d.ts:125,349` |
| 会话内容 | `SessionManager.open(path, sessionDir?, cwdOverride?)`；实例 `getEntries()` / `getSessionName()` / `getHeader()` / `getSessionFile()` / `getSessionDir()`；`SessionMessageEntry.message` 为 `AgentMessage`（`toolCall { id, name, arguments }` 在 assistant content 中，`toolResult { toolCallId, isError }`） | `docs/session-format.md` §SessionManager API、§Message Types |
| 执行 | `pi.exec(command, args, { signal, timeout }): Promise<ExecResult>` | `docs/extensions.md` §pi.exec |

- 文档 URL：`https://github.com/earendil-works/pi-mono` → `packages/coding-agent/docs/extensions.md`、`docs/session-format.md`（raw 读取）。
- npm：`@earendil-works/pi-coding-agent@0.85.1`（`dist-tags.latest`），作为 adapter-pi 的**精确固定**依赖安装，测试直接 `import { SessionManager }` 用真实实现对 fixture 会话跑离线验证（不接触真实 `~/.pi`）。
- 仓库已于 2026-05 迁移至 `earendil-works/pi`（DESIGN §13 的 `earendil-works/pi-mono` 链接仍有效重定向，npm scope `@earendil-works/*`）。

## D12. M1 实现层细化（本轮落地时补充，不改变 D1–D11 的任何结论）

以下为实现过程中暴露的接口级细化，全部是 DESIGN 形状的保守扩展或收紧：

1. **`Candidate` 携带值**：`{ id, label, value: ResolvedValue }`（DESIGN §6 原为 `{id, label}`）。理由：候选本就来自已读取的列表数据（如会话摘要），选中即取值，避免"选中后二次读取"引入新的读取窗口；label 仅用于 UI 展示，稳定 id 在 value 内。重复标签由引擎 `uniquifyLabels` 加序号去重后仍按索引映射回候选（D4 稳定 id 纪律）。
2. **`EngineOptions.grants` / `interact` 可选**：缺省为 `InMemoryGrantStore` 与全 `unsupported` 的 `UNSUPPORTED_INTERACT`。理由：M1 四源全 L0、宿主可无 UI（DESIGN §8.2 降级矩阵是常态而非异常）；强制传参会诱导适配器伪造端口。
3. **`Timer` 注入**：`createSystemTimer()`（默认，`Date.now`/`setTimeout`）与 `ManualTimer`（测试手动推进）。取消/计时类型来源显式化：`@types/node` 为 core 的 devDependency（tsconfig `types: ["node"]`），不靠 pi 传递依赖偶然供给（回应监督复核点）；core 运行时零 node API 导入（源码 import 全部为相对路径，已 grep 锁定）。
4. **`ResolveContext.limits`**：数据源直接读取合并后的 `EngineLimits`（diff 条数/片段/列表上限的唯一事实源），`HostEnv` provider 读取请求携带 `maxBytes`（D2.3）。
5. **引擎统一重编 ref id 并校验 span**：自定义检测器输出的 id 缺失/重复、span 与原文切片不一致、类型不在封闭集、置信度非有限数 → 该条丢弃并记日志。检测器是不可信输入，与数据源同等受控。
6. **检测模板补 `project` 入口**："这个项目/当前项目/本仓库/this project/the current project"。缺此入口则 `cwd-context` 不可达（悬空数据源）。
7. **`readSessionContent(session: SessionRef, req)`** 收 `{id, path?, title?}` 而非裸 sessionId：绑定值携带 wave 1 会话摘要里的真实文件路径，适配器按该 path 定位会话文件，不凭任意 ID 拼路径（回应监督 review-01 对 SessionInfo.path 的核实）。
8. **四态与载荷的运行时形状校验**：数据源/交互端口可能来自 JS，非法 status/载荷/candidate/acquisition spec 一律按 `not-found`（或 `error`）受控丢弃，记日志，绝不注入半可信数据。
9. **wave 2 根因标注**：预算耗尽与无绑定同时成立时（wave 1 因超时无法建立绑定），`history-content` 标注 `budget-exhausted`（根因优先）。
10. **排序纪律**：`recent-sessions` 按会话时间降序、无效时间确定性排最后（原始顺序稳定）；`session-content` 的修改记录按时间升序、无效时间排最后。均为稳定排序，同序输入同序输出。
11. **根构建配置**：根 `tsconfig.json` references 与 `build/typecheck/check` 脚本暂时只指向 core（adapter-pi / demo 尚无源码，属后续轮次）；adapter/demo 交付时恢复引用。这不是删除目标，是让根命令在当前阶段可运行、可验收。

## D13. 同类型多源的注册顺序尝试与继续/停止策略

**问题**：`DataSourceRegistry.findByType` 一直支持同类型多源，但引擎只取 `sources[0]`，首个源 not-found/抛错即整条指代丢弃——与"单源故障不损失其他源"的 fail-open 目标矛盾（监督整改 3）。

**决策**：按**注册顺序**逐个尝试同类型源，每个源在调用前**单独过权限检查**，结局按下表处理：

| 单源结局 | 链行为 | 理由 |
|---|---|---|
| `resolved` | 短路返回，后源不再调用 | 已有可信结果 |
| `not-found` | 继续后源 | 无结果≠故障，fail-open |
| 非法四态/载荷/值类型 | 按 not-found 受控丢弃后继续后源 | 源不可信，但不连坐其他源 |
| resolve 抛错 | 记日志后继续后源 | 单源故障不损失同类型其他可用源 |
| 权限交互 unsupported | 继续后源 | **环境限制而非用户拒绝**：后源可能是 L0 或已授权 L1，继续不构成权限提升（每个源仍单独过闸） |
| 权限拒绝（用户明确 no） | **立即停止** | 用户决定优先于 fail-open；就同一条指代立即再询问下一个源构成对拒绝的绕过（最小权限精神） |
| 用户取消选择 / 拒绝获取 | **立即停止** | 同上，用户明确决定 |
| budget-exhausted | **立即停止** | 预算红线（D3.2），任何后续源/交互都不得发起 |

链耗尽时的丢弃原因取**最后一个尝试源**的结局（not-found/error/interaction-unsupported，确定性排序）。

**设计目标保留**：fail-open 只覆盖"故障与环境限制"，不覆盖用户的明确拒绝；每个源的最小权限门禁不因多源而摊薄。

## D14. 解析值的类型一致性（expectedType 对齐）

**问题**：四态形状校验只验证载荷字段齐全，不验证 `value.type` 与当前 `ref.expectedType` 一致——file 指代可被注入 person 等异类型值（监督整改 4）。

**决策**：`resolved` 值、`ambiguous` 每个候选值、`need-acquisition` 的 `spec.expectedType`、`acquire` 端口取回的值，四处的 `type` 必须等于 `ref.expectedType`；任一不一致按非法解析受控丢弃（`not-found`；acquire 取回值不一致按 `error`），记日志，绝不注入。D10 的判别联合因此获得了"判别符对齐指代"的完整语义。

## D15. 构造期配置校验（permission 四值 + limits 有限正数）

**问题**：registry 不校验 `permission` 的实际取值；`EngineLimits` 不做任何校验——负 timeout、NaN 置信度会在运行期绕过超时与置信度纪律（监督整改 5）。

**决策**：`register` 时校验 `permission` 必须是封闭集四值之一（`L0-free` / `L1-grant-once` / `L2-confirm-each` / `L3-acquire`），非法/缺省抛 `EngineConfigError("invalid-permission")`；`createEngine` 对合并后的 limits 校验：除 `minConfidence`（有限数 0..1，含边界）外全部为**正整数**（含 timeoutMs/interactTimeoutMs/maxSourceBytes/各条数与字符上限），非法抛 `EngineConfigError("invalid-limits")`。构造期受控失败与 enrich 永不抛出的分工不变（D12.8 同源原则）。

## D16. 交互子信号与监听器生命周期

**问题**（监督 review-01 13:19 记录）：`guardInteract` 的超时 race 只 settle 安全值，不中止传给宿主的信号——忽略 AbortSignal 的端口在引擎 abort 后仍可阻塞至 30s；`withDeadline` 在源先完成时不摘除 abort 监听器，长会话多次 enrich 会累积监听器。

**决策**：

1. **每次交互一个子 AbortController**：端口只收子信号（父引擎信号不直传）。单次交互超时、父信号中止、端口抛错三种情形都立即 settle 安全侧并 `abort()` 子信号（宿主 UI 收到 aborted 即关闭对话框）；端口永不结束或忽略取消时依然有界。每次调用结束清理 timer 与父信号监听器。
2. **`withDeadline` 监听器对称清理**：源 promise 先成功/先失败时 `removeEventListener`；截止获胜时监听器经 `{ once: true }` 自然摘除。迟到 rejection 防外溢语义（D3.3）不变。

## 附：M1 明确不做（防监督误解为遗漏）

- pi 交互式端到端（真人跑 pi）——离线演示 + 真实 SessionManager fixture 测试替代，报告区分 mock 与真实（监督要求）。
- `InteractPort.acquire` 的 pi 实现（系统文件/相机对话框）→ M2（监督 M2 明确列出）；M1 pi 的 acquire 返回 `unsupported`，core 流程有测试。
- clipboard(L1) 源、grants.json 持久化 → M2。embedding 检测器 → M3。

## D17. M2 授权 scope 与剪贴板边界

**决策**：`GrantStore` 的持久化实现按 `sourceId + scope` 精确匹配。剪贴板是进程外的单一资源，固定使用 `clipboard:global` scope；不会用目录、cwd 或任意路径扩大授权含义。持久化文件由调用方显式传入路径，默认适配器不读取用户剪贴板；实际读取必须通过可注入的 clipboard provider，并在 L1 gate 已允许后才调用。文件格式为版本化 JSON，写入使用同目录临时文件与原子 rename，损坏、权限或并发错误均 fail-open 为“未授权”。

## D18. macOS 图片选择 fallback

**决策**：pi 缺少图片 picker 时，M2 可由 adapter 在 `pick-image` acquisition 的既有确认门禁之后调用 macOS 系统选择框。选择器只允许图片类型；取消、非 macOS、超时、无 UI 或验证失败一律返回 `null`/`unsupported`。选择到的路径必须以受限字节读取，MIME 白名单验证后才生成附件；不得扫描目录、不得在无明确图片指代时调用系统选择器。
- **图片链路不声称完整**：M1 只交付附件的 MIME 校验（仅 `image/*`）、非空 base64、context/附件通道结构分离。**附件解码后字节数上限与总附件大小上限留作 M2**（监督 review-01-pending 2026-09-13 13:19 记录：在声称图片链路完整前必须加入解码后字节数/总附件上限，不能只限制文本 context）；宿主消息协议 fixture、"已有附件不丢" 属 M2 pi 集成验收（见 ACCEPTANCE「图片」行）。

### 里程碑表述勘误（v1.2，监督整改 7）

早期版本此处曾写"embedding 检测器、并行解析 → M3"。**勘误**：独立指代的并行解析已在 M1 交付（`parallel.test.ts` 的 barrier 测试锁定：独立指代并发解析、history-content 等待所属事件绑定、并发 enrich 不串数据）。M3 的范围只是**完善/优化**并行调度或引入 embedding 检索，不得把已交付能力后移到 M3。

DESIGN.md §10 里程碑表（M3 含"多指代并行解析"）与 SUPERVISION.md 任务顺序（M3 含"并行解析与依赖顺序"）按监督约束保留原文不改；以本勘误为准：该项属**提前交付**而非删除目标——M3 对应工作收窄为"并行调度的完善/优化与依赖顺序硬化"，embedding 检测器目标不变。

## D19. M3 embedding 检测器：接口形态、依赖形态与评估协议

**问题**：DESIGN §4.1 要求 embedding 版检测器"仍输出同一接口"，但向量推理只能异步，而 `Detector.detect` 是同步契约；监督红线要求 core 零依赖、测试离线、缺模型回退规则且不阻塞 check；`scripts/check-deps.mjs` 要求新依赖显式 semver 且不得让未安装者构建失败。

**决策**：

1. **检测器接口：同步契约不动，异步能力可选叠加**。新增 `AsyncDetector extends Detector`（`detectAsync(prompt, ctx?)`）与 `DetectorContext { signal, remainingMs() }`；`EmbeddingDetector` 同时实现两者——同步 `detect()` 恒等于其规则回退输出（同步无法等待推理，fail-open 直落规则），永不抛出。`Detector`/`RuleDetector` 行为零改动。
2. **引擎：异步检测在机器预算内运行**。`isAsyncDetector` 结构探测命中时，检测与解析共享同一 `DeadlineClock`（D3 单预算，检测耗时不给解析翻新预算）；detectAsync 抛错/悬挂/超时 → 回退其同步 `detect()`（withDeadline 兜底 + 层层 fail-open），且 enrich 返回前统一 dispose。纯同步检测器路径与 M1 逐字节一致（时钟仍在检测后才建）。
3. **原型来源：示例集经同一 provider 就地嵌入**（而非 m3-01 设想的静态版本化向量文件）。版本化产物是**示例集**（`EMBEDDING_EXAMPLES_VERSION`）；原型 = 各类示例向量归一化均值。模型无关、维度自洽；换模型无需重新生成向量文件，维度不匹配只剩"provider 中途变性"一种受控回退路径。
4. **分类与合并**：候选短语 = CJK 滑窗(2–6) ∪ 拉丁词 n-gram(1–4，token 边界纪律：`lastIndexOf`/`this-file.txt` 不切词)，超上限等步长抽样（确定性）；判定 = 余弦最近类型原型，且对 negative 原型/次类领先 ≥ margin 才接受；置信度 = `0.5 + 0.5×(sim−accept)/(1−accept)`（单调、可复现）。embedding 命中内部按 置信度↓→短→先 消重叠；与规则结果重叠时**规则优先**（模板精度高），非重叠合并、统一重编 id。
5. **失败语义**：provider 缺失/抛错/非有限/维度不匹配 → 本次规则回退；连续失败达 `maxProviderFailures`（默认 3）→ 该实例永久回退（记日志）。预算低于 `budgetReserveMs`（默认 300ms）或 signal 中止 → 停止 embed、本次规则回退（不算 provider 失败，下次可续）；embed 与 abort 的 race 保证不悬挂且迟到 rejection 不外溢（D16 同源纪律）。原型构建单飞：并发共享一次尝试，成功缓存、失败/中止后下次重试。
6. **依赖形态：独立可选子包 `@subconscious/embedding-local`**。core 保持零依赖（R4 0 项）；transformers.js（`@huggingface/transformers`）为该包**可选 peer**（`^3.8.1` + `peerDependenciesMeta.optional`）：npm 默认不安装、lockfile 不受影响、普通 `npm install` 不拉 onnxruntime。包内动态 import + 运行时结构收窄（无静态 import），未安装时类型检查与测试照常通过（模型相关用例 skip，回退路径用例仍跑）。check-deps 增补 R5 锁定该形态与 core 依赖方向。真实模型（Xenova/paraphrase-multilingual-MiniLM-L12-v2 q8，本地 ONNX，`allowRemoteModels=false`）只读本地文件，唯一联网入口是一次性 `npm run fetch:embedding-model`。
7. **评估协议**：held-out 集 `EMBEDDING_EVAL_SET`（34 例：22 正 + 12 负，中英文、Unicode、监督 holdout 用例含 m3SeparateFromM1）与训练示例的泄漏关系**程序化锁定**（期望指代与训练示例无相等/包含；词级共享是允许的泛化；负例不含正例期望指代）。每条期望标注 `origin: rule|embedding` 且与 RuleDetector 真实行为对照锁定。判定指标唯一事实源 = `evaluateRefDetection`（TP=span 重叠且类型一致；负例预测即 FP）。两个可复现入口：`npm run eval:embedding:fixture`（离线确定性，回归下限 0.85）与 `npm run eval:embedding`（真实模型；缺依赖/模型打印 SKIP 退出 0，不伪造）。
8. **实测基线**（2026-09-14，默认阈值 accept .65 / margin .1，经真实模型扫描调定；margin>0.1 在该模型上召回大幅受损）：真实模型 P 96.4% / R 90.0% / F1 93.1% / 句子准确率 88.2%；规则基线同集 P 100% / R 50%；规则外子集 recall：合并 80% vs 规则 0%。已知 FP：裸 "that"（"I like that idea"）被判 code-symbol——保留为已知边界并写入报告，不以牺牲 7 个 TP 的 margin 换取单个 FP 消除。（2026-09-15 更新：该 FP 已由 D23 的 isTypeInfoFree 防线结构性消除，见 D23.7 新基线。）

**设计目标保留**：fail-open（任何 embedding 故障 = 规则行为，绝不阻塞 prompt）；core 零宿主零依赖；span/置信度真实一致（引擎 isValidRef 双保险）；测试离线可跑；监督"评估集不只训练例"以程序化检查而非口头承诺落实。

## D20. M4a Claude Code 适配器：协议事实、L0-only 与降级注入

**问题**：Claude Code 的插入点是 `UserPromptSubmit` hook——子进程 stdin/stdout JSON 协议，没有对话式 UI；协议字段、输出形态与阻塞语义必须以官方文档为准核实，交互能力按 DESIGN §7.3/§8.2 降级，且任何故障都不得阻塞用户 prompt。

**协议核实**（官方 hooks reference，https://docs.claude.com/en/docs/claude-code/hooks ，2026-09-14 读取）：hook 经 stdin 收 JSON（`session_id`/`transcript_path`/`cwd`/`permission_mode`/`hook_event_name`/`prompt`）；`UserPromptSubmit` 的 stdout 以 JSON 输出时用 `hookSpecificOutput.hookEventName:"UserPromptSubmit"` + `additionalContext` 追加上下文；`decision:"block"`（输出）与退出码 2 都会阻断并抹除用户 prompt；退出码 0 的 stdout 在 `UserPromptSubmit` 下会被并入上下文（因此日志只能走 stderr）；hook 单命令默认 60s 上限、`timeout` 配置单位为秒；`UserPromptSubmit` 配置不使用 matcher。

**决策**：

1. **数据源只登记 L0**（`CLAUDE_L0_SOURCES` = cwd-context/active-editor/recent-sessions/session-content）。L1 clipboard、L3 image-acquisition 不注册：无确认通道时授权门无法完成，结构性排除比「注册后必然 permission-unsupported」更诚实也更安全（DESIGN §7.3「只服务 L0 数据源 + resolved 态」）。
2. **降级注入用录制型 unsupported InteractPort**：confirm/select/acquire 一律返回 `"unsupported"`（core 走降级丢弃），但在返回前把引擎试图发起的交互原样录制；适配层把记录转写为 `[潜意识引擎·待确认]` 注入块——select → 候选列表（请模型向用户确认），acquire/confirm → 「需要补充数据/需要用户确认」提示。已解析块（core `[潜意识引擎·已解析]`）在前、待确认块在后，同受 `maxContextChars` 界限。待确认块不冒充解析结论（监督红线：多候选未消歧不注入确定结论）。
3. **recent-sessions 只用官方字段可核实的部分**：`transcript_path` 指向 `~/.claude/projects/<项目>/<会话>.jsonl`，同目录兄弟 `*.jsonl` 即本项目历史会话；排除当前 `session_id` 对应文件，mtime 降序，元数据只取文件名（稳定 id、标题派生）与 mtime（at）。**transcript JSONL 内部结构无官方文档 → `readSessionContent` 不提供**，历史内容指代诚实 not-found；`~/.claude` 私人会话不得用于开发验证（监督红线）。
4. **activeEditor/附件诚实缺失**：hooks 协议无编辑器状态（不猜「最近编辑的文件」）；`UserPromptSubmit` 的 `additionalContext` 是纯文本通道，附件出现即丢弃并记 warn，不把 base64 塞文本（D8.4 同源）。
5. **入口纪律**：cwd 只取 hook 输入的 `cwd` 字段（缺失即 no-op，不回退 process.cwd()）；总超时默认 5000ms（引擎机器预算 3000ms + 余量），`SUBCONSCIOUS_HOOK_TIMEOUT_MS` 可覆盖（正整数、上限 30000，低于宿主 60s）；stdout 只写单行 hook JSON，日志（JSON 行）仅 stderr；退出码恒 0，`uncaughtException`/`unhandledRejection` 兜底后仍退出 0。
6. **验证形态**：协议测试用真实子进程 spawn `node dist/hook-main.js` 经 stdin/stdout 验证（注入、no-op、非法输入、非本事件、缺 cwd、stdin 悬挂超时、stdout 单行纯净），不用进程内 mock 冒充；check-deps 增补 R6 锁定依赖方向（dependencies 恰为 `@subconscious/core`、无 peerDependencies 面、bin 交付存在）。

## D21. M4b OpenCode 适配器：插入点、会话数据面与类型锁定形态

**问题**：DESIGN §7.4 对 OpenCode 只定了「plugin API 事件总线」与「交互介于 pi 与 Claude Code 之间」，插入点、消息改写方式、会话数据来源、类型依赖形态均须以官方资料核实；监督红线「实际宿主 SDK/协议按官方文档核实」「mock 通过不等于真人宿主端到端通过」。

**协议核实**（官方文档 https://opencode.ai/docs/plugins 2026-09-14 读取 + 锁定版本类型声明 `@opencode-ai/plugin@1.18.30` / `@opencode-ai/sdk@1.18.30`（plugin 的直接依赖）dist/*.d.ts）：

1. 插件形态：模块导出 `Plugin = (input: PluginInput, options?) => Promise<Hooks>`，`PluginInput { client（SDK 客户端）; project; directory; worktree; serverUrl; $ }`；npm 包经 `opencode.json` 的 `"plugin": [...]`、本地文件经 `.opencode/plugins/` / `~/.config/opencode/plugins/` 加载，hooks 顺序执行（文档「Create a plugin」「Load order」节）。
2. 插入点 = `Hooks["chat.message"]`：`(input { sessionID, agent?, model?, messageID?, variant? }, output { message: UserMessage; parts: Part[] }) => Promise<void>`（类型声明注释 "Called when a new message is received"）。**官方文档事件列表未单独列出该 hook，以锁定版本类型声明为准**（报告与 README 均注明该差异；等价备选 `experimental.chat.messages.transform` 会触及历史消息，纪律禁用）。
3. 消息改写：output 按引用传入、宿主 await 后持久化同一对象——突变 `parts` 即改写当前用户消息。`UserMessage` 本体无文本字段；`TextPart { type: "text"; text: string; synthetic?; ignored?; … }`，用户话语在非合成 text part。
4. 会话数据面：`client.session.list({ query?: { directory? } }) → data: Array<Session>`、`session.get({ path: { id } }) → data: Session`（`{ id; directory; title; time: { created; updated } }`）、`session.diff({ path: { id } }) → data: Array<FileDiff>`（`{ file; before; after; additions; deletions }`）；heyapi `RequestResult` 非 200 时 `data` 缺失。
5. 交互能力：插件无可调用的 confirm / select / input / 文件选取对话框（TUI 客户端有 toast 与内置对话框，非插件对话通道；`permission.ask` 只服务工具授权）→ **降级矩阵同 Claude Code**（D20.2 复用：录制型 unsupported InteractPort + `[潜意识引擎·待确认]` 注入块）。

**决策**：

1. **只改当前用户消息**：注入 append-only 追加到 `output.parts` 第一个非合成 text part 尾部（原文逐字节前缀保持）；不 push 新 part（自造 id/sessionID 的 part 不在官方契约内）、不动其他 part 与历史消息。
2. **数据源只登记 L0**（同 D20.1：无确认通道，L1 clipboard / L3 image-acquisition 结构性排除）。
3. **HostEnv**：cwd 只取 `PluginInput.directory`（官方字段，缺失 no-op，不回退 process.cwd()）；`activeEditor`/`readClipboardText` 结构性缺失；recent-sessions = `session.list`（query.directory 过滤本项目、排除当前 sessionID、time.updated 降序、无效时间排后、标题/条数截断）；session-content = `session.get`+`session.diff`（FileDiff → edit 语义 SessionChange，at 取会话 time.updated，缺失 → 空串不猜）；cwd-context 同 adapter-claude 纪律（有界 readdir + 可注入 git exec）。**会话数据全走官方 SDK 客户端，不直读 `~/.local/share/opencode` 存储**——官方 API 的字段与语义可核实，直读内部存储结构不可核实（对齐 D20.3 的「只用官方字段可核实部分」精神，且此处无需降级：session.diff 即历史修改记录）。
4. **依赖形态**：运行时仅 `@subconscious/core`；`@opencode-ai/plugin` 为 **optional peer（`^1.18.30`）+ devDependencies 精确锁定 `1.18.30`**，代码仅 type-only import，编译产物零宿主引用（typecheck 即协议形状证据；宿主内该包必有，普通消费者可不装）。check-deps 增补 **R7** 锁定：dependencies 恰 core / peer 显式且 optional / dev 精确且满足 peer / `exports["./plugin"]` 指向 dist。
5. **超时与 fail-open**：`chat.message` 是进程内 await——引擎机器预算 3s（D3）+ 适配器总超时 race 5s（`SUBCONSCIOUS_OPENCODE_TIMEOUT_MS` 可覆盖，上限 30000，同 D20.5 语义），任何异常/超时表现为「没生效」；日志走 stderr JSON 行。
6. **验证形态**：离线测试用 heyapi 形状假客户端（list/get/diff 记录调用与参数）驱动真实 core 引擎全链路（注入 / no-op / 待确认降级 / fail-open / 总超时 / cwd 缺失 / 无 text 通道），`SubconsciousPlugin` 经官方 `Plugin` 类型检查即接线证据；**无真实 OpenCode 宿主 E2E**（监督约束禁改全局宿主配置），报告区分 mock 与真实宿主。

## D22. 硬化轮：适配器 embedding opt-in 接线、入口副作用修复与独立消费者 smoke

**问题**：M3 交付了 embedding 检测器但未接线到任何适配器（M3 验收遗留项）；接线必须满足：默认行为逐字节不变、可选依赖缺失不崩、测试离线（fixture 注入而非真实模型）、core 零依赖与适配器依赖方向（R6/R7「dependencies 恰 core」）不被破坏。同时监督要求把 tarball 独立消费者 smoke 从 M1 的一次性手工验证固化为可重跑脚本，并覆盖新包。

**决策**：

1. **opt-in 语义与依赖形态**：环境变量 `SUBCONSCIOUS_EMBEDDING`（仅 `1`/`true` 生效，其余任何值含未设置为关）。三个适配器各自内置 `src/embedding-optin.ts`：opt-in 时动态 `import("@subconscious/embedding-local")`（specifier 显式注解为 `string` 阻止 TS 解析，同 D19.6 的 TRANSFORMERS_MODULE 手法）+ 运行时结构收窄（`createLocalEmbeddingDetector` 形状），调用其 `createLocalEmbeddingDetector({modelDir?, logger?})` 包规则检测器。**适配器清单不出现该包**（check-deps 新增 R8 锁定 dependencies/peerDependencies 均不得含它）——三份实现刻意不抽公共包（任何共享都会引入新的包依赖面，违反 R6/R7）。
2. **失败语义（fail-open 两层）**：模块不可用（未安装/形状不符/构造抛错）→ 适配器层记 **stderr 单行 JSON warn**（`embedding-optin-unavailable`）后返回 undefined（引擎不传 detector，core 默认规则检测器，行为与接线前逐字节一致）；模块可用但模型/依赖缺失 → embedding-local 层回退（D19.5 已有），同步/异步路径均为规则输出。冷加载（import + ONNX 加载）超过 `EMBEDDING_LOAD_TIMEOUT_MS`（2000ms）→ 本次规则回退（`embedding-load-timeout`），后台加载继续。
3. **memoize 单例与生命周期**：resolver 按 modelDir 分键 memoize「永不 reject 的加载 promise」；模块级单例使长寿命进程（pi 扩展、OpenCode 插件）内模型至多加载一次。引擎实例仍按事件重建（D11 不变——detector 是模型权重，不是宿主绑定状态）。一次性进程（Claude hook）每次冷加载计入总超时预算，README 建议调高 `SUBCONSCIOUS_HOOK_TIMEOUT_MS`。
4. **`SUBCONSCIOUS_EMBEDDING_MODEL_DIR` 透传**：embedding-local 的 npm tarball 不含模型文件（`files: ["dist"]`），真实消费者必须能指向自己的模型目录；缺省仍是包内 `models/`（仓库内 `npm run fetch:embedding-model` 预下载）。
5. **入口副作用修复（smoke 首次发现的缺陷）**：adapter-claude 的 "." 入口曾 re-export 自 `hook-main.js`（可执行入口，导入即副作用：注册全局 uncaughtException/unhandledRejection 处理器 + 排干 stdin）——库式导入会阻塞至 stdin 预算耗尽（默认 5s）并**吞掉消费者进程自己的未捕获异常**（退出码被改写为 0，smoke 因此假绿过一次）。修复：超时配置抽到零副作用的 `src/timeout.ts`，index/hook-main 均从其取值；回归测试 `test/index-entry.proc.test.ts` 以真实子进程锁定（父进程保持子进程 stdin 打开，导入 "." 后必须 2s 内完成且 stderr 干净）。
6. **独立消费者 smoke（`scripts/pack-smoke.mjs`，`npm run smoke:pack`）**：core/adapter-claude/adapter-opencode/embedding-local 四包 `npm pack` → 全新临时目录单次 `npm install` 四个 tarball（互相满足 `@subconscious/core@^0.1.0` 依赖）→ consumer 脚本断言：core 引擎构造 + 无指代 no-op；claude 库式入口真实注入 + bin `dist/hook-main.js` 在包内；opencode 未装 peer 时 "." 与 "./plugin" 均可导入且可真实注入（type-only import 编译期擦除证据）；embedding-local 缺依赖/模型 → `createLocalEmbeddingDetector` 规则等价 fail-open。**离线自证**：registry 指向 `http://127.0.0.1:9/`，任何意外联网解析立即失败。adapter-pi 不在范围：其 peer 非可选，离线安装必然触及 registry（M1 已有一次性手工验证，pi 的加载证据走仓库内真实 SessionManager fixture 测试）。CI 增补 `npm run smoke:pack` 步骤。
7. **测试纪律**：三适配器的 opt-in 测试（各 14 例）全部离线——loader 注入 2 轴向量 fixture provider + 2 条自定义示例，规则外表述「咱们那个摊子」作行为锚点（规则检测器零命中，opt-in 后端到端解析注入；未 opt-in 同句零注入即默认不变的端到端证据）；「模块缺失」用抛错 loader 模拟 ERR_MODULE_NOT_FOUND。真实 transformers 路径归 embedding-local 包评估（`eval:embedding`），不在适配器测试内触碰。

**设计目标保留**：默认行为零变化（未 opt-in 不 import、不计时、引擎不传 detector）；fail-open 覆盖到「适配器自己依赖缺失」这一新故障面；core 零依赖；测试离线；mock 与真实宿主的边界在 README/报告中显式区分。

## D23. 盲区补齐轮：内容指代规则化、会话内"刚才"降噪与 embedding span 扩展

**问题**（监督者深度测试 2026-09-15）：主干可靠（行为执行 3/3 反问消除），但内容指代（history-content）的自然表述大面积漏检——规则版只认训练句式（"一样的错误处理"），漏"按老规矩/照着…/定下的设计哲学/聊过的那些想法"；embedding 版多覆盖"老规矩"层但头脑风暴表述仍漏，且偶有截断 span（"前讨论的"）与误型（"架构哲"[project]）。另：会话内"刚才"（"还是用刚才讨论的方案吧"）触发历史会话候选框，模型上下文本就可见，属噪声（取消=零注入，无实害但多余）。

**决策**：

1. **五族内容指代规则化**（detector.ts，全部要求显式历史指向形态，近义负例逐条配测）：
   - `(按|照|依|遵循|沿用)老规矩`：前缀动词必需——裸"老规矩"多为习俗义（"咱们组的老规矩是周五聚餐"不触发）；
   - `照着(这|那)?(个|块)?(弄|改|清理|调整|处理|重构|写|来|做)`：宾语仅允许代词性成分或直接动词——"照着说明书装家具"（外部参照物+装）不触发；
   - `(定下|定好|说定)(的)?[CJK]{0,4}(设计原则|设计哲学|原则|哲学|思想|规矩|约定|风格|思路|方案)`：名词封闭表——"定下的目标""方案定下来了"不触发；
   - `(聊|谈|讨论|商量|碰撞|碰)(过|出)的?(那些|这些|几个)?(想法|思路|方案|点子|结论|共识)`：体验态"过/出"必需——"我喜欢讨论那些想法"（惯常义）不触发；
   - `(?<=那个|这个)[CJK]{1,8}的(改造|修改|重构|优化|调整|处理方式)`：lookbehind 使 span 不含指示词，与封闭名词模板同现时（"那个方法的修改"）模板先行占位、本模式因重叠让位（代码符号优先）。
2. **"之前"的条件事件化**：`之前(?=(跟|和)?(你|咱们|我们)?(聊|谈|讨|商|碰))`（lookahead 不消耗动词，事件 span 与内容 span 相邻不重叠）。裸"之前"单独不成指代的既有不变式（history.test）保持——这是头脑风暴表述（"咱们之前聊过的那些想法"）能建立 D4 绑定的前提：wave 1 需要一个 history-event（"之前"）被消歧选中，wave 2 的内容指代才有绑定会话。
3. **"刚才"拆分降噪**：跨会话继续语境（`(接着|回到|找回|从)刚才` 与 `刚才(?=的话|那个|那次|这轮|话题|地方|进度|继续)`）保留高置信（0.85/0.8）可解析——新会话开头"接着刚才的继续"仍指向上一会话；裸"刚才"置信 0.45 < 默认 minConfidence 0.5，引擎静默丢弃（droppedRefs 透明可见，数据源零调用）。理由：会话内"刚才"模型上下文本就可见，触发候选框只产生一次多余交互；检测器无法区分会话内/跨会话，故用语境形态区分（继续类动词=跨会话意图的显式信号）而非删除检测（评估集 origin 兼容）。宿主调低 minConfidence 可重新启用，是显式旋钮。
4. **监督 holdout 数据迁移（须监督者追认）**：`.supervision/detector-holdout.json` 的 m3SeparateFromM1 用例"照老规矩处理这段代码"与本轮"老规矩规则化"要求直接矛盾（该条锁定规则零检出）。按较新的监督指令（2026-09-15 任务书）将其移入 positive（mustInclude history-content），m3SeparateFromM1 以"就照咱们熟悉的路子来"替换（仍是规则外表述，维持"embedding 专属增量存在"的证明力）。若监督者不追认，回退本条即回退第 1 条的"老规矩"族。
5. **embedding span 扩展与无类型信息 span 防线**：滑窗命中（≤6 字）在 CJK 连续段内逐步向两侧延展，延展文本仍分类同类型才保留；不越过规则命中区间与其他命中区间（模板优先）；扩展 embed 与分类共享同额上限（单次 detectAsync 总 embed ≤ 2×maxCandidates，有界性测试锁定）；中止/provider 故障/时钟预算耗尽 → 整次规则回退（与分类阶段同语义）。同类型相接/重叠的扩展结果合并为一个指代（同一自然短语被多个种子分段命中时不重复计数）。拉丁 n-gram 本就按词边界生成，不参与扩展。另一防线 `isTypeInfoFree`：span 仅为裸指示词（这/那/这个/那个/…）或纯拉丁虚词（that/like/the/…）时在入列前拒绝——裸指示词不含任何类型信息，任何类型的分类结论都是噪声；入列前拒绝使"那个方法"这类完整短语不被裸词占位挤掉。该防线结构性消除 D19 已知 FP（裸 "that" @ "I like that idea"）与"那个"[code-symbol] 误检，不再以负例对抗。span 效果："前讨论的"式截断对齐到"咱们之前聊过的那些想法"级短语（"还是沿用原来的套路"）；贪心一步一停在相似度抖动处仍会早停或过冲（"就按老套路再实"），不强求完美。
6. **示例集 v2 与评估集扩充**：EMBEDDING_EXAMPLES_VERSION 1→2（history-content +9：头脑风暴模糊指代、定下的原则/哲学类、那套/惯用类；negative +7：哲学闲聊/外部参照物/惯常讨论防线）；EMBEDDING_EVAL_SET 34→49 例（+11 正例：规则族 7 + embedding 专属 4，中英文；+4 负例：哲学/闲聊/外部参照物）。泄漏检查（embeddingEvalLeakErrors）仍程序化锁定。fixture 词典（embedding-local 的 fixture-provider 与 core 测试副本）同步补关键词（聊出/点子/思路/商量/定好/设计哲学/agreed/settled/bounced）——否则新示例在 fixture 空间落噪声轴、稀释内容原型（纯内容种子相似度降至 0.58 < accept 0.6）。**调参教训（负例原型的杠杆率）**：单一均值负例原型对负例簇质心高度敏感——内容邻域负例加多会把 margin 门压到薄命中 TP 之下（照旧/咱们那套做法/same as our discussion 一度全灭），加少则哲学闲聊 FP 回潮；最终以 3 条针对性负例（纯属闲聊的想法交流/睡前翻翻哲学书/great idea love it）+ 结构性防线达成平衡。单原型 margin 门是该架构的固有局限，多原型（按示例最大相似度）留作后续评审项。
7. **实测基线更新**（2026-09-15，默认阈值 accept .65 / margin .1，49 例评估集）：真实模型 **P 100.0% / R 86.4% / F1 92.7% / 句子准确率 87.8%**；规则基线同集 P 100% / R 59.1%；规则外子集 recall：合并 66.7% vs 规则 0%。与 D19 基线（34 例集 P 96.4 / R 90.0 / F1 93.1）对照：精确率提升（已知 "that" FP 消除），评估集扩大 44% 且新增表述更难，召回基本持平。fixture 离线评估 P/R/F1 = 97.7%（回归下限 0.85 通过）。深度测试六维度：规则臂与 embedding 臂均 19/19（基线 13/19 与 15/19）。剩余 6 FN：这块代码/这段代码（code-symbol 弱区）、the usual way/the usual treatment、照旧、粘贴的那段（薄 margin 区，见第 6 条教训）。

**设计目标保留**：不猜测（全部新模板要求显式历史指向形态，近义负例逐条锁定）；fail-open（span 扩展任何故障=规则行为）；封闭类型集不变；core 零依赖；评估与训练互不泄漏由程序化检查维持；"刚才"降噪走置信度门（既有机制）而非新增引擎路径。

## D24. M5a 个人记忆层 v0：消歧先验 + 个人惯用语词典

**问题**（监督者 M5 方向）：让引擎"越用越懂我"，但红线是记忆只服务**用户说出口的指代**（不做预测注入，DESIGN §11.3）。两条能力共享一个记忆存储：①用户在 select 消歧中选定历史会话的先验，用于后续同类消歧的排序与保守代选；②个人惯用语词典（"咱们那个摊子"→project），作为运行时扩展接入检测。

**决策**：

1. **存储与 schema**：`~/.subconscious/memory.json`（与 grants.json 同目录），`{ version: 1, disambiguation: [{projectKey, sessionId, title, at}], phrases: [{phrase, expectedType, hint?}] }`。持久化参照 FileGrantStore（D17 同款）：同目录临时文件 + rename 原子写、写入队列串行化、损坏/IO 故障 fail-open 为**空记忆**（行为等同今天）。**projectKey 取 cwd 路径原文而非哈希**——记忆文件要求人可读、可手工编辑、可审计（隐私文档要求"打开即可查看"），哈希会让这三点全部失效；同项目 = 同路径字符串精确匹配。写入时裁剪窗口外与无效时间记录并封顶（先验 100 条、词条 200、短语 ≤64 字符、提示 ≤200 字符）。
2. **消歧先验语义**（只作用于 history-event 消歧的**既有候选**，绝不把先验会话加进候选集）：
   - 学习：用户在 select 中**亲选**历史会话 → 记录一条先验。自动代选**不**再学习（防自增强）；用户取消/无 UI 不学习。
   - 加权：同项目内每次选择贡献 `1 + (14 − 距今天数) / 14 ∈ [1, 2]`（今天 2、窗口边界 1），按 sessionId 累积；异项目、窗口外、无效时间不计；未来时间戳按当下计（时钟偏移容错，取值有界）。
   - 保守代选：仅当首选（权重最高，并列取候选顺序在前者）在 14 天内被选 ≥2 次**且**权重 ≥2× 次选时自动解析；注入 display 后缀 `（按你的常用选择）`，与既有 `（来源：recent-sessions）` 来源标注叠加，满足透明性（代选可审计）。任一门槛不满足 → 照旧弹 select（候选按先验加权稳定排序）并继续学习。
   - **阈值依据**：14 天 = 双周工作节奏的自然"近期项目"周期，且写入时裁剪使记忆文件自动瘦身（旧习惯过期即消失）；≥2 次 = 一次选择可能是试探/误选，两次独立选择是"习惯"的最小证据；≥2× = 两个会话都被频繁选（权重接近）时习惯不成立，必须回到用户——权重公式把"近期"连续化（近的选择贡献高），避免硬窗口二值化。
   - 预算纪律（D3 同源）：记忆读取在机器预算内进行，读取后复查 expired；选择后写记忆前检查引擎信号已中止即不写（D3.3 迟到回调不落盘，同 grants 写入纪律）。
3. **个人惯用语词典语义**：`createPersonalPhraseDetector(base, phrases)` 包装任意检测器（含 M3 AsyncDetector：detectAsync 同样合并）。精确匹配（大小写敏感、按原文位置命中）产出带真实 span 的 DanglingRef（置信 0.95 = 显式注册是用户给的最强信号，与最精规则模板同级），后续走正常解析；与基座命中重叠时**个人短语优先**，非重叠合并按位置排序、统一重编 id；**零合法词条时不包装**（返回基座本身，行为逐字节一致）；出厂示例与规则词典零改动。词条只在"用户说出口"（短语出现在话语中）时触发，不改变无指代零开销透传。`hint` 字段 v0 只存储与文档化，不进入解析路径（预留）。
4. **v0 只显式注册，不做自动学习**：词条入口 = `addPersonalPhrase` API + memory.json 手工编辑（两空格缩进，人可直接改）。理由：自动学习（从交互/注入行为归纳词条）的错学成本不对称——错误词条会把无辜短语变成常驻指代（每次出现都触发解析与可能的交互），且用户不可见其来源；显式注册零错学、可审计、可撤销（删词条/删文件）。**惯例蒸馏**（从会话内容归纳"照旧"指什么）需要语义判断，离线确定性做不到，属 M5b；先验学习（用户说出口的指代 + 亲选结果）证据链最短，是 v0 唯一自动记录项。
5. **可移植与隐私**：可移植 = 文件本身（新电脑复制 memory.json 即迁移）；另提供 `exportMemory`/`importMemory` 纯函数（序列化/严格校验，导入非法返回 null、导出非法受控失败 `invalid-memory`）供程序化迁移。隐私级别：先验与词条都是**用户自己选择的记录**，本地存储、本地消费、不离开设备，v0 按 L0 对待；文档（README）写明查看（打开文件）、清除（删除文件即清零，或清空对应数组）、迁移（复制文件）方法。文件内容含项目绝对路径与会话标题——这是选可读性放弃最小化的显式取舍。
6. **快照纪律不变**：记忆是持久数据源，不是引擎会话状态——引擎每次 enrich 按需读取（无实例内缓存），两引擎实例各自构造/传入存储互不影响；共享同一存储的实例按持久化语义可见彼此学习结果（D11 每事件重建引擎的形态下即"越用越懂我"）。
7. **范围与不接线声明**：本层交付于 core（类型 + FileMemoryStore/InMemoryMemoryStore + 纯函数 + 检测扩展 + 引擎 `memory` 选项，缺省不传 = 行为与无此层逐字节一致）。三个适配器**暂不接线**（同 D17 grants.json 先例：存储由调用方显式传入路径）；适配器接线（各宿主的 memory.json 路径解析与词典加载时机）与 M5b 一并处理。

**设计目标保留**：不预测注入（先验只排序/代选既有候选，词典只在短语说出口时触发，两条红线各有测试锁定）；fail-open（记忆任何故障 = 无记忆，prompt 照常发出）；透明性（代选 display 标注、注入来源标注不变）；core 零运行时依赖（node:fs 仅出现在文件存储，同 file-grants）；封闭类型集不变（词条类型必须 `isDataType`）。

## D25. M5c-1 项目惯例层（core）：schema v2、解析接入与六决策点裁定

**问题**（M5b Part 2 设计稿 [CONVENTIONS.md](CONVENTIONS.md)，监督者 2026-09-15 裁定）：把"照旧 / 老规矩 / 按咱们那套"类指代解析为**蒸馏后的惯例值**而非绑到单次会话；六个决策点（D-A..D-F）待裁定，core 实现（存储 + 解析接入 + 红线测试）先行，适配器蒸馏接线归 M5c-2。

**裁定**（监督者原裁定 + 本轮实现细化）：

1. **D-A 蒸馏时机 = ①会话结束即蒸馏**（素材最新鲜、跨宿主立即可用；②惰性③混合留评审）。core 侧无蒸馏——蒸馏只发生在宿主事件、由宿主模型执行（M5c-2 接线），本轮只交付 `addConvention` 等可测落盘接口。
2. **D-B 蒸馏质量评估进 `.supervision/`（人工标注小集），阈值不预置**。本轮不做评估，只保证可评估：`isConvention`/`parseMemoryData`/上限常量（`MAX_CONVENTION_EXPRESSION_CHARS` 等）全部导出，评估脚本可直接复用同一校验面。
3. **D-C 注入授权 = ②L1-grant-once**：sourceId 固定 `conventions`、scope = projectKey（env.cwd）；未授权走既有 L1 确认路径（复用 `checkPermission`，确认文案点名惯例内容/候选），通过后按既有 grants 机制持久化，授权一次后续不打扰；无确认通道宿主 → `interaction-unsupported` 受控丢弃，由既有 D20.2 录制型端口转写为「待确认」块降级。蒸馏**写入**不需授权（本地文件），**注入**需要。
4. **D-D 纠正 = ①手工编辑 memory.json + ③否定语单次跳过**：`conventionNegationMatches` 窄模式（`(别|不)(要|用)?(按|照|依|遵循|沿用)?(老规矩|惯例|照旧)`）命中则本轮跳过惯例解析（其余指代照常、内容指代回退既有会话绑定路径），不删惯例；"别的不说，按老规矩来""他不停按老规矩办事"等近邻干扰不命中（测试锁定）。
5. **D-E schema = 并入 memory.json，version 2**（单一记忆文件 = 单一隐私面与迁移面）：`conventions: [{id, projectKey, expression, content, basedOnSessionId, basedOnSessionTitle, generatedAt, lastHitAt, hitCount}]`；v1 文件兼容读（conventions 视为空）、写恒 v2；旧 core 读 v2 → version 校验失败 → fail-open 空记忆（其既有"version 不是 1 → 空"测试即降级安全证据，本轮新增用例锁定 v2 文件可被新 core 读写往返）。
6. **D-F 裸"照旧"多惯例 = 候选列表（ambiguous），绝不静默注入**：候选按 lastHitAt 降序稳定排序后走既有 select 消歧；选择器不可用 → interaction-unsupported 丢弃（无通道宿主经待确认块转问用户）。

**实现要点（core，全部确定性、零 LLM、零新依赖）**：

- **命中条件**：检测层零改动——既有 history-content 检测（"按老规矩/照着…弄/一样的…"模板或 embedding 臂）产出指代后，wave 2 每条 history-content 指代**先过惯例**（`tryResolveByConvention`），本项目无活跃惯例/窄否定/读取故障/无 memory → 返回 null 完全回退既有 session-content 路径（行为与今天逐字节一致，测试以双引擎输出 deep-equal 锁定）。
- **锚定（不猜测）**：域锚 = 话语精确包含 expression（"照旧处理错误"不含「错误处理」即不锚——近义扩展属 embedding 臂，core 不猜）；域锚唯一即直取；无域锚时唯一活跃惯例直取；多惯例 → 候选列表。惯例优先于会话绑定（命中惯例时 session-content 零调用，测试锁定）。
- **写时纪律（读侧无状态，存储实现内存/文件共享纯函数）**：90 天未命中（lastHitAt）淘汰、每项目 ≤20、全局 ≤200（均按 lastHitAt 最旧，超限是**淘汰**不是失败——与词条封顶语义不同）；同 projectKey+expression 后写胜（整条替换，id/basedOn/generatedAt 一并更新不留双活）；expression+content 逐字节相同 → no-op 不洗 lastHitAt/generatedAt/hitCount（防蒸馏重放"洗时间"绕过衰减，同 D24 自增强防线）；lastHitAt 无效时间写时受控淘汰。parse 侧沿用 D24"不产出半份数据"：v2 文件任一条目非法或超全局上限 → 整文件 null → 空记忆。
- **读侧活跃过滤**：`activeConventions` 在引擎读取后过滤（90 天窗口、无效时间不活跃、未来时间按当下计）——只靠写时淘汰会有"无写入则过期惯例永存且可注入"的漏洞，读侧过滤使红线可端到端测试（91 天惯例不注入、连授权确认都不发起）。
- **命中回写**：注入成功（直取或候选被亲选）→ `recordConventionHit(projectKey, id, at)` 更新 lastHitAt/hitCount + 写时淘汰；回写失败只记日志不影响本次注入；写前检查引擎信号已中止即不写（D3.3 迟到回调不落盘）。候选定位按（projectKey, id）双键——适配器自造 id 跨项目撞名也不串扰。
- **注入形态**：display = `惯例：{expression} = {content}（惯例·生成于「{title}」会话 · 已用 {hitCount} 次）`（无标题回退会话 id），经组装器带 `（来源：conventions）` 标注；value 复用封闭集 history-content 形状（sessionId=basedOnSessionId、diff=`expression = content`），不新增 DataType（D1 封闭集纪律）。
- **授权门细节**：L1 门在候选交互**之前**（授权是"源"的属性，一次授权覆盖本项目后续全部注入，含多惯例 select）；确认文案对录制型端口可读（点名内容/候选），使无通道宿主的待确认块有意义。

**范围与遗留**：本轮只交付 core（types/memory/conventions/engine + 45 个新测试用例，全离线）；适配器蒸馏接线（session_shutdown/SessionEnd/session.idle → headless 蒸馏 → 校验 → addConvention）归 **M5c-2**。既有适配器传入的 memory store 即刻获得惯例解析能力（引擎侧行为），但蒸馏无入口，惯例只能手工编辑 memory.json 产生。core 零依赖不变（R4），无需新增 R 规则（check-deps 全绿）。

**设计目标保留**：不预测注入（惯例只在既有内容指代被检出后参与解析；无指代零开销透传不因记忆改变）；fail-open（记忆读取/回写任何故障 = 回退既有路径或尽力而为）；透明性（display 出处 + 来源标注 + grants 可查可撤销）；封闭类型集不变；core 零依赖零 LLM（蒸馏在宿主，core 只存取与确定性解析）。

## D26. M5c-2 适配器惯例蒸馏接线：三宿主事件/执行面核实证据与选择

**问题**（M5c-2 任务书，2026-09-15）：三个适配器需在会话结束事件触发惯例蒸馏（宿主 LLM headless 总结 → 适配器校验 → addConvention 写回），core 零 LLM 红线不破。三宿主的结束事件名/载荷与 LLM 调用面须按锁定版类型声明与官方文档核实，不得虚构接口。

**三宿主蒸馏执行面核实记录（2026-09-15）**：

1. **pi（事件 + headless 形态均由锁定版核实）**：
   - `session_shutdown`：`@earendil-works/pi-coding-agent@0.85.1` `dist/core/extensions/types.d.ts:474-479`（`SessionShutdownEvent { type; reason: "quit"|"reload"|"new"|"resume"|"fork"; targetSessionFile? }`）与 `:916`（`on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>)`，返回 void）；`.supervision/pi-extensions.md`（锁定文档快照）§session_shutdown 确认 new/resume/fork 属会话替换流、reload 属扩展运行时重载。会话素材通道：`ReadonlySessionManager` 的 `getSessionFile/getSessionDir/getSessionId/getSessionName`（session-manager.d.ts:140,205-230）。
   - headless 形态：根 README 已在本机 pi 0.85.1 验证的 `pi --offline --no-session --no-extensions --no-skills --no-tools -p`。
   - **选择**：reason=reload **跳过**（重载时会话仍在继续，蒸馏会冻结半途素材且去抖挡掉结束时更完整的蒸馏）；quit/new/resume/fork 触发。执行 = **detached `node dist/distill-child.js` 监工子进程**（fire-and-forget，不阻塞会话结束；quit 后靠 detached 存活完成「headless pi → 校验 → 写回」，素材经 0600 临时文件传递、读完即删）——纯 detached spawn 不带监工则 quit 后无人消费子进程 stdout，写回结构性丢失。
2. **Claude Code（事件面经官方文档镜像/社区实现核实；通用 stdin 协议 D20 已核实）**：SessionEnd 经 stdin 收通用字段（session_id/transcript_path/cwd/permission_mode/hook_event_name）+ 事件特有 `reason`（clear/logout/prompt_input_exit 等）；无 prompt 字段；stdout 无上下文通道。官方 docs 域名在本环境被代理拦截，改经官方文档索引与社区协议参考交叉核实（[hooks reference](https://code.claude.com/docs/en/hooks)、[hooks guide（SessionEnd matcher on reason）](https://code.claude.com/docs/en/hooks-guide)），与 D20 已核实的通用字段面一致。
   - **选择**：**复用同一 bin**（`hook-main` 双事件分派，不新增 bin）；SessionEnd 无 stdout 输出、日志 stderr、退出码 0。执行 = hook 进程内 spawn headless **`claude -p`** 并等待（默认 50s < 宿主 hook 默认 60s，免配置；hook 进程即「会话结束后」的一次性进程，等待是完成写回的唯一途径）。**防递归哨兵** `SUBCONSCIOUS_DISTILL_CHILD=1`：蒸馏子进程内触发的任何 hook（UserPromptSubmit 注入污染素材 / SessionEnd 再蒸馏）在入口顶部拦截为 no-op。素材 = transcript_path JSONL **尾部 64KB 原文拼接**（内部结构无官方文档 → 不解析字段，近似素材，README/根 README 注明；newline 对齐 + fatal UTF-8）；`basedOnSessionTitle` 置空（无官方标题通道，不虚构，display 回退会话 id）。
3. **OpenCode（事件 + client 侧 LLM 调用面均由锁定版类型声明核实）**：
   - `session.idle`：`@opencode-ai/sdk@1.18.30` `dist/gen/types.gen.d.ts:413-417`（`EventSessionIdle = { type: "session.idle"; properties: { sessionID: string } }`）；经 `@opencode-ai/plugin@1.18.30` `Hooks["event"]: (input: { event: Event }) => Promise<void>`（plugin dist/index.d.ts:175-178）投递。OpenCode 无「会话销毁」事件，session.idle 每轮回复完成后触发。
   - **client 侧 LLM 调用面存在且公开**：`client.session.prompt`（POST /session/{id}/message，"Create and send a new message to a session"，sdk.gen.d.ts:170-174；body `{ parts: TextPartInput[]; system?; tools?: Record<string, boolean> }`，响应 `{ info: AssistantMessage; parts: Part[] }` 即助手回复，types.gen.d.ts:2244-2287）+ `session.create`（:114 / types.gen.d.ts:1811）/ `session.delete`（:122）支撑临时会话生命周期。**据此不采用备选的 spawn `opencode run` 子进程**。
   - **选择**：蒸馏在**临时会话**内进行（create → prompt(`tools:{}` 结构性禁用工具 + 系统提示约束 JSON) → delete），绝不污染用户会话；临时会话登记进**进程内注册表**，本插件对其 chat.message/session.idle 一律跳过（防自触发：蒸馏回复的 idle 不再触发蒸馏）。素材 = `session.get`（标题）+ `session.diff`（FileDiff），全走官方 SDK（D21.3 纪律）。**去抖为冷却窗口（默认 30 分钟）而非每会话一次**：session.idle 每轮触发，每会话一次会把素材冻结在首轮；冷却窗口允许长会话阶段性重蒸馏（upsert 相同内容 no-op），成本约束在每会话每窗口至多一次——这是对任务书「同会话重复结束事件只蒸馏一次」在 OpenCode 事件语义下的忠实适配（pi/claude 仍是严格一次）。

**共同纪律（三适配器各自内置 distill 模块，刻意不抽公共包——R6/R7 依赖方向）**：

- **校验面（CONVENTIONS §4，不信模型输出）**：JSON 解析失败 → 放弃本次（围栏剥离 + 首 `[` 末 `]` 切片的确定性二次机会）；逐条形状校验（复用 core `isConvention`：expression ≤16 字 / content ≤120 字）→ 非法丢弃；超 5 条截断；敏感内容粗筛（私钥块 / sk-、gh 系列、xox 系列、AKIA 前缀 / Bearer 令牌 / 40+ 连续无分隔随机串）命中丢弃该条并记 warn；与现有条目逐字节相同丢弃（防「洗时间」；core upsert 亦 no-op，双保险）。
- **开关/超时/注入面**：`SUBCONSCIOUS_DISTILL=0` 关闭（其余任何值含未设置 = 开）；`SUBCONSCIOUS_DISTILL_TIMEOUT_MS`（pi/opencode 默认 60s、claude 50s，上限 300s）；pi/claude 的 headless 命令经 `SUBCONSCIOUS_DISTILL_BIN` 覆盖（测试注入面）。蒸馏**写入**不需授权；**注入**的 L1-grant-once 已由 core（M5c-1）处理——pi 传真实 `ctx.ui` confirm、claude/opencode 录制型 unsupported 降级「待确认」块，本轮零新代码（core conventions-engine.test 的 L1 四路径 + 降级路径测试锁定）。
- **fail-open**：任何失败（素材读取 / spawn / 超时 / 输出非法 / 写回）= stderr 单行 warn 后静默跳过，宿主会话/退出流程零影响；不做网络重试。opencode 的蒸馏在后台 promise 内（event hook 立即返回）；claude 在 hook 进程内等待（有界）；pi 完全进程外。
- **测试形态（全离线）**：宿主 CLI 一律**假可执行文件**（shell 脚本回放固定 JSON）或注入的假执行器/假 SDK 客户端——绝不真调宿主 CLI；hook/child 用真实编译产物子进程（claude：spawn `dist/hook-main.js` 经 stdin/stdout；pi：真实 `dist/distill-child.js` + detached 触发路径 + 轮询写回断言）。真人端到端蒸馏未做（监督约束禁触真实宿主/会话），README 与报告如实区分。pi 的 test 脚本改为先 build（蒸馏子进程需编译产物，与 claude/opencode 同形）。

**设计目标保留**：core 零依赖零 LLM（蒸馏只发生在宿主事件、由宿主模型执行，适配器只做确定性校验与写回）；fail-open 覆盖蒸馏全链路；不预测注入红线不因蒸馏改变（惯例只在既有内容指代被检出后参与解析）；透明性（memory.json 人可读、display 出处、grants 可撤销、临时会话/临时文件标题与权限可辨识）；check / check-deps 全绿，无新增运行时依赖（R4/R6/R7/R8 不变）。
