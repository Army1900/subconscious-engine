import { assemble, type DroppedItem, type ResolvedItem } from "./assembler.js";
import { createRuleDetector, isAsyncDetector } from "./detector.js";
import { createDeadlineClock, type DeadlineClock } from "./clock.js";
import { EngineConfigError, errorMessage } from "./errors.js";
import { guardInteract, UNSUPPORTED_INTERACT, type GuardedInteract } from "./interact.js";
import { InMemoryGrantStore } from "./grants.js";
import { autoResolvePriorCandidate, disambiguationWeights, rankByPrior } from "./memory.js";
import { DataSourceRegistry, isDataType } from "./registry.js";
import { isNonEmptyString, uniquifyLabels } from "./text.js";
import { createSystemTimer } from "./timer.js";
import type {
  AcquisitionSpec,
  Candidate,
  DanglingRef,
  DataType,
  DataSource,
  Detector,
  DisambiguationPrior,
  DropReason,
  EngineLimits,
  EngineOptions,
  EnrichOutput,
  GrantStore,
  HostEnv,
  InteractPort,
  Logger,
  MemoryStore,
  Resolution,
  ResolveContext,
  ResolvedValue,
  SessionRef,
  SubconsciousEngine,
  Timer,
} from "./types.js";
import { DEFAULT_ENGINE_LIMITS } from "./types.js";

/** 单指代解析结果：resolved 与 dropped 二选一 */
interface RefOutcome {
  readonly ref: DanglingRef;
  readonly resolved?: ResolvedItem;
  readonly dropped?: DroppedItem;
}

// ---------------------------------------------------------------------------
// 运行时形状校验（数据源/交互端口可能来自 JS，四态与值形状必须受控；非法按 not-found/error）
// ---------------------------------------------------------------------------

