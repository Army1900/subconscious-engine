/**
 * 蒸馏子进程测试（M5c-2）：真实 spawn 编译产物 dist/distill-child.js（detached
 * 触发路径经 shutdown handler 的完整接线），headless pi 用**假可执行文件**
 * （shell 脚本回放固定 JSON），绝不真调宿主 CLI。
 *
 * 覆盖：
 * 1. distill-child 直调：请求文件读完即删 → 假 pi 回放 → 校验写回 memory.json；
 * 2. 假 pi 回放非法 JSON → 不写记忆、退出码 0（fail-open）；
 * 3. createSessionShutdownHandler 完整接线：session_shutdown(quit) → 请求组装 →
 *    detached 子进程 → 写回（fire-and-forget，轮询等待）；reload 跳过；去抖。
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importMemory } from "@subconscious/core";
import { createSessionShutdownHandler } from "../src/shutdown.js";
import type { PiShutdownContext } from "../src/shutdown.js";

const childPath = fileURLToPath(new URL("../dist/distill-child.js", import.meta.url));
const CANNED = '[{"expression":"错误处理","content":"统一 try/catch 并 log 错误，不吞异常"}]';

let root: string;
let fakePiBin: string;
let badPiBin: string;

interface ProcResult {
  code: number | null;
  stderr: string;
}

function runNode(args: string[], env: NodeJS.ProcessEnv = {}): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("子进程 20s 未退出"));
      }
    }, 20000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

async function readConventions(memoryFile: string): Promise<unknown[]> {
  try {
    const memory = importMemory(await readFile(memoryFile, "utf8"));
    return memory === null ? [] : [...memory.conventions];
  } catch {
    return [];
  }
}

/** 轮询等待 fire-and-forget 子进程完成写回（detached，无退出通道可 await） */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return await predicate();
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sc-pi-distill-"));
  fakePiBin = path.join(root, "fake-pi.sh");
  await writeFile(fakePiBin, `#!/bin/sh\necho '${CANNED}'\n`, "utf8");
  await chmod(fakePiBin, 0o755);
  badPiBin = path.join(root, "bad-pi.sh");
  await writeFile(badPiBin, "#!/bin/sh\necho '本轮没有可蒸馏的惯例'\n", "utf8");
  await chmod(badPiBin, 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("distill-child 直调（真实编译产物）", () => {
  it("请求文件 → 假 pi 回放 → 校验写回 memory.json；请求文件读完即删", async () => {
    const dir = path.join(root, "child-ok");
    await mkdir(dir, { recursive: true });
    const requestFile = path.join(dir, "request.json");
    const memoryFile = path.join(dir, "memory.json");
    await writeFile(
      requestFile,
      JSON.stringify({
        memoryFilePath: memoryFile,
        projectKey: "/work/proj",
        sessionId: "ses_pi_1",
        sessionTitle: "错误处理改造",
        material: "用户话语：统一 try/catch",
      }),
      "utf8",
    );
    const result = await runNode([childPath, requestFile], {
      SUBCONSCIOUS_DISTILL_BIN: fakePiBin,
      SUBCONSCIOUS_MEMORY_FILE: memoryFile,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("distill-written");
    expect(existsSync(requestFile)).toBe(false); // 读完即删（隐私）
    const conventions = await readConventions(memoryFile);
    expect(conventions).toHaveLength(1);
    const entry = conventions[0] as Record<string, unknown>;
    expect(entry.expression).toBe("错误处理");
    expect(entry.projectKey).toBe("/work/proj");
    expect(entry.basedOnSessionId).toBe("ses_pi_1");
  });

  it("假 pi 回放非法 JSON → 放弃（fail-open），不写记忆、退出码 0", async () => {
    const dir = path.join(root, "child-bad");
    await mkdir(dir, { recursive: true });
    const requestFile = path.join(dir, "request.json");
    const memoryFile = path.join(dir, "memory.json");
    await writeFile(
      requestFile,
      JSON.stringify({ memoryFilePath: memoryFile, projectKey: "/p", sessionId: "s", sessionTitle: "", material: "素材" }),
      "utf8",
    );
    const result = await runNode([childPath, requestFile], { SUBCONSCIOUS_DISTILL_BIN: badPiBin });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("distill-skipped");
    expect(await readConventions(memoryFile)).toHaveLength(0);
  });
});

describe("session_shutdown 接线（fire-and-forget 完整链路）", () => {
  /** 真实形状的最小 shutdown ctx：sessionDir 内的会话 JSONL + 只读 sessionManager 子面 */
  async function makeCtx(name: string, lines: string[]): Promise<{ ctx: PiShutdownContext; sessionDir: string; sessionFile: string }> {
    const sessionDir = path.join(root, `sessions-${name}`);
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `${name}.jsonl`);
    await writeFile(sessionFile, lines.join("\n") + "\n", "utf8");
    const ctx: PiShutdownContext = {
      cwd: "/work/proj",
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionDir: () => sessionDir,
        getSessionId: () => `ses_${name}`,
        getSessionName: () => "错误处理改造",
      },
    };
    return { ctx, sessionDir, sessionFile };
  }

  it("quit → detached 子进程完成蒸馏写回（轮询等待 memory.json）", { timeout: 25000 }, async () => {
    const { ctx } = await makeCtx("quit", [
      '{"type":"session","id":"ses_quit"}',
      '{"type":"message","timestamp":"2026-09-15T09:00:00Z","message":{"role":"user","content":"错误处理按老规矩，统一 try/catch"}}',
    ]);
    const memoryFile = path.join(root, "mem-shutdown.json");
    const handler = createSessionShutdownHandler({
      childScriptPath: childPath,
      env: { SUBCONSCIOUS_DISTILL_BIN: fakePiBin, SUBCONSCIOUS_MEMORY_FILE: memoryFile, SUBCONSCIOUS_DISTILL: "1" },
    });
    await handler({ type: "session_shutdown", reason: "quit" }, ctx);
    const done = await waitFor(async () => (await readConventions(memoryFile)).length > 0, 15000);
    expect(done).toBe(true);
    const entry = (await readConventions(memoryFile))[0] as Record<string, unknown>;
    expect(entry.basedOnSessionId).toBe("ses_quit");
    expect(entry.basedOnSessionTitle).toBe("错误处理改造");
    expect(entry.projectKey).toBe("/work/proj");
  });

  it("reload 跳过（会话仍在继续）；SUBCONSCIOUS_DISTILL=0 关闭", async () => {
    const { ctx } = await makeCtx("reload", ['{"type":"session","id":"ses_reload"}', '{"type":"message","message":{"role":"user","content":"素材"}}']);
    const memoryFile = path.join(root, "mem-reload.json");
    const handler = createSessionShutdownHandler({
      childScriptPath: childPath,
      env: { SUBCONSCIOUS_DISTILL_BIN: fakePiBin, SUBCONSCIOUS_MEMORY_FILE: memoryFile },
    });
    await handler({ type: "session_shutdown", reason: "reload" }, ctx);
    expect(await readConventions(memoryFile)).toHaveLength(0);
    const disabled = createSessionShutdownHandler({
      childScriptPath: childPath,
      env: { SUBCONSCIOUS_DISTILL: "0", SUBCONSCIOUS_DISTILL_BIN: fakePiBin, SUBCONSCIOUS_MEMORY_FILE: memoryFile },
    });
    await disabled({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(await waitFor(async () => (await readConventions(memoryFile)).length > 0, 1500)).toBe(false); // 关闭 = 零动作
  });

  it("同会话重复 shutdown 只蒸馏一次（进程内去抖）", { timeout: 25000 }, async () => {
    const { ctx } = await makeCtx("dedup", ['{"type":"session","id":"ses_dedup"}', '{"type":"message","message":{"role":"user","content":"素材"}}']);
    const memoryFile = path.join(root, "mem-dedup.json");
    const env = { SUBCONSCIOUS_DISTILL_BIN: fakePiBin, SUBCONSCIOUS_MEMORY_FILE: memoryFile };
    const handler = createSessionShutdownHandler({
      childScriptPath: childPath, env });
    await handler({ type: "session_shutdown", reason: "quit" }, ctx);
    await handler({ type: "session_shutdown", reason: "new" }, ctx); // 同会话重复结束事件
    const done = await waitFor(async () => (await readConventions(memoryFile)).length > 0, 15000);
    expect(done).toBe(true);
    // 第二次触发被去抖：只写一次（等待稳定后仍为 1 条）
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await readConventions(memoryFile)).toHaveLength(1);
  });
});
