/**
 * 潜意识引擎 M1 离线演示入口。
 *
 * 【性质声明（诚实边界）】
 * 本演示走的是**真实 adapter / 真实 fixture** 路径，但**不是真人 pi 交互运行**：
 * - 真实调用 @subconscious/adapter-pi 的 createBeforeAgentStartHandler（不 mock、
 *   不替换引擎工厂、不注入假 listSessions——会话列表走真实 SessionManager.list）；
 * - fixture 会话由真实 pi SessionManager 写入 os.tmpdir 下的临时目录，**不触碰 ~/.pi**；
 * - ctx.sessionManager 是真实 SessionManager 实例（SessionManager.open 恢复路径）；
 * - exec 是真实子进程实现；交互端口按真实无 UI 宿主形态配置（hasUI=false，
 *   等价 pi --print/JSON 模式：confirm/select/input/acquire 全部 unsupported）；
 * - 不传 activeEditor——pi 无编辑器概念（D6），file 指代应诚实 dropped；
 * - 真人 pi E2E 属 M1 之外（见 README「M1 限制」），本文件不声称覆盖。
 *
 * 演示场景：上次会话给 retryWrapper 加了错误处理（edit retry.ts / write logger.ts /
 * broken.ts 失败）；本次用户说「参考上次的修改，把这个文件改成一样的错误处理」。
 * 预期：history-event + history-content 解析并注入，file 指代因无编辑器被放弃。
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import { createBeforeAgentStartHandler } from "@subconscious/adapter-pi";
import type { PiBeforeAgentStartEvent, PiHandlerContext } from "@subconscious/adapter-pi";
import { realExec } from "./exec.js";
import { cleanupDemo, makeDemoDirs, openCurrentSession, writeFixtureSession } from "./fixture.js";
import type { DemoDirs, DemoFixtureSession } from "./fixture.js";

/** 演示话语：同时命中 history-event（“上次”）与 history-content（“一样的…”），并含 file 指代（“这个文件”） */
export const DEMO_PROMPT = "参考上次的修改，把这个文件改成一样的错误处理";

/** EnrichOutput 明细经 pi custom message details 透传后的形状（handler.details 为 unknown，此处收窄） */
export interface DemoDetails {
  resolvedRefs: ReadonlyArray<{ refId: string; display: string }>;
  droppedRefs: readonly string[];
  dropReasons?: Readonly<Record<string, string>>;
  timedOut?: boolean;
}

export interface DemoCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/** 会话 JSONL 尾部条目（落盘证据） */
export interface PersistedTail {
  type: string;
  customType?: string;
  content?: string;
}

export interface DemoOutcome {
  dirs: DemoDirs;
  prompt: string;
  fixture: DemoFixtureSession;
  result: BeforeAgentStartEventResult | undefined;
  details: DemoDetails;
  persisted: PersistedTail | undefined;
  checks: readonly DemoCheck[];
  cleanupDone: boolean;
}

export interface DemoOptions {
  /** 缺省 true：结束即删除临时目录。冒烟测试传 false 以便独立读取落盘文件后自行清理。 */
  cleanup?: boolean;
}

function toDetails(raw: unknown): DemoDetails {
  if (raw === null || typeof raw !== "object") return { resolvedRefs: [], droppedRefs: [] };
  const record = raw as Record<string, unknown>;
  const resolved = Array.isArray(record.resolvedRefs)
    ? record.resolvedRefs.filter(
        (item): item is { refId: string; display: string } =>
          item instanceof Object &&
          typeof (item as Record<string, unknown>).refId === "string" &&
          typeof (item as Record<string, unknown>).display === "string",
      )
    : [];
  const dropped = Array.isArray(record.droppedRefs)
    ? record.droppedRefs.filter((item): item is string => typeof item === "string")
    : [];
  const reasons: Record<string, string> = {};
  if (record.dropReasons instanceof Object) {
    for (const [key, value] of Object.entries(record.dropReasons as Record<string, unknown>)) {
      if (typeof value === "string") reasons[key] = value;
    }
  }
  return {
    resolvedRefs: resolved,
    droppedRefs: dropped,
    ...(Object.keys(reasons).length > 0 ? { dropReasons: reasons } : {}),
  };
}

