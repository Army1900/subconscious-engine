# 潜意识引擎 设计说明书

| 项 | 值 |
|---|---|
| 项目名 | subconscious-engine |
| 文档版本 | 0.1（草案） |
| 状态 | 待评审 |
| 读者 | 后续参与开发的本项目工程师（未参与前期讨论，本文档自包含） |
| 上游依赖 | 无运行时强依赖。适配 pi / Claude Code / OpenCode 等宿主 agent，但核心库不依赖任何宿主 |

---

## 1. 背景与问题

### 1.1 问题：大模型的反问轮次

当前所有主流 agent（pi、Claude Code、OpenCode 等）的交互模式是：用户说什么，大模型收到什么。但人说话时，话语中天然携带大量**没有说出口的依赖**。

用户对 agent 说：

> "把这个函数改成和上次一样的错误处理。"

这句话的隐性依赖至少有三个：

1. **"这个函数"** —— 说话人默认对方知道自己指的是当前编辑位置/最近讨论的函数
2. **"上次"** —— 指向某个历史会话或某次历史修改
3. **"一样的错误处理"** —— 指向那次修改的具体内容

大模型一个都不知道，只能反问："哪个函数？上次是哪次？"一个来回 5-10 秒。反问轮次是当前 agent 交互延迟和体验摩擦的主要来源之一。

### 1.2 现状：pull 模式的代价

现有 agent 的解法是 function calling（工具调用）：大模型发现缺数据 → 发起 tool call → 拿到结果 → 继续生成。这是 **pull 模式**——由大模型在事后拉取。

代价：

- 每个依赖烧掉一次完整的 LLM 往返（决策 + 结果回传 + 继续生成）
- 高频依赖（"当前文件""上次的会话"）每次都要重复拉取
- pull 决策本身消耗 token 和延迟

### 1.3 机会

用户话语中的隐性依赖绝大多数是**封闭类型**（文件、历史会话、时间点、数值、图片、数据记录），且每句话通常只有 2-3 个。这些依赖可以在本地、在 prompt 发出之前、用极低的成本解析掉。这就是本项目要做的事。

---

## 2. 核心理念

### 2.1 一句话定义

**在用户表达到达大模型之前，本地层自动识别话语中悬空的数据依赖（"潜意识"），从本地数据源解析或通过获取动作取得对应值，组装成接地的上下文注入给大模型，消除大模型的反问轮次。**

对人的类比：人的表达依赖大脑中的记忆和五感。对程序，"潜意识"= agent 对所在系统与用户环境的感知：文件系统、编辑器状态、历史会话、设备传感器等。

### 2.2 与意图路由的区别（重要澄清）

本项目**不是**意图识别 + 本地应答。两者的关键区别：

| | 意图路由（不是本项目） | 潜意识引擎（本项目） |
|---|---|---|
| 目标 | 命中意图后本地直接返回，跳过大模型 | 组装上下文后**仍交大模型**，只是让它不用反问 |
| 决策对象 | "这句话是什么意图" | "这句话缺什么数据" |
| 失败模式 | 误路由 → 错误答案（危险） | 解析失败 → 原样透传（安全） |

这个区别决定了本项目的风险模型是良性的：最坏情况退化为现状（大模型反问），不会比现状更差。

### 2.3 反问变动作

当依赖的数据**尚不存在**时（例如用户问"这是什么花？"但还没有照片），本地层不只报错，而是根据缺失数据的类型触发**获取动作**（acquisition action）：

- 缺图像 → 打开相机 / 相册 / 文件选择器
- 缺文件 → 文件选择对话框
- 指代解析出多个候选 → 候选选择器（一次点击）
- 缺数值 → 定向输入框

本质：把"澄清"从对话轮次（用户组织语言描述）变成 UI 事件（用户一次点击）。

---

## 3. 总体架构

### 3.1 数据流

```
用户话语
   │
   ▼
[指代检测器] ──── 识别悬空指代（"这个函数"、"上次"、"那张图"…）
   │                 无指代 → no-op 透传
   ▼
[数据源注册表] ── 按指代的期望数据类型查找候选数据源（含授权级别）
   │
   ▼
[解析器] ──────── 逐个解析
   │   ├─ 免授权数据源 → 直接取值
   │   ├─ 已授权数据源 → 直接取值
   │   ├─ 需确认数据源 → 弹确认（一次点击）
   │   ├─ 多候选 → 弹候选选择器
   │   └─ 数据不存在 → 触发获取动作
   ▼
[组装器 enrich] ── 解析结果 + 用户原话 → 注入文本 + 附件
   │
   ▼
[宿主适配器] ───── 注入给宿主 agent（pi / Claude Code / OpenCode）
   │
   ▼
大模型（拿到接地的上下文，直接干活，不反问）
```

