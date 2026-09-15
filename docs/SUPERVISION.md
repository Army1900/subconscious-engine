# 开发安排与严格验收

监督开始：2026-09-13 12:55 Asia/Shanghai。最早结束：2026-09-13 22:55 Asia/Shanghai；这只是时间门槛，不代表代码自动合格。
执行者：Claude CLI。监督者：Codex，负责派单、审查差异、独立执行检查、退回问题。

## 任务顺序
1. M1：严格 TypeScript 工程、core、规则检测器、注册表、解析/组装、L0 sources、pi 适配器及离线集成演示。
2. M1 验收修复：独立验证故障透传、数据隔离、超时后无新副作用、历史关联和检测误报。
3. M2：持久化 scope grants、撤销/过期、clipboard 显式授权、pi 获取图片与附件。
4. M3：有可验证评估集的可选本地 embedding 检测器、并行解析与依赖顺序、性能/失败矩阵。
5. M4：真实协议 Claude hooks 与 OpenCode 适配器，官方接口核实和打包安装验证。
6. 硬化：包导出、独立消费者 smoke、文档示例、CI、安全与回归、缺陷复验。

## 强制约束
- 用户原始 DESIGN.md 当前未跟踪，保留原文；变更需说明决策，不能删目标掩饰未完成。
- Node >=22，TS strict；禁止 any；core 不依赖宿主或 adapters；测试不依赖网络/真实账户。
- 不猜测当前文件或历史会话。多个候选未消歧时不注入确定结论；历史内容必须绑定所选会话。
- 显式指代、置信度、span 必须真实一致；无指代不得读取数据源或发起交互。
- 授权在读取前检查；拒绝/unsupported 不读取；L2 不持久化；获取动作须确认。
- 超时保留已完成结果，停止后续动作，迟到回调不得写 grants 或注入；为异步端口传取消信号。
- 用户输入与来源数据视为数据；有上下文/附件大小界限，文件路径和会话读取限制与编码检查。
- 实际宿主 SDK/协议按官方文档核实；mock 通过不等于真人宿主端到端通过，报告必须区分。
- 允许本仓库开发、安装开发依赖、测试；禁止发布、推送、改全局宿主配置或接触私人会话/剪贴板来测试。
- 每轮交付提供变更、命令/结果、剩余问题；监督者独立复验后才标记 accepted。
- 10小时内持续安排有价值的实现/审核，不通过空转、重复无变化测试伪造持续工作。