/** 读取会话 JSONL 的最后一个非空行并解析（真实落盘证据） */
async function readTailEntry(file: string): Promise<PersistedTail | undefined> {
  const text = await readFile(file, "utf8");
  const lines = text.trimEnd().split("\n");
  const tail = lines[lines.length - 1];
  if (tail === undefined) return undefined;
  const parsed: unknown = JSON.parse(tail);
  if (parsed instanceof Object && typeof (parsed as Record<string, unknown>).type === "string") {
    const record = parsed as Record<string, unknown>;
    return {
      type: record.type as string,
      ...(typeof record.customType === "string" ? { customType: record.customType } : {}),
      ...(typeof record.content === "string" ? { content: record.content } : {}),
    };
  }
  return undefined;
}

/** 无 UI 宿主的对话框三件套：hasUI=false 下不可达；若被调用说明配置错了，立刻炸出来 */
function unreachableUi(): PiHandlerContext["ui"] {
  const boom =
    (method: string) =>
    (): never => {
      throw new Error(`demo: hasUI=false，对话框 ${method} 不应被调用`);
    };
  return { confirm: boom("confirm"), select: boom("select"), input: boom("input") };
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoOutcome> {
  const cleanup = options.cleanup ?? true;
  const dirs = await makeDemoDirs();
  let fixture: DemoFixtureSession = { id: "", file: "" };
  let result: BeforeAgentStartEventResult | undefined;
  let persisted: PersistedTail | undefined;
  try {
    fixture = await writeFixtureSession(dirs);

    // 「当前会话」：真实恢复路径打开 fixture 会话；作为 ctx.sessionManager（真实宿主对象）
    const current = openCurrentSession(fixture.file, dirs.sessionDir);
    const ctx: PiHandlerContext = {
      cwd: dirs.projectDir,
      sessionManager: current,
      hasUI: false, // 真实无 UI 宿主形态（等价 pi --print/JSON 模式）
      ui: unreachableUi(),
    };

    // 真实 handler：不传 listSessions / createEngineFn / activeEditor——
    // 会话列表用真实 SessionManager.list，引擎用真实 core createEngine，编辑器缺失即缺失（D6）
    const handler = createBeforeAgentStartHandler({ deps: { exec: realExec } });
    const event: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: DEMO_PROMPT };
    result = await handler(event, ctx);

    // pi 宿主消费路径的复刻（agent-session.js：result.message 逐字段转 custom 消息落盘）。
    // M1 注入恒为纯文本（附件通道归 M2）；非 string 即异常形态，不落盘、让自检失败。
    const message = result?.message;
    if (message !== undefined && typeof message.content === "string") {
      current.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      persisted = await readTailEntry(fixture.file);
    }
  } finally {
    if (cleanup) await cleanupDemo(dirs);
  }

  const rawContent = result?.message?.content;
  const content = typeof rawContent === "string" ? rawContent : "";
  const details = toDetails(result?.message?.details);
  const droppedId = details.droppedRefs[0];
  const droppedReason = droppedId !== undefined ? details.dropReasons?.[droppedId] : undefined;
  const checks: DemoCheck[] = [
    {
      name: "history-event 注入",
      pass: content.includes("来源：recent-sessions") && details.resolvedRefs.length >= 1,
      detail: `来源标注“来源：recent-sessions”出现，已解析 ${details.resolvedRefs.length} 个指代`,
    },
    {
      name: "history-content 注入",
      pass: content.includes("来源：session-content") && content.includes("try {} catch (e) { log(e); }"),
      detail: "来源标注“来源：session-content”出现，且含绑定会话 diff（try {} catch (e) { log(e); }）",
    },
    {
      name: "file 指代诚实 dropped（无 active editor）",
      pass:
        details.droppedRefs.length === 1 &&
        droppedReason === "not-found" &&
        !content.includes("来源：active-editor"),
      detail:
        details.droppedRefs.length === 1
          ? `${droppedId} → ${droppedReason ?? "(无原因记录)"}；正文无 active-editor 来源（D6 不猜测当前文件）`
          : `预期放弃 1 个 file 指代，实际 ${details.droppedRefs.length} 个`,
    },
    {
      name: "注入消息按 pi 落盘行为持久化",
      pass: persisted?.type === "custom_message" && persisted.content === content && content !== "",
      detail:
        persisted?.type === "custom_message"
          ? `会话 JSONL 尾部为 custom_message（subconscious），内容与注入一致`
          : "会话 JSONL 尾部未检出 custom_message 行",
    },
  ];
  return { dirs, prompt: DEMO_PROMPT, fixture, result, details, persisted, checks, cleanupDone: cleanup };
}

