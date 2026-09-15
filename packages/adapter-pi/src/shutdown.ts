/**
 * session_shutdown 处理器（M5c-2 惯例蒸馏接线，DECISIONS D25/D26）。
 *
 * 协议事实（锁定版 @earendil-works/pi-coding-agent@0.85.1，
 * dist/core/extensions/types.d.ts:474-479/916 + .supervision/pi-extensions.md）：
 * - `pi.on("session_shutdown", handler)`，`SessionShutdownEvent
 *   { type; reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile? }`，
 *   handler 返回 void（无返回值通道）；
 * - ExtensionContext.sessionManager（ReadonlySessionManager）含 getSessionFile/
 *   getSessionDir/getSessionId/getSessionName——关闭时刻取当前会话文件与标题的
 *   官方可核实通道。
 *
 * 契约：
 * - reason=reload 跳过（扩展重载时会话仍在继续，此刻蒸馏会把素材冻结在半途，且
 *   去抖会挡掉结束时的更完整蒸馏）；quit/new/resume/fork 均为该会话的结束信号；
 * - 素材：会话 JSONL 尾部有界读取（≤ DISTILL_MATERIAL_MAX_BYTES），复用
 *   session-jsonl 的 parseSessionJsonl/parseUserTurns 提取修改记录与用户话语；
 * - 执行：fire-and-forget——把蒸馏请求写入 0600 临时文件，detached spawn
 *   `node distill-child.js <argsfile>` 后立即返回（不阻塞会话结束；quit 后子进程
 *   靠 detached 存活完成「headless pi → 校验 → 写回」全流程，临时文件由子进程删除）；
 * - 去抖：同会话重复 shutdown（quit 前的 new/resume/fork 往返）只蒸馏一次；
 * - fail-open：本 handler 任何异常只记 stderr 单行 warn，绝不影响 pi 关闭流程。
 */
import { spawn } from "node:child_process";
import { mkdtemp, open, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { LogEntry, Logger } from "@subconscious/core";
import {
  createDistillDebouncer,
  DISTILL_MATERIAL_MAX_BYTES,
  isDistillEnabled,
  renderSessionMaterial,
} from "./distill.js";
import type { DistillDebouncer } from "./distill.js";
import { resolveMemoryFilePath } from "./memory.js";
import { parseSessionJsonl, parseUserTurns, resolveContainedPath } from "./session-jsonl.js";

/** 本 handler 依赖的事件子面（真实 SessionShutdownEvent 结构性满足） */
export type PiSessionShutdownEvent = {
  readonly type: "session_shutdown";
  readonly reason: "quit" | "reload" | "new" | "resume" | "fork";
};

/** 本 handler 依赖的 ctx 子面（真实 ExtensionContext 结构性满足，参数逆变） */
export type PiShutdownContext = {
  readonly cwd: string;
  readonly sessionManager: Pick<SessionManager, "getSessionFile" | "getSessionDir" | "getSessionId" | "getSessionName">;
};

export type SessionShutdownHandler = (
  event: PiSessionShutdownEvent,
  ctx: PiShutdownContext,
) => Promise<void> | void;

export interface ShutdownHandlerOptions {
  logger?: Logger;
  /** env 快照；缺省 process.env（SUBCONSCIOUS_DISTILL / 记忆路径等测试注入用） */
  env?: NodeJS.ProcessEnv;
  /** 去抖器；缺省进程内单例（每会话至多一次） */
  debouncer?: DistillDebouncer;
  /** 蒸馏子进程 JS 入口；缺省同目录 distill-child.js（测试注入假 JS 用） */
  childScriptPath?: string;
  /** node 可执行文件；缺省 process.execPath（测试注入用） */
  nodePath?: string;
}

/** stderr 单行 JSON 日志（扩展进程内不污染宿主输出） */
function stderrLog(entry: LogEntry): void {
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // stderr 写失败：吞掉
  }
}