### 3.2 三层可移植性

系统的可移植性分三层，**每层策略不同**：

| 层 | 内容 | 可移植性 | 策略 |
|---|---|---|---|
| L-core | 指代检测、数据源注册表、授权检查、解析、组装 | 全可移植 | 纯 TS 库，零宿主依赖，纯函数风格 |
| L-inject | 把组装结果注入各 agent | 各家都有插入点 | 每宿主一个薄适配器 |
| L-interact | 确认对话框、获取动作的 UI | 差异大 | 每宿主独立实现，**允许降级**（见 8.2） |

设计纪律：core 永远不 import 任何宿主的类型；UI 交互永远留在适配器层；某宿主交互降级不影响其他宿主。

### 3.3 端到端示例 trace

输入："把这个函数改成和上次一样的错误处理"

```
1. 指代检测器:
   [
     { text: "这个函数",   type: "code-symbol" },
     { text: "上次",       type: "history-event" },
     { text: "一样的错误处理", type: "history-content" }
   ]

2. 解析:
   "这个函数"   → 数据源 active-editor（L0 免授权）→ resolved: src/api.ts#handler
   "上次"       → 数据源 recent-sessions（L0）→ ambiguous: 2 个候选
                 → 候选选择器（用户一次点击）→ resolved: 会话 2026-09-10
   "一样的错误处理" → 数据源 session-content（L0）→ resolved: 对 retryWrapper 的 diff

3. 注入（作为附加消息随用户原话一起发给大模型）:
   [潜意识引擎·已解析]
   - "这个函数" → src/api.ts 第 42 行 handler()（当前编辑器打开的文件）
   - "上次" → 2026-09-10 会话，用户对 retryWrapper 做过错误处理改造
   - "一样的错误处理" → 该次修改的 diff:
     ```diff
     ...
     ```

4. 大模型直接开始改代码。零反问。
```

---

## 4. 核心模块设计（packages/core）

### 4.1 指代检测器

**职责**：输入用户话语文本，输出悬空指代列表。不做解析，只做检测与类型标注。

**演进路线**（M1 → M3）：

1. **规则版（M1）**：指示词词典 + 正则。中文指示词集（这个/那个/上次/刚才/上面/之前/同样/一样），英文（this/that/last/previous/the same as/above）。按期望数据类型模板匹配（"这个函数" → code-symbol，"那张图" → image）。
2. **embedding 版（M3）**：指示词短语 + 上下文窗口做向量近邻分类，覆盖规则外的表述。仍输出同一接口。

**关键约束**：

- 只检测**话语中显式出现的指代**，不预测用户没说的需求（预测型注入会污染上下文，见 12.1）
- 每个检测结果带置信度，低置信进入透传而非猜测
- 输出带 span（在原文中的位置），供组装器引用

### 4.2 数据源注册表

**职责**：声明式登记所有本地数据源，每个源声明它服务的类型和授权级别。

首批数据源（全部 L0，M1/M2 交付）：

| 数据源 id | 类型 | 内容 | 获取方式 |
|---|---|---|---|
| `cwd-context` | project | cwd、目录结构摘要、git status | 系统调用 |
| `active-editor` | code-symbol | 当前打开/最近编辑的文件与位置 | 宿主 API（pi: 扩展事件；见 7.x） |
| `recent-sessions` | history-event | 最近 N 个会话的摘要与会话 id | 宿主会话存储（pi: sessions/） |
| `session-content` | history-content | 指定会话内的 diff / 消息 | 同上 |
| `clipboard` | text/image | 剪贴板内容 | 系统调用（L1：首次授权） |

注册表是纯数据 + 解析函数的集合，新增数据源不改 core 逻辑。

### 4.3 解析器与授权检查

**职责**：对每个悬空指代，按注册表找到候选数据源，执行解析，处理授权门槛。

解析结果四态：

```
resolved        → 拿到值，可注入
ambiguous       → 多候选，需要用户选择（交互动作）
need-acquisition→ 数据不存在，需要获取动作
not-found       → 本层无能为力 → 该指代放弃，不阻塞其他指代
```

授权检查在调用数据源前执行：L0 直接调；L1 查授权清单，命中则调；L2 每次先弹确认；L3 直接进获取动作流程。

### 4.4 获取动作

**职责**：为 `need-acquisition` 的指代生成获取规格，由宿主适配器执行。

获取规格按数据类型分派：

