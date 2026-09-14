/**
 * 测试基建。三类证据的边界（监督要求显式区分）：
 *
 * 1. mock：fakeExec / FakeUi / makeFakeCtx —— 类型取自锁定的
 *    @earendil-works/pi-coding-agent@0.85.1 真实声明（官方 SDK 类型通过），
 *    行为是测试自定的；
 * 2. 真实 SessionManager fixture：writeFixtureSession 用真实 SessionManager.create
 *    + appendMessage 把会话写进**临时目录**（os.tmpdir），list/读取均走真实实现，
 *    全程不接触真实 ~/.pi；
 * 3. 真人 pi 未运行：本仓库不做交互式端到端（M1 定界），报告中如实标注未验证。
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExecOptions, ExecResult, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { PiExec, PiHandlerContext } from "../src/index.js";
import type { PiBeforeAgentStartEvent } from "../src/index.js";

/** 临时目录组：projectDir 模拟 pi 的 cwd，sessionDir 模拟 pi 会话存储 */
export interface TempDirs {
  root: string;
  projectDir: string;
  sessionDir: string;
}

export async function makeTempDirs(prefix = "subconscious-adapter-"): Promise<TempDirs> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const projectDir = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  await mkdir(projectDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  return { root, projectDir, sessionDir };
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// mock：pi.exec 假实现（类型取自真实 ExecOptions/ExecResult）
// ---------------------------------------------------------------------------

export interface FakeExecCall {
  command: string;
  args: string[];
  options: ExecOptions | undefined;
}

export interface FakeExec {
  exec: PiExec;
  calls: FakeExecCall[];
  /** 第 n 次调用的返回；越界或未设置时返回 code:1 空结果 */
  results: Array<ExecResult | Error>;
}

export function fakeExec(results: Array<ExecResult | Error> = []): FakeExec {
  const calls: FakeExecCall[] = [];
  const exec: PiExec = async (command, args, options) => {
    const index = calls.length;
    calls.push({ command, args, options });
    const preset = results[index];
    if (preset instanceof Error) throw preset;
    if (preset !== undefined) return preset;
    return { stdout: "", stderr: "", code: 1, killed: false };
  };
  return { exec, calls, results };
}

// ---------------------------------------------------------------------------
// mock：ctx.ui 三个对话框的假实现（记录 signal/timeout 透传情况）
// ---------------------------------------------------------------------------

export interface FakeUiCall {
  method: "confirm" | "select" | "input";
  title: string;
  messageOrOptions: string | undefined;
  options: ExtensionUIDialogOptions | undefined;
}

export class FakeUi {
  readonly calls: FakeUiCall[] = [];
  confirmResult: boolean | Error = true;
  selectResult: string | undefined | Error = undefined;
  inputResult: string | undefined | Error = undefined;

  readonly ui = {
    confirm: async (title: string, message: string | undefined, options?: ExtensionUIDialogOptions): Promise<boolean> => {
      this.calls.push({ method: "confirm", title, messageOrOptions: message, options });
      if (this.confirmResult instanceof Error) throw this.confirmResult;
      return this.confirmResult;
    },
    select: async (title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> => {
      this.calls.push({ method: "select", title, messageOrOptions: options.join("|"), options: opts });
      if (this.selectResult instanceof Error) throw this.selectResult;
      return this.selectResult;
    },
    input: async (title: string, placeholder: string | undefined, opts?: ExtensionUIDialogOptions): Promise<string | undefined> => {
      this.calls.push({ method: "input", title, messageOrOptions: placeholder, options: opts });
      if (this.inputResult instanceof Error) throw this.inputResult;
      return this.inputResult;
    },
  };

  countOf(method: FakeUiCall["method"]): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}

// ---------------------------------------------------------------------------
// mock：最小 PiHandlerContext（真实 ExtensionContext 结构性满足该子面）
// ---------------------------------------------------------------------------

export interface FakeCtxParts {
  cwd: string;
  sessionDir: string;
  ui?: FakeUi;
  hasUI?: boolean;
  /** 缺省最小假实现；传真实 SessionManager 实例即为「真实宿主对象」证据 */
  sessionManager?: PiHandlerContext["sessionManager"];
}

export function makeFakeCtx(parts: FakeCtxParts): PiHandlerContext {
  return {
    cwd: parts.cwd,
    hasUI: parts.hasUI ?? true,
    ui: (parts.ui ?? new FakeUi()).ui,
    sessionManager: parts.sessionManager ?? { getSessionDir: (): string => parts.sessionDir },
  };
}

/** 事件子面（真实 BeforeAgentStartEvent 结构性满足） */
export function makeEvent(prompt: string): PiBeforeAgentStartEvent {
  return { type: "before_agent_start", prompt };
}

// ---------------------------------------------------------------------------
// 真实 SessionManager fixture：会话由真实 pi 实现写入临时目录
// ---------------------------------------------------------------------------

export interface FixtureChange {
  tool: "edit" | "write";
  path: string;
  oldText?: string;
  newText?: string;
  content?: string;
  failed?: boolean;
}

export interface FixtureSessionSpec {
  projectDir: string;
  sessionDir: string;
  firstMessage: string;
  /** 会话显示名（appendSessionInfo，真实 API） */
  name?: string;
  changes?: FixtureChange[];
}

export interface FixtureSession {
  id: string;
  file: string;
}

function fakeUsage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * 用真实 SessionManager 写一个 fixture 会话（至少含一条 assistant 消息才会落盘，
 * 与 pi 的延迟 flush 行为一致）。
 */
export async function writeFixtureSession(spec: FixtureSessionSpec): Promise<FixtureSession> {
  const manager = SessionManager.create(spec.projectDir, spec.sessionDir);
  const id = manager.getSessionId();
  manager.appendMessage({ role: "user", content: spec.firstMessage, timestamp: Date.now() });
  let callIndex = 0;
  for (const change of spec.changes ?? []) {
    callIndex += 1;
    const toolCallId = `call_${id.slice(0, 4)}_${callIndex}`;
    const arguments_ =
      change.tool === "edit"
        ? {
            path: change.path,
            edits: [
              {
                oldText: change.oldText ?? "",
                newText: change.newText ?? "",
              },
            ],
          }
        : { path: change.path, content: change.content ?? "" };
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: change.tool, arguments: arguments_ }],
      api: "anthropic",
      provider: "anthropic",
      model: "fixture-model",
      usage: fakeUsage(),
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId,
      toolName: change.tool,
      content: [{ type: "text", text: change.failed ? "fixture failure" : "ok" }],
      isError: change.failed === true,
      timestamp: Date.now(),
    });
  }
  if (spec.name !== undefined) {
    manager.appendSessionInfo(spec.name);
  }
  const file = manager.getSessionFile();
  if (file === undefined) throw new Error("fixture session was not persisted");
  return { id, file };
}

/** 手写原始 JSONL（安全/损坏用例不走真实写入路径） */
export async function writeRawSessionFile(sessionDir: string, name: string, lines: string[]): Promise<string> {
  const file = path.join(sessionDir, name);
  await writeFile(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** 在 sessionDir 内建立指向 dir 外目标的符号链接（逃逸用例） */
export async function makeOutsideSymlink(dirs: TempDirs, name: string): Promise<string> {
  const outsideDir = path.join(dirs.root, "outside");
  await mkdir(outsideDir, { recursive: true });
  const target = path.join(outsideDir, "secret.jsonl");
  await writeFile(target, JSON.stringify({ type: "session", id: "evil", timestamp: "2026-01-01T00:00:00.000Z", cwd: dirs.projectDir }) + "\n" + JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "evil.ts", content: " leaked" } }] } }) + "\n", "utf8");
  const link = path.join(dirs.sessionDir, name);
  await symlink(target, link);
  return link;
}