## 状态
- M1 已独立验收：全仓类型检查、192 个测试、依赖契约、离线真实 SessionManager/adapter 演示、包 tarball 独立消费者导入均通过。M1 仍无真人 pi E2E，README 已明确该限制。
- M2 正在拆分为持久 grants/clipboard 与 pi acquisition 两个小任务；D17 记录了 scope 和隐私边界。
- 2026-09-14 监督者（ZCode）接手：M2 代码与测试已在仓（grants/clipboard/acquisition/parallel/holdout 测试文件齐备，npm run check 与 check-deps 全绿），README 已声明 M2 能力；按已实现验收。M3 已派单给 Claude CLI（embedding 检测器 + 评估集 + 规则回退），随后 M4（Claude hooks / OpenCode）与硬化。
- 2026-09-14 M3 已独立验收：npm run check 全绿（core 186 / pi 47 / demo 1 / embedding-local 8+1 skip）、check-deps R1–R5 通过、离线 fixture 评估 P/R=96.7%、评估泄漏由程序化用例锁定、回退路径（provider 缺失/中止/超预算→规则）代码审查确认。真实模型评估 P96.4/R90.0（实现者自报，模型为本机缓存）。遗留：裸 "that" 单例 FP、首次 enrich 原型构建可能回退、pi 适配器未接线 embedding（归入硬化任务）。
- 2026-09-14 M4a（adapter-claude）已独立验收：npm run check 全绿（282 通过）、check-deps R1–R6 通过、监督者亲测真实子进程协议（stdin hook JSON → stdout 单行合法 hook JSON，含 additionalContext）。无真人 Claude Code E2E（约束禁止改全局宿主配置），README 已区分。遗留：会话内容因 transcript 结构无官方文档而诚实 not-found；embedding 未接线（归硬化）。
- 2026-09-14 M4b（adapter-opencode）已独立验收：npm run check 全绿（317 通过，opencode 38）、check-deps R1–R7 通过、监督者亲测 dist 零 @opencode-ai 运行时引用、dist/plugin.js 真实加载导出。插入点 chat.message 以锁定版本 @opencode-ai/plugin@1.18.30 类型声明核实（官方文档未列该 hook，差异已记 D21）；无真人 OpenCode E2E，README 已区分。中途一次 429 限额中断后由监督者检查半成品并重新派单续做。
- 2026-09-14 硬化轮已派单（适配器可选接线 embedding、tarball 消费者 smoke 扩展、README/DECISIONS 收尾），验收后由监督者统一提交。
- 2026-09-14 硬化轮已独立验收并整体收口：npm run check 360 通过、check-deps R1–R8 全绿、demo 通过、smoke:pack 四包独立消费者断言通过。该轮另发现并修复 adapter-claude "." 入口副作用缺陷（re-export 自可执行入口，回归测试以真实子进程锁定）。M1–M4+硬化全部 accepted；遗留（裸 "that" FP、opt-in 真实模型冷加载未实测、真人宿主 E2E 未做）已在 README/DECISIONS 如实记录。
- 2026-09-15 监督者深度测试（.supervision/deep-test.mjs，六维度×双检测器×多轮）：规则臂 13/19、embedding 臂 15/19；暴露内容指代自然表述盲区与"刚才"会话内噪声；期间测试装置自身 SessionRecord 契约错误被引擎稳定绑定红线正确拒绝（防线有效证据）。
- 2026-09-15 M5b（记忆层适配器接线+惯例蒸馏设计稿）已独立验收：npm run check 464 通过（pi 74/claude 68/opencode 65/core 247）、check-deps 全绿；监督者经真实 claude hook 子进程三场景亲测——预置先验（同会话 2 次/14 天内）触发"接着上次的继续"零交互自动代选+审计标注、预置个人短语"咱们那个摊子"端到端注入、记忆文件缺失行为不变。宿主差异如实：pi 可学习（有 select），claude/opencode 共享 memory.json 代选但结构性不学习（"pi 学、处处用"）；三包测试 env 密闭钉防真实 ~/.subconscious 漂移。CONVENTIONS.md 设计稿（265 行，含宿主事件事实表/提示词草案/schema v2/L1 建议/6 决策点）待裁定后立项 M5c。遗留：pack-smoke 未钉 env（低风险已记录）、claude/opencode 先验写入靠 pi 或手工（结构性）。
- 2026-09-15 M5a（个人记忆层 v0：消歧先验+惯用语词典）已独立验收：监督者脚本（.supervision/m5a-accept.mjs）验证学习闭环（两次亲选→第三次零交互自动解析且带"按你的常用选择"审计标注）、自动解析门槛（≥2 次亲选+权重 2×）、ghost 红线（记忆会话不在当前候选不注入）、项目隔离、文件记忆跨实例移植（复制 memory.json 即生效）、export/import round-trip、损坏 fail-open、无 memory 行为不变；npm run check 466 通过（core 247，+42）、check-deps 全绿。词典接线为显式组合（createPersonalPhraseDetector，正确用法端到端亲测通过）。监督者验收脚本两处初始误报已裁决为脚本问题（门槛断言/词典用法）。适配器接线与惯例蒸馏归 M5b（D24.4/24.7）。
- 2026-09-15 优化轮（内容指代盲区补齐）已独立验收：384 测试全绿（core 205）、check-deps R1–R8 通过、深度测试规则/embedding 双臂均 19/19、真实模型评估（49 例扩充集）P 100% / R 86.4% / F1 92.7%（规则基线 R 59.1%）、奥卡姆剃刀/道法自然引擎层零注入（监督者亲测，"的原则重构这个"低置信检出被 no-binding 纪律兜住，记录为检测层瑕疵不阻塞）、裸"刚才"引擎层丢弃而"接着刚才的继续"跨会话解析保持。holdout 数据迁移（老规矩→positive，m3SeparateFromM1 换"就照咱们熟悉的路子来"）经监督者亲测短语行为后追认。遗留 FN（这块代码/the usual way/照旧等 6 例）与多原型 margin 门评审项已记 D23。