| 缺失类型 | 桌面动作 | 终端降级动作 |
|---|---|---|
| image | 相册/截图选择对话框 | `osascript choose file`（macOS）/ 提示输入路径 |
| file | 文件选择对话框 | 同上 |
| 多候选 | 候选选择器 | 宿主选择对话框（pi: `ctx.ui.select`） |
| number/string | 定向输入框 | 宿主输入对话框（pi: `ctx.ui.input`） |

**触发纪律（安全红线）**：获取动作只允许在"话语含显式悬空指代且数据缺失"时触发，且触发前必须有一次轻量确认。禁止预测型触发。

### 4.5 组装器 enrich

**职责**：把解析结果组装成注入物。

- 输出 `context`（结构化注入文本，格式见 3.3 示例）和可选 `attachments`（图片等二进制附件走宿主的图片通道，不塞文本）
- 注入必须带标注头 `[潜意识引擎·已解析]`，且在宿主支持时对用户可见（透明性原则：用户能看到注入了什么）
- 只注入已解析项；未解析指代原样保留，交给大模型按现状处理

---

## 5. 授权模型

### 5.1 四级授权

对齐移动 OS 权限模型的惯例：

| 级别 | 名称 | 例子 | 行为 |
|---|---|---|---|
| L0 | 免授权 | cwd、git status、公开编辑器状态 | 直接获取 |
| L1 | 授权一次 | 剪贴板、相册目录、位置 | 首次弹确认，授权后持久化，可随时撤销 |
| L2 | 每次确认 | 相机、麦克风、敏感目录 | 每次获取前弹确认 |
| L3 | 交互产生 | 任何"数据尚不存在"的获取动作 | 每次都是用户交互 |

### 5.2 授权清单

- 位置：`~/.subconscious/grants.json`（与宿主无关的全局位置；宿主适配器只读不写）
- 内容：`{ sourceId, scope, grantedAt, expiresAt? }` 数组
- 提供撤销命令与过期语义；L2 永不落盘

### 5.3 fail-open 原则

**任何环节失败（检测器抛错、数据源超时、授权被拒、适配器异常）都不阻塞用户 prompt 的正常发出**。潜意识引擎的故障必须表现为"它没生效"，绝不能表现为"agent 不能用了"。适配器层用 try/catch 包裹整个 enrich 流程并设总超时（默认 3s，超时放弃注入）。

---

## 6. API 设计（core 公共接口草案）

```typescript
// ---------- 类型 ----------

/** 期望数据类型（封闭集，新增需评审） */
type DataType =
  | "file" | "code-symbol" | "image"
  | "history-event" | "history-content"
  | "data-record" | "person" | "number" | "text";

/** 授权级别 */
type PermissionLevel = "L0-free" | "L1-grant-once" | "L2-confirm-each" | "L3-acquire";

/** 悬空指代（检测器输出） */
interface DanglingRef {
  id: string;
  span: [start: number, end: number];  // 原文中的位置
  text: string;                        // "这个函数"
  expectedType: DataType;
  confidence: number;                  // 0-1，低于阈值不进入解析
}

/** 解析四态 */
type Resolution =
  | { status: "resolved"; value: ResolvedValue; display: string }
  | { status: "ambiguous"; candidates: Array<{ id: string; label: string }> }
  | { status: "need-acquisition"; acquisition: AcquisitionSpec }
  | { status: "not-found" };

interface ResolvedValue {
  type: DataType;
  /** 类型化的值：文件路径、会话 id、diff 文本、图片引用等 */
  value: unknown;
}

/** 获取动作规格（由宿主适配器执行） */
interface AcquisitionSpec {
  kind: "pick-file" | "pick-image" | "pick-candidate" | "input";
  prompt: string;                      // 给用户看的确认文案
  candidates?: Array<{ id: string; label: string }>;  // pick-candidate 用
  expectedType: DataType;
}

/** 注入结果 */
interface EnrichOutput {
  context?: string;                    // 注入文本
  attachments?: ImageLike[];           // 图片附件（走宿主图片通道）
  resolvedRefs: Array<{ refId: string; display: string }>;  // 供 UI 展示
  droppedRefs: string[];               // 放弃的指代 id（透明性）
}

// ---------- 数据源 ----------

interface DataSource {
  id: string;
  types: DataType[];
  permission: PermissionLevel;
  /** 环境快照由适配器在会话开始时构建并传入 */
  resolve(ref: DanglingRef, env: HostEnv): Promise<Resolution>;
}

/** 宿主环境快照：core 唯一感知宿主的方式 */
interface HostEnv {
  cwd: string;
  activeEditor?: { path: string; line?: number; selection?: string };
  recentSessions?: Array<{ id: string; title: string; at: string }>;
  readSessionContent?: (sessionId: string) => Promise<string>;
  // 按 M2/M3 需要扩展
}

// ---------- 主入口（纯函数风格） ----------

interface EngineOptions {
  detector?: Detector;                 // 默认规则版
  sources: DataSource[];
  grants: GrantStore;                  // 授权清单读写接口
  interact: InteractPort;              // 确认/选择/获取动作的宿主实现（可降级）
  timeoutMs?: number;                  // 总超时，默认 3000
}

/** InteractPort：交互能力抽象。宿主按能力实现，未实现的方法返回 "unsupported" */
interface InteractPort {
  confirm(prompt: string): Promise<"yes" | "no" | "unsupported">;
  select(title: string, options: string[]): Promise<string | null | "unsupported">;
  acquire(spec: AcquisitionSpec): Promise<ResolvedValue | null | "unsupported">;
}

function createEngine(options: EngineOptions): {
  /** 主流程：输入原话，输出注入物。绝不抛出（内部消化），超时返回空 */
  enrich(prompt: string): Promise<EnrichOutput>;
};
```

