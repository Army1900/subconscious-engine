# M1 设计决策记录（DECISIONS）

本文档解决 DESIGN.md v0.1 草案在 M1 实现前暴露的矛盾与未决项。每条决策标注：**矛盾/问题 → 决策 → 理由与设计目标的保留**。设计目标（fail-open、纯 core、透明注入、封闭类型集、不猜测）全部保留；本文只做不违背它们的收紧或补齐。

| 项 | 值 |
|---|---|
| 文档版本 | 1.2（监督整改轮：新增 D13–D16，修正 M3 并行表述与图片链路边界） |
| 关联 | [DESIGN.md](../DESIGN.md)、[SUPERVISION.md](SUPERVISION.md) |

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