const RESOLVED_VALUE_TYPES: Readonly<Record<string, readonly string[]>> = {
  file: ["path"],
  "code-symbol": ["path"],
  image: ["path", "mediaType", "base64"],
  project: ["cwd"],
  "history-event": ["sessionId", "title", "at"],
  "history-content": ["sessionId", "diff"],
  "data-record": ["recordId"],
  person: ["name"],
  number: ["value"],
  text: ["text"],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function hasStringFields(v: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((f) => typeof v[f] === "string");
}

export function isValidResolvedValue(v: unknown): v is ResolvedValue {
  if (!isRecord(v) || typeof v.type !== "string") return false;
  const required = RESOLVED_VALUE_TYPES[v.type];
  if (required === undefined) return false;
  if (!hasStringFields(v, required)) return false;
  if (v.type === "number" && typeof v.value !== "number") return false;
  return true;
}

function isValidCandidate(c: unknown, expectedType: DataType): c is Candidate {
  // 候选值类型必须与指代期望类型一致（监督整改 4）：file 指代的候选不得是 person 等异类型值
  return (
    isRecord(c) &&
    isNonEmptyString(c.id) &&
    isValidResolvedValue(c.value) &&
    c.value.type === expectedType
  );
}

/**
 * 四态载荷运行时形状校验 + 值类型一致性校验（监督整改 4）：
 * resolved 值 / 候选值 / acquisition spec 的类型必须与 ref.expectedType 一致，
 * 否则该解析整体非法（按 not-found 受控丢弃），防止错误类型值借道注入。
 */
function validateResolution(res: unknown, expectedType: DataType): Resolution | null {
  if (!isRecord(res)) return null;
  switch (res.status) {
    case "resolved": {
      if (!isValidResolvedValue(res.value)) return null;
      if (res.value.type !== expectedType) return null;
      if (res.display !== undefined && typeof res.display !== "string") return null;
      return { status: "resolved", value: res.value, display: typeof res.display === "string" ? res.display : "" };
    }
    case "ambiguous": {
      if (!Array.isArray(res.candidates)) return null;
      const candidates: Candidate[] = [];
      for (const c of res.candidates) {
        if (isValidCandidate(c, expectedType)) {
          candidates.push({
            id: c.id,
            label: typeof c.label === "string" && c.label !== "" ? c.label : c.id,
            value: c.value,
          });
        }
      }
      if (candidates.length === 0) return null;
      return { status: "ambiguous", candidates };
    }
    case "need-acquisition": {
      const spec = res.acquisition;
      if (!isRecord(spec)) return null;
      const kinds: readonly string[] = ["pick-file", "pick-image", "pick-candidate", "input"];
      if (typeof spec.kind !== "string" || !kinds.includes(spec.kind)) return null;
      if (typeof spec.prompt !== "string") return null;
      if (!isDataType(spec.expectedType)) return null;
      if (spec.expectedType !== expectedType) return null; // 获取规格也不得指鹿为马
      const candidates = Array.isArray(spec.candidates)
        ? spec.candidates.filter((c) => isValidCandidate(c, expectedType))
        : undefined;
      if (Array.isArray(spec.candidates) && candidates !== undefined && candidates.length === 0) return null;
      return {
        status: "need-acquisition",
        acquisition: {
          kind: spec.kind as AcquisitionSpec["kind"],
          prompt: spec.prompt,
          ...(candidates !== undefined ? { candidates } : {}),
          expectedType: spec.expectedType,
        },
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 预算 race：截止获胜后丢弃迟到值，且迟到失败不产生未处理 rejection（D3.3）。
// 源先完成时移除 abort 监听器（监督整改：长会话多次 enrich 不累积监听器）。
// ---------------------------------------------------------------------------

export const DEADLINE: unique symbol = Symbol("subconscious-deadline");

export async function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof DEADLINE> {
  const guarded = promise.then(
    (v) => v,
    (err: unknown) => {
      throw err;
    },
  );
  guarded.catch(() => {}); // 标记已处理：race 落败后的迟到 rejection 不再外溢
  if (signal.aborted) return DEADLINE;
  return new Promise<T | typeof DEADLINE>((resolve, reject) => {
    const onAbort = (): void => resolve(DEADLINE);
    signal.addEventListener("abort", onAbort, { once: true });
    guarded.then(
      (v) => {
        signal.removeEventListener("abort", onAbort); // 源先成功：摘掉监听器
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort); // 源先失败：同样摘掉，rejection 正常传播
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// limits 构造期校验（监督整改 5）：负 timeout / NaN / 超界置信度会在运行期
// 绕过超时与置信度纪律，必须在 createEngine 受控失败。
// ---------------------------------------------------------------------------

const POSITIVE_INTEGER_LIMIT_FIELDS: readonly (keyof EngineLimits)[] = [
  "timeoutMs",
  "interactTimeoutMs",
  "maxContextChars",
  "maxSourceBytes",
  "maxListItems",
  "maxCandidates",
  "maxDiffSnippetChars",
  "maxDiffEntries",
  "maxDiffChars",
  "maxRefDisplayChars",
];

function validateLimits(limits: EngineLimits): void {
  for (const field of POSITIVE_INTEGER_LIMIT_FIELDS) {
    const v: unknown = limits[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new EngineConfigError("invalid-limits", `limits.${field} 必须是正整数（得到 ${JSON.stringify(v)}）`);
    }
  }
  const mc: unknown = limits.minConfidence;
  if (typeof mc !== "number" || !Number.isFinite(mc) || mc < 0 || mc > 1) {
    throw new EngineConfigError("invalid-limits", `limits.minConfidence 必须是 0..1 的有限数（得到 ${JSON.stringify(mc)}）`);
  }
}

// ---------------------------------------------------------------------------
// createEngine
// ---------------------------------------------------------------------------

export function createEngine(options: EngineOptions): SubconsciousEngine {
  const limits: EngineLimits = { ...DEFAULT_ENGINE_LIMITS, ...options.limits };
  validateLimits(limits);
  const timer: Timer = options.timer ?? createSystemTimer();
  const logger: Logger = options.logger ?? ((): void => {});
  const detector: Detector = options.detector ?? createRuleDetector();
  const grants: GrantStore = options.grants ?? new InMemoryGrantStore();
  const interactPort: InteractPort = options.interact ?? UNSUPPORTED_INTERACT;
  // 个人记忆层（M5a）：缺省无记忆——不学习、不加权，行为与无此层逐字节一致
  const memory: MemoryStore | undefined = options.memory;

  // 注册表在构造期受控失败（重复 id / 未知类型 / 非法声明）；enrich 永不抛出
  const registry = new DataSourceRegistry();
  for (const source of options.sources) {
    registry.register(source);
  }

  const emptyOutput = (): EnrichOutput => ({ resolvedRefs: [], droppedRefs: [], dropReasons: {} });

  return {
    async enrich(prompt: string, env: HostEnv): Promise<EnrichOutput> {
      // fail-open 总闸：内部一切异常都不阻塞 prompt 发出（DESIGN §5.3）
      try {
        return await runEnrich(prompt, env, { limits, timer, logger, detector, grants, interactPort, registry, memory });
      } catch (err) {
        logger({ level: "error", event: "enrich-failed", detail: errorMessage(err) });
        return emptyOutput();
      }
    },
  };
}

interface RunContext {
  limits: EngineLimits;
  timer: Timer;
  logger: Logger;
  detector: Detector;
  grants: GrantStore;
  interactPort: InteractPort;
  registry: DataSourceRegistry;
  memory: MemoryStore | undefined;
}

async function runEnrich(prompt: string, env: HostEnv, run: RunContext): Promise<EnrichOutput> {
  const { limits, logger } = run;
  if (typeof prompt !== "string") return { resolvedRefs: [], droppedRefs: [], dropReasons: {} };
  if (!isRecord(env)) {
    logger({ level: "warn", event: "invalid-env", detail: "env 必须是对象" });
    return { resolvedRefs: [], droppedRefs: [], dropReasons: {} };
  }

  // --- 检测（异常吞掉 → no-op）---
  // M3：异步增强检测器（AsyncDetector）的 detectAsync 在机器预算内运行，检测与解析共享
  // 同一时钟（D3 单预算纪律，检测耗时不给解析翻新预算）；任何失败/超时回退其同步
  // detect()（EmbeddingDetector 的同步契约即规则结果），fail-open 不变。
  let detected: readonly DanglingRef[] | null = null;
  let pendingClock: DeadlineClock | null = null;
  const asyncDetector = isAsyncDetector(run.detector) ? run.detector : null;
  if (asyncDetector !== null) {
    const detClock = createDeadlineClock(limits.timeoutMs, run.timer);
    pendingClock = detClock;
    try {
      const outcome = await withDeadline(
        Promise.resolve().then(() =>
          asyncDetector.detectAsync(prompt, { signal: detClock.signal, remainingMs: () => detClock.remainingMs() }),
        ),
        detClock.signal,
      );
      detected = outcome === DEADLINE ? null : outcome;
    } catch (err) {
      logger({ level: "warn", event: "detector-async-error", detail: errorMessage(err) });
      detected = null;
    }
    if (detected === null) detected = safeDetectRefs(asyncDetector, prompt, logger); // 回退同步契约
  } else {
    try {
      const result = run.detector.detect(prompt);
      detected = Array.isArray(result) ? result : [];
    } catch (err) {
      logger({ level: "warn", event: "detector-error", detail: errorMessage(err) });
      return { resolvedRefs: [], droppedRefs: [], dropReasons: {} };
    }
  }

  // --- 引擎统一重编 id（防自定义检测器 id 缺失/重复），并强制 span 与原文一致 ---
  const active: DanglingRef[] = [];
  const dropped: DroppedItem[] = [];
  let seq = 0;
  for (const raw of detected) {
    if (!isValidRef(raw, prompt)) {
      logger({ level: "warn", event: "invalid-ref", detail: "检测器输出形状或 span 非法，已跳过" });
      continue;
    }
    seq += 1;
    const ref: DanglingRef = { ...raw, id: `ref-${seq}` };
    if (ref.confidence < limits.minConfidence) {
      dropped.push({ refId: ref.id, reason: "low-confidence" });
    } else {
      active.push(ref);
    }
  }

  // 无指代 → no-op 透传：零数据源 / 零授权 / 零交互调用（监督红线）
  if (active.length === 0) {
    pendingClock?.dispose(); // 异步路径已建的时钟同样清理（句柄纪律）
    return assemble([], dropped, { limits, logger });
  }

  const clock = pendingClock ?? createDeadlineClock(limits.timeoutMs, run.timer);
  try {
    const interact = guardInteract(run.interactPort, {
      signal: clock.signal,
      interactTimeoutMs: limits.interactTimeoutMs,
      timer: run.timer,
      logger,
    });

    const makeCtx = (boundSession?: SessionRef): ResolveContext => ({
      signal: clock.signal,
      remainingMs: () => clock.remainingMs(),
      limits,
      ...(boundSession !== undefined ? { boundSession } : {}),
    });

    // --- 两波解析（D4）：wave 1 非历史内容（并行独立），wave 2 历史内容等待绑定 ---
    const wave1 = active.filter((r) => r.expectedType !== "history-content");
    const wave2 = active.filter((r) => r.expectedType === "history-content");

    const outcomes1 = await Promise.all(
      wave1.map(async (ref) => resolveRef(ref, env, makeCtx(), { clock, interact, run })),
    );

    // 绑定 = wave 1 中最后一个 resolved 的 history-event 稳定 sessionId（按指代顺序，D4.1）
    let binding: SessionRef | undefined;
    for (const outcome of outcomes1) {
      const value = outcome.resolved?.value;
      if (value !== undefined && value.type === "history-event") {
        binding = {
          id: value.sessionId,
          ...(value.path !== undefined ? { path: value.path } : {}),
          ...(value.title !== undefined ? { title: value.title } : {}),
        };
      }
    }

    let outcomes2: readonly RefOutcome[] = [];
    if (wave2.length > 0) {
      if (binding === undefined || clock.expired()) {
        // 无绑定不调用、不注入（D4.2）；预算耗尽同样不再触发任何源/交互（D3.2）。
        // 原因取根因：预算耗尽优先于无绑定（wave 1 因超时而无法建立绑定时）。
        const reason: DropReason = clock.expired() ? "budget-exhausted" : "no-binding";
        outcomes2 = wave2.map((ref) => ({ ref, dropped: { refId: ref.id, reason } }));
      } else {
        outcomes2 = await Promise.all(
          wave2.map(async (ref) => resolveRef(ref, env, makeCtx(binding), { clock, interact, run })),
        );
      }
    }

    const resolvedItems: ResolvedItem[] = [];
    const allDropped: DroppedItem[] = [...dropped];
    for (const outcome of [...outcomes1, ...outcomes2]) {
      if (outcome.resolved !== undefined) resolvedItems.push(outcome.resolved);
      if (outcome.dropped !== undefined) allDropped.push(outcome.dropped);
    }

    const output = assemble(resolvedItems, allDropped, { limits, logger });
    output.timedOut = clock.expired();
    return output;
  } finally {
    // enrich 返回前统一 abort：关闭仍在等待的交互；之后迟到回调只能看到已中止信号（D3.3）
    clock.dispose();
  }
}

/** 异步检测失败后的同步回退（AsyncDetector 契约：detect 恒可用）；再失败按零指代处理 */
function safeDetectRefs(detector: Detector, prompt: string, logger: Logger): readonly DanglingRef[] {
  try {
    const result = detector.detect(prompt);
    return Array.isArray(result) ? result : [];
  } catch (err) {
    logger({ level: "warn", event: "detector-fallback-error", detail: errorMessage(err) });
    return [];
  }
}

function isValidRef(ref: unknown, prompt: string): ref is DanglingRef {
  if (!isRecord(ref)) return false;
  if (typeof ref.id !== "string") return false;
  if (typeof ref.text !== "string") return false;
  if (typeof ref.expectedType !== "string" || !isDataType(ref.expectedType)) return false;
  if (typeof ref.confidence !== "number" || !Number.isFinite(ref.confidence)) return false;
  const span = ref.span;
  if (!Array.isArray(span) || span.length !== 2) return false;
  const [start, end] = span as [unknown, unknown];
  if (typeof start !== "number" || typeof end !== "number") return false;
  if (!(start >= 0 && end > start && end <= prompt.length)) return false;
  // span 与原文真实一致（监督红线：显式指代、置信度、span 必须真实一致）
  return prompt.slice(start, end) === ref.text;
}

// ---------------------------------------------------------------------------
// 单指代解析（永不抛出）
// ---------------------------------------------------------------------------

interface ResolveRefDeps {
  readonly clock: DeadlineClock;
  readonly interact: GuardedInteract;
  readonly run: RunContext;
}

/**
 * 单指代解析（永不抛出）。多源策略（监督整改 3，D13）：同一类型可注册多个源，
 * 按注册顺序逐个尝试，每个源在调用前单独过权限检查：
 * - not-found / 非法形状 / 源抛错 / interaction-unsupported → 继续后源（fail-open，
 *   单源错误不损失同类型其他可用源；unsupported 是环境限制而非用户拒绝，且不构成权限提升）；
 * - 权限拒绝 / 用户取消 / 获取拒绝 → 立即停止（用户明确决定优先于 fail-open，
 *   就同一条指代再询问下一个源会构成对拒绝的绕过）；
 * - budget-exhausted → 停止（预算红线，D3.2）；
 * - resolved → 短路返回，后源不再被调用。
 * 链耗尽时的丢弃原因取最后一个尝试源的结局（确定性）。
 */
async function resolveRef(ref: DanglingRef, env: HostEnv, ctx: ResolveContext, deps: ResolveRefDeps): Promise<RefOutcome> {
  const { clock, interact, run } = deps;
  const { logger } = run;
  const drop = (reason: DropReason): RefOutcome => ({ ref, dropped: { refId: ref.id, reason } });

  if (clock.expired()) return drop("budget-exhausted");

  const sources = run.registry.findByType(ref.expectedType);
  if (sources.length === 0) return drop("no-source");

  let lastReason: DropReason = "not-found";
  for (const source of sources) {
    if (clock.expired()) return drop("budget-exhausted");

    // 授权门在读取之前，且每个源单独过闸（监督红线：授权在读取前检查）
    const gate = await checkPermission(source, { clock, interact, run });
    if (gate === "interaction-unsupported") {
      // 环境限制（无 UI）：本源无法完成授权，但后源可能是 L0 / 已授权，继续尝试
      lastReason = gate;
      continue;
    }
    if (gate !== "allowed") return drop(gate); // 用户拒绝：停止，不用后源绕过

    // 交互后再次检查：截止后禁止数据源副作用（D3.2）
    if (clock.expired()) return drop("budget-exhausted");

    let outcome: Resolution | null | typeof DEADLINE;
    try {
      const raw = await withDeadline(
        Promise.resolve().then(() => source.resolve(ref, env, ctx)),
        clock.signal,
      );
      outcome = raw === DEADLINE ? DEADLINE : validateResolution(raw, ref.expectedType);
    } catch (err) {
      logger({ level: "warn", event: "source-error", refId: ref.id, sourceId: source.id, detail: errorMessage(err) });
      lastReason = "error"; // 单源故障不损失其他源（fail-open），继续后源
      continue;
    }
    if (outcome === DEADLINE) return drop("budget-exhausted");
    if (outcome === null) {
      logger({ level: "warn", event: "invalid-resolution", refId: ref.id, sourceId: source.id });
      lastReason = "not-found"; // 非法四态/载荷/值类型：受控按 not-found，继续后源
      continue;
    }

    switch (outcome.status) {
      case "resolved":
        return {
          ref,
          resolved: { ref, value: outcome.value, display: outcome.display, sourceId: source.id },
        };
      case "not-found":
        lastReason = "not-found";
        continue;
      case "ambiguous": {
        const result = await resolveAmbiguous(ref, outcome.candidates, source.id, env, deps);
        if (result.resolved !== undefined) return result;
        const reason = result.dropped?.reason;
        if (reason === "interaction-unsupported") {
          lastReason = reason; // 选择器不可用：环境限制，后源可能直接解析
          continue;
        }
        return result; // 用户取消 / 预算耗尽等：停止链
      }
      case "need-acquisition": {
        const result = await resolveAcquisition(ref, outcome.acquisition, source.id, deps);
        if (result.resolved !== undefined) return result;
        const reason = result.dropped?.reason;
        if (reason === "interaction-unsupported") {
          lastReason = reason; // confirm/acquire 不可用：环境限制，继续后源
          continue;
        }
        return result; // 用户拒绝获取 / 取消 / 预算耗尽 / 获取值非法：停止链
      }
    }
  }
  return drop(lastReason);
}

/** 用户交互期间冻结机器预算（D3.1 双时钟） */
async function runInteraction<T>(clock: DeadlineClock, fn: () => Promise<T>): Promise<T> {
  clock.pause();
  try {
    return await fn();
  } finally {
    clock.resume();
  }
}

type PermissionOutcome = "allowed" | DropReason;

async function checkPermission(source: DataSource, deps: ResolveRefDeps): Promise<PermissionOutcome> {
  const { clock, interact, run } = deps;
  const { logger } = run;
  switch (source.permission) {
    case "L0-free":
    case "L3-acquire":
      return "allowed"; // L3 的确认纪律在获取动作流程（resolveAcquisition）
    case "L1-grant-once": {
      let granted = false;
      try {
        granted = await run.grants.has({ sourceId: source.id, ...(source.grantScope === undefined ? {} : { scope: source.grantScope }) });
      } catch (err) {
        logger({ level: "warn", event: "grant-check-failed", sourceId: source.id, detail: errorMessage(err) });
      }
      if (granted) return "allowed";
      const answer = await runInteraction(clock, () =>
        interact.confirm(`允许潜意识引擎读取数据源「${source.id}」？`),
      );
      if (answer === "yes") {
        // 迟到回调不得写 grants（D3.3）：写之前检查引擎信号
        if (clock.signal.aborted) return "budget-exhausted";
        try {
          await run.grants.grant({ sourceId: source.id, ...(source.grantScope === undefined ? {} : { scope: source.grantScope }) });
        } catch (err) {
          logger({ level: "warn", event: "grant-write-failed", sourceId: source.id, detail: errorMessage(err) });
        }
        return "allowed";
      }
      return answer === "unsupported" ? "interaction-unsupported" : "permission-denied";
    }
    case "L2-confirm-each": {
      const answer = await runInteraction(clock, () =>
        interact.confirm(`本次允许潜意识引擎读取数据源「${source.id}」？（每次都需确认）`),
      );
      if (answer === "yes") return "allowed"; // L2 永不落盘
      return answer === "unsupported" ? "interaction-unsupported" : "permission-denied";
    }
  }
}

/** 自动代选标注（透明性：display 可审计——这是按用户常用选择代选，非用户本次亲选） */
const PRIOR_AUTO_DISPLAY_SUFFIX = "（按你的常用选择）";

async function resolveAmbiguous(
  ref: DanglingRef,
  candidates: readonly Candidate[],
  sourceId: string,
  env: HostEnv,
  deps: ResolveRefDeps,
): Promise<RefOutcome> {
  const { clock, interact, run } = deps;
  const drop = (reason: DropReason): RefOutcome => ({ ref, dropped: { refId: ref.id, reason } });
  const capped = candidates.slice(0, run.limits.maxCandidates);
  if (capped.length === 0) return drop("not-found");
  if (clock.expired()) return drop("budget-exhausted");

  // --- 消歧先验（M5a）：只作用于 history-event 消歧的既有候选——
  //     达门槛时代选（display 标注来源），否则加权排序后照旧弹 select（并继续学习）。
  //     先验绝不把用户没提到的会话加进候选（预测注入红线，DESIGN §11.3）。
  let ordered: readonly Candidate[] = capped;
  if (ref.expectedType === "history-event" && run.memory !== undefined) {
    const priors = await loadPriors(run.memory, run.logger);
    if (clock.expired()) return drop("budget-exhausted"); // 预算红线：读取记忆后同样复查（D3.2）
    if (priors !== null) {
      const weights = disambiguationWeights(priors, env.cwd, run.timer.now());
      const auto = autoResolvePriorCandidate(capped, weights);
      if (auto !== null) {
        return {
          ref,
          resolved: {
            ref,
            value: auto.candidate.value,
            display: `${auto.candidate.label}${PRIOR_AUTO_DISPLAY_SUFFIX}`,
            sourceId,
          },
        };
      }
      ordered = rankByPrior(capped, weights);
    }
  }

  // 重复标签仍映射稳定 id：uniquify 保证 label→候选一一对应（监督红线）
  const labels = uniquifyLabels(ordered.map((c) => c.label));
  const picked = await runInteraction(clock, () => interact.select(`请选择「${ref.text}」所指：`, labels));
  if (picked === "unsupported") {
    return drop("interaction-unsupported"); // UI 不可用时不猜测（D5.5）
  }
  if (picked === null) return drop("user-cancelled");
  const index = labels.indexOf(picked);
  if (index < 0 || index >= ordered.length) return drop("user-cancelled");
  const candidate = ordered[index] as Candidate;
  await learnSelection(ref, candidate, env, deps);
  return { ref, resolved: { ref, value: candidate.value, display: candidate.label, sourceId } };
}

/** 读取先验；不可用返回 null（本次无先验，fail-open，行为等同今天） */
async function loadPriors(memory: MemoryStore, logger: Logger): Promise<readonly DisambiguationPrior[] | null> {
  try {
    return await memory.listDisambiguation();
  } catch (err) {
    logger({ level: "warn", event: "memory-read-failed", detail: errorMessage(err) });
    return null;
  }
}

/**
 * 学习：用户在 select 中显式选定历史会话 → 记录先验 {项目、会话 id、标题、时间}。
 * 仅用户亲选时记录（自动代选不记，防自增强）；写失败只记日志（尽力而为）。
 */
async function learnSelection(
  ref: DanglingRef,
  candidate: Candidate,
  env: HostEnv,
  deps: ResolveRefDeps,
): Promise<void> {
  const { clock, run } = deps;
  if (run.memory === undefined || ref.expectedType !== "history-event") return;
  const value = candidate.value;
  if (!isRecord(value) || value.type !== "history-event") return;
  if (clock.signal.aborted) return; // 迟到回调不写记忆（D3.3 同源纪律）
  try {
    await run.memory.recordDisambiguation({
      projectKey: env.cwd,
      sessionId: value.sessionId,
      title: value.title,
      at: new Date(run.timer.now()).toISOString(),
    });
  } catch (err) {
    run.logger({ level: "warn", event: "memory-write-failed", refId: ref.id, detail: errorMessage(err) });
  }
}

async function resolveAcquisition(
  ref: DanglingRef,
  spec: AcquisitionSpec,
  sourceId: string,
  deps: ResolveRefDeps,
): Promise<RefOutcome> {
  const { clock, interact } = deps;
  const drop = (reason: DropReason): RefOutcome => ({ ref, dropped: { refId: ref.id, reason } });

  if (clock.expired()) return drop("budget-exhausted");
  // 获取动作纪律（DESIGN §4.4）：显式悬空指代 + 数据缺失 + 触发前轻量确认
  const confirmed = await runInteraction(clock, () => interact.confirm(`需要补充数据：${spec.prompt}，现在获取？`));
  if (confirmed === "unsupported") return drop("interaction-unsupported");
  if (confirmed !== "yes") return drop("acquisition-declined"); // 拒绝后不再读取
  if (clock.expired()) return drop("budget-exhausted");

  const acquired = await runInteraction(clock, () => interact.acquire(spec));
  if (acquired === "unsupported") return drop("interaction-unsupported");
  if (acquired === null) return drop("acquisition-declined");
  // 获取值同样受类型一致性约束（监督整改 4）：不可信端口不得借 acquire 注入异类型值
  if (!isValidResolvedValue(acquired) || acquired.type !== ref.expectedType) return drop("error");
  return { ref, resolved: { ref, value: acquired, display: spec.prompt, sourceId } };
}