设计要点：

- `HostEnv` 是 core 与宿主之间**唯一**的耦合面，由适配器构建快照传入，core 不主动调用宿主 API
- `InteractPort` 显式建模"宿主没有这个交互能力"，返回 `"unsupported"` 时走降级路径而不是报错
- `enrich()` 永不抛出，保证 fail-open 可在适配器层一行实现

---

## 7. 宿主适配器

### 7.1 适配器契约

所有适配器必须满足：

1. 在宿主的 prompt 前置插入点调用 `engine.enrich(prompt)`
2. 把 `EnrichOutput` 按宿主机制注入（附加消息 / 上下文追加 / 附件）
3. 整个调用包 try/catch + 超时，异常时原样透传
4. 构建 `HostEnv` 快照（会话开始时 + 每次调用前增量更新）
5. 实现 `InteractPort`（按宿主能力，允许部分 `unsupported`）

### 7.2 pi 适配器（首个交付，M1）

- 形式：pi 扩展（TypeScript，放 `~/.pi/agent/extensions/` 或打包为 Pi Package）
- 插入点：`pi.on("before_agent_start", ...)`——用户提交 prompt 后、agent 循环前触发，`event.prompt` / `event.images` 可读
- 注入方式：handler 返回 `{ message: { customType: "subconscious", content, display: true } }`（持久化进会话、发给 LLM、用户可见）
- 交互实现：`ctx.ui.confirm` / `ctx.ui.select` / `ctx.ui.input` 直接映射到 `InteractPort`
- 获取动作：macOS 终端下 `osascript -e 'choose file'` 弹系统文件选择框；图片读文件后 base64 走 pi 的 `images` 附件通道
- 环境快照：cwd 从扩展上下文取；recentSessions 读 pi 的 sessions 目录

### 7.3 Claude Code 适配器（M4）

- 插入点：hooks 的 `UserPromptSubmit`（可向 prompt 追加上下文）
- **降级说明**：hook 是子进程 JSON 协议，无对话式 UI。`InteractPort.confirm/select` 返回 `unsupported`：
  - ambiguous → 退化为把候选列表注入，让大模型问用户（等同现状，不劣化）
  - need-acquisition → 注入"需要文件路径"的提示，或放弃
- 只服务 L0 数据源 + resolved 态，交互层基本不可用，这是预期内的降级

### 7.4 OpenCode 适配器（M4）

- 插入点：plugin API 的事件总线
- 交互能力介于 pi 与 Claude Code 之间，按实际 API 情况实现 InteractPort

---

## 8. 失败处理与降级矩阵

### 8.1 解析层

| 情况 | 行为 |
|---|---|
| 检测器无命中 | no-op，零开销透传 |
| 单个指代 not-found | 该指代放弃，其余继续 |
| 所有指代失败 | 等同 no-op |
| 检测器/数据源抛错 | 吞掉（记日志），透传 |
| 总超时（默认 3s） | 放弃未完成项，用已完成部分注入 |

### 8.2 交互层降级矩阵

| 能力 | pi | Claude Code | OpenCode |
|---|---|---|---|
| confirm（L2 确认） | 原生 | unsupported → 跳过该数据源 | 待定 |
| select（候选消歧） | 原生 | unsupported → 注入候选让 LLM 问 | 待定 |
| acquire（获取动作） | 系统对话框 | unsupported → 注入提示 | 待定 |

降级原则：交互不可用时，对应能力跳过，**永不让用户卡住**。

---

## 9. 仓库结构与工程约定