/**
 * 尾部有界读取：读文件末尾 ≤ maxBytes 字节并对齐到首个换行（丢弃被截断的半行），
 * fatal 解码保证合法 UTF-8。任何失败 → null（fail-open 跳过本次蒸馏）。
 */
export async function readTailText(filePath: string, maxBytes: number): Promise<string | null> {
  const handle = await open(filePath, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    let bytes = buffer.subarray(0, bytesRead);
    if (bytesRead < size && bytesRead > 0) {
      // 从尾部截断时首行大概率是半行：对齐到换行后（对齐失败则整段放弃，不猜）
      const newline = bytes.indexOf(10);
      if (newline < 0) return null;
      bytes = bytes.subarray(newline + 1);
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return text.startsWith("\uFEFF") ? text.slice(1) : text;
    } catch {
      return null; // 编码非法 → 不可用
    }
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 进程内去抖单例（模块级；pi 长寿命进程内同会话至多蒸馏一次） */
const debouncer = createDistillDebouncer();

/** 蒸馏子进程入口（同目录 distill-child.js） */
function defaultChildScriptPath(): string {
  return fileURLToPath(new URL("./distill-child.js", import.meta.url));
}

/** 组装蒸馏请求并 detached spawn 子进程；返回是否已发起。绝不抛出。 */
export async function triggerSessionDistillation(
  ctx: PiShutdownContext,
  options: ShutdownHandlerOptions = {},
): Promise<boolean> {
  const logger = options.logger;
  const env = options.env ?? process.env;
  try {
    if (!isDistillEnabled(env)) return false;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionDir = ctx.sessionManager.getSessionDir();
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionFile === undefined || sessionFile === "" || sessionDir === "" || sessionId === "") return false;
    if (!(options.debouncer ?? debouncer).shouldDistill(sessionId, Date.now())) return false;

    const realFile = await resolveContainedPath(sessionFile, sessionDir);
    if (realFile === null) return false;
    if ((await stat(realFile).catch(() => null)) === null) return false; // 会话文件不存在（理论不可能）
    const tail = await readTailText(realFile, DISTILL_MATERIAL_MAX_BYTES);
    if (tail === null || tail.trim() === "") return false;
    let sessionTitle = "";
    try {
      sessionTitle = ctx.sessionManager.getSessionName() ?? "";
    } catch {
      sessionTitle = ""; // 标题是展示字段，缺失不阻塞蒸馏
    }
    const material = renderSessionMaterial({
      sessionTitle,
      userTurns: parseUserTurns(tail),
      changes: parseSessionJsonl(tail).changes,
    });

    // 蒸馏请求落 0600 临时文件（素材可能含会话内容，不进 argv——ps 可见）
    const dir = await mkdtemp(path.join(tmpdir(), "subconscious-distill-"));
    const argsFile = path.join(dir, "request.json");
    await writeFile(
      argsFile,
      JSON.stringify({
        memoryFilePath: resolveMemoryFilePath(env),
        projectKey: ctx.cwd,
        sessionId,
        sessionTitle,
        material,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const child = spawn(options.nodePath ?? process.execPath, [options.childScriptPath ?? defaultChildScriptPath(), argsFile], {
      env,
      detached: true, // fire-and-forget：quit 后子进程存活完成写回
      stdio: "ignore",
    });
    child.unref();
    logger?.({ level: "info", event: "distill-triggered", detail: `会话 ${sessionId} 蒸馏子进程已发起` });
    return true;
  } catch (err) {
    logger?.({
      level: "warn",
      event: "distill-trigger-failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** session_shutdown 接线入口：reload 跳过，其余按上述纪律触发蒸馏 */
export function createSessionShutdownHandler(options: ShutdownHandlerOptions = {}): SessionShutdownHandler {
  const logger = options.logger ?? stderrLog;
  return (event, ctx) => {
    if (event.reason === "reload") return undefined; // 扩展重载 ≠ 会话结束（见模块头）
    return triggerSessionDistillation(ctx, { ...options, logger }).then(() => undefined);
  };
}
