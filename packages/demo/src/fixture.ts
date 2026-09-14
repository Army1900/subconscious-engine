/**
 * demo fixture：用**真实** pi SessionManager 在 os.tmpdir 下写一个「上次会话」。
 *
 * - `SessionManager.create(projectDir, sessionDir)` 显式传入 sessionDir，
 *   因此从不落入默认的 ~/.pi/agent/sessions（全程不触碰真实 ~/.pi）；
 * - 会话内容（用户消息 + edit/write 工具调用 + 失败记录 + 会话名）全部经
 *   真实 `appendMessage` / `appendSessionInfo` 写入，与 adapter-pi 测试
 *   已验收的 fixture 构造方式同源；
 * - pi 的延迟落盘行为：至少一条 assistant 消息后才整体 flush（同步 appendFileSync），
 *   故写入后文件立即存在于磁盘，SessionManager.list 可读到。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** 临时目录组：projectDir 模拟 pi 的 cwd，sessionDir 模拟 pi 会话存储 */
export interface DemoDirs {
  root: string;
  projectDir: string;
  sessionDir: string;
}

export async function makeDemoDirs(): Promise<DemoDirs> {
  const root = await mkdtemp(path.join(tmpdir(), "subconscious-demo-"));
  const projectDir = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  await mkdir(projectDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  return { root, projectDir, sessionDir };
}

export async function cleanupDemo(dirs: DemoDirs): Promise<void> {
  await rm(dirs.root, { recursive: true, force: true }).catch(() => undefined);
}

export interface DemoFixtureSession {
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

interface FixtureToolChange {
  toolCallId: string;
  name: "edit" | "write";
  arguments: Record<string, unknown>;
  failed: boolean;
}

/**
 * 写入「上次会话」fixture：给 retryWrapper 加错误处理——
 * edit src/retry.ts（成功）、write src/logger.ts（成功）、edit src/broken.ts（失败）。
 */
export async function writeFixtureSession(dirs: DemoDirs): Promise<DemoFixtureSession> {
  const manager = SessionManager.create(dirs.projectDir, dirs.sessionDir);
  const id = manager.getSessionId();
  manager.appendMessage({ role: "user", content: "给 retryWrapper 加错误处理", timestamp: Date.now() });

  const changes: FixtureToolChange[] = [
    {
      toolCallId: "call_retry",
      name: "edit",
      arguments: { path: "src/retry.ts", edits: [{ oldText: "try {}", newText: "try {} catch (e) { log(e); }" }] },
      failed: false,
    },
    {
      toolCallId: "call_logger",
      name: "write",
      arguments: { path: "src/logger.ts", content: "export const log = console.error;" },
      failed: false,
    },
    {
      toolCallId: "call_broken",
      name: "edit",
      arguments: { path: "src/broken.ts", edits: [{ oldText: "a", newText: "b" }] },
      failed: true,
    },
  ];
  for (const change of changes) {
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: change.toolCallId, name: change.name, arguments: change.arguments }],
      api: "anthropic",
      provider: "anthropic",
      model: "fixture-model",
      usage: fakeUsage(),
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: change.toolCallId,
      toolName: change.name,
      content: [{ type: "text", text: change.failed ? "fixture failure" : "ok" }],
      isError: change.failed,
      timestamp: Date.now(),
    });
  }
  manager.appendSessionInfo("retryWrapper 错误处理改造");

  const file = manager.getSessionFile();
  if (file === undefined) throw new Error("fixture session was not persisted");
  return { id, file };
}

/**
 * 打开「当前会话」：真实恢复路径 `SessionManager.open(file, sessionDir)`。
 * 该实例即 demo 的 ctx.sessionManager（真实宿主对象，含 getSessionDir），
 * 也是注入消息的落盘目标。
 */
export function openCurrentSession(file: string, sessionDir: string): SessionManager {
  return SessionManager.open(file, sessionDir);
}