```
subconscious-engine/
  packages/
    core/               # 纯 TS 库：检测器、注册表、解析、组装、授权（零宿主依赖）
    adapter-pi/         # pi 扩展（薄壳）
    adapter-claude/     # Claude Code hooks 适配（M4）
    adapter-opencode/   # OpenCode plugin 适配（M4）
  docs/
    DESIGN.md           # 本文档
```

约定：

- Node >= 22，TypeScript，严格模式，禁 `any`（对齐团队习惯）
- core 不允许 import 任何 `adapter-*` 或宿主包（CI 加依赖方向检查）
- core 单元测试不依赖网络与真实宿主，`HostEnv` / `InteractPort` 全部可 mock
- 版本：core 独立语义化版本；适配器跟随 core 兼容范围
- 不 fork 任何宿主 agent。若宿主缺能力，向宿主上游提最小化 PR，产品代码留在本仓库

---

## 10. 里程碑

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| M1 | core 骨架（类型 + 规则检测器 + 注册表 + 解析 + enrich）+ pi 适配器 + 3 个 L0 数据源（cwd-context / recent-sessions / session-content） | 在 pi 里说"参考上次的修改改这个文件"，零反问完成；说无指代的话，行为与裸 pi 完全一致 |
| M2 | InteractPort 全量 pi 实现（confirm/select/input/acquire）+ 授权清单持久化 + clipboard(L1) 数据源 | "这是什么花？" → 确认 → 选图 → 带图发给大模型，全链路 ≤ 2 次用户点击 |
| M3 | 检测器升级 embedding 版；多指代并行解析；超时与降级矩阵完善 | 规则外的表述（"照老规矩"）可被识别；全链路超时可控 |
| M4 | Claude Code / OpenCode 适配器 | 同一 core，两个新宿主可用（交互按降级矩阵） |
| M5+ | 移动端形态评估（安卓 Termux 宿主 / 远程瘦客户端） | 另立设计文档 |

---

## 11. 非目标（明确排除）

1. **不做意图路由与本地应答**：命中什么都在组装后交大模型，不替代大模型回答（见 2.2，这是本项目与路由器的本质区别）
2. **不做开放域指代消解**：只处理封闭类型集上的显式指代，不追求理解任意表述
3. **不做预测型注入**：只解析用户说出口的指代，不猜用户没说的需求
4. **第一版不做移动端**：PC 先行
5. **不 fork / 不修改任何宿主 agent 内核**
6. **不内置小模型服务**：M3 的分类器是进程内库（onnx/transformers.js 级别），不做本地推理服务

---

## 12. 风险与开放问题

### 12.1 已识别风险

| 风险 | 缓解 |
|---|---|
| 误解析注入错误数据 → 诱导大模型幻觉 | 注入物带来源标注；低置信不注入；注入对用户可见可关闭 |
| 注入膨胀污染上下文 | 只注入已解析指代；附件走图片通道不占文本；display 可审计 |
| 隐私：本地数据被自动外发给云端大模型 | 授权分级 + L1/L2 门槛 + 授权清单可撤销；默认只有 L0 参与 |
| 获取动作误触发（弹窗骚扰） | 触发纪律（4.4）：显式悬空指代 + 前置确认，禁止预测型触发 |
| 规则检测器漏检/误检 | 漏检 = 退化为现状（无害）；误检由置信度阈值 + 注入可见性兜底 |

### 12.2 开放问题（待开发前决策）

1. `active-editor` 数据源在纯终端 pi 下如何取值（pi 无编辑器概念时用"最近 read/edit 的文件"近似？）——M1 实现时定
2. 注入文本格式是否需要按宿主的 system prompt 风格定制（Claude Code 追加式 vs pi 消息式）——各适配器实现时定
3. 授权清单是否需要按"数据源 × 目录范围"细粒度 scope——M2 实现时定
4. embedding 分类器的训练数据从哪来（自建标注集 vs 复用公开指代消解数据集）——M3 前定
5. `HostEnv.recentSessions` 的摘要如何生成（标题截断 vs LLM 摘要 vs 不摘要只给元数据）——M1 实现时定

---

## 13. 参考资料

- pi 扩展 API（`before_agent_start`、`ctx.ui`）：https://github.com/earendil-works/pi-mono `packages/coding-agent/docs/extensions.md`
- pi RPC 模式与扩展 UI 协议：同仓库 `docs/rpc.md`
- Apple Intelligence 端上个人上下文（同类思想的产品化参照）
- query rewriting / auto-attach context（RAG 领域同类技术）
- Claude Code hooks（`UserPromptSubmit`）：https://docs.claude.com/en/docs/claude-code/hooks