// ---------------------------------------------------------------------------
// CLI 报告
// ---------------------------------------------------------------------------

function line(char = "─"): string {
  return char.repeat(72);
}

export function printReport(outcome: DemoOutcome): void {
  const { dirs, fixture, result, details, checks, cleanupDone } = outcome;
  console.log(line("═"));
  console.log("潜意识引擎 M1 离线演示（真实 adapter + 真实 SessionManager fixture）");
  console.log(line("═"));
  console.log("【性质声明】fixture 会话由真实 pi SessionManager 写入 os.tmpdir 临时目录，");
  console.log("handler 为 @subconscious/adapter-pi 的真实 createBeforeAgentStartHandler。");
  console.log("这不是真人 pi 交互运行（M1 无真人 pi E2E），全程不触碰 ~/.pi。");
  console.log();
  console.log("[1] fixture 会话（SessionManager.create + appendMessage/appendSessionInfo）");
  console.log(`    临时根目录：${dirs.root}`);
  console.log(`    会话 id：  ${fixture.id}`);
  console.log(`    会话文件：${fixture.file}`);
  console.log("    内容：    edit src/retry.ts（成功）、write src/logger.ts（成功）、edit src/broken.ts（失败）");
  console.log();
  console.log("[2] 用户话语（before_agent_start 事件，无 images / 附件）");
  console.log(`    “${outcome.prompt}”`);
  console.log();
  console.log("[3] handler 返回（pi custom message；display=true，对用户可见）");
  if (result?.message === undefined) {
    console.log("    （undefined——本次运行未产生注入；见下方结论）");
  } else {
    const raw = result.message.content;
    const text = typeof raw === "string" ? raw : "（非文本内容——M1 注入预期为纯文本）";
    console.log("    ── 注入内容 ──");
    for (const lineText of text.split("\n")) console.log(`    ${lineText}`);
    console.log("    ── 明细（details，不进 LLM 上下文，仅供 UI/审计） ──");
    for (const item of details.resolvedRefs) console.log(`    已解析 ${item.refId}：${item.display}`);
    for (const id of details.droppedRefs) {
      console.log(`    已放弃 ${id}：${details.dropReasons?.[id] ?? "(无原因记录)"}`);
    }
  }
  console.log();
  console.log("[4] pi 落盘（复刻 agent-session 消费路径：appendCustomMessageEntry）");
  console.log(
    outcome.persisted?.type === "custom_message"
      ? "    会话 JSONL 尾部已持久化 custom_message（subconscious）行 ✓"
      : "    未检出 custom_message 落盘行 ✗",
  );
  console.log();
  console.log("[5] 结论");
  for (const check of checks) console.log(`    ${check.pass ? "✓" : "✗"} ${check.name} —— ${check.detail}`);
  console.log(cleanupDone ? `    临时目录已清理：${dirs.root}` : `    （本次保留临时目录：${dirs.root}）`);
  console.log(line("═"));
}

export async function main(): Promise<void> {
  const outcome = await runDemo();
  printReport(outcome);
  if (!outcome.checks.every((check) => check.pass)) {
    console.error("demo 自检存在失败项，退出码置 1");
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
