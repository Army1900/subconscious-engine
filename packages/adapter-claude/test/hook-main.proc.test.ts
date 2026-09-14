/**
 * 子进程协议测试：真实 spawn `node dist/hook-main.js`，经 stdin/stdout JSON 验证
 * （docs/ACCEPTANCE「Claude」行：stdin hook JSON → stdout 合法 hook JSON；日志仅
 * stderr；无 UI 时降级）。不用进程内 mock 冒充协议测试。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hookPath = fileURLToPath(new URL("../dist/hook-main.js", import.meta.url));

let sessionsDir: string;
let projectDir: string;
const T0 = new Date("2026-09-14T10:00:00Z").getTime();

async function touch(file: string, atMs: number): Promise<void> {
  await writeFile(file, "{}\n", "utf8");
  const d = new Date(atMs);
  await utimes(file, d, d);
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 真实子进程：写 stdin（可选保持打开），收齐 stdout/stderr 与退出码 */
function runHook(stdinText: string | null, env: NodeJS.ProcessEnv = {}): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("hook 子进程 15s 未退出"));
      }
    }, 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (stdinText !== null) {
      child.stdin.write(stdinText, (err) => {
        if (err !== undefined && err !== null && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      child.stdin.end();
    }
    // stdinText === null：保持 stdin 打开（超时路径用）
  });
}

function hookJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "current-session",
    transcript_path: path.join(sessionsDir, "current-session.jsonl"),
    cwd: projectDir,
    permission_mode: "default",
    hook_event_name: "UserPromptSubmit",
    prompt: "参考上次的修改",
    ...overrides,
  });
}

beforeAll(async () => {
  if (!existsSync(hookPath)) {
    throw new Error(`缺少 ${hookPath}：先构建（npm run build -w @subconscious/adapter-claude）`);
  }
  sessionsDir = await mkdtemp(path.join(tmpdir(), "sc-claude-proc-s-"));
  projectDir = await mkdtemp(path.join(tmpdir(), "sc-claude-proc-p-"));
  await touch(path.join(sessionsDir, "current-session.jsonl"), T0);
  await touch(path.join(sessionsDir, "aaa-newer.jsonl"), T0 - 86400_000);
  await touch(path.join(sessionsDir, "bbb-older.jsonl"), T0 - 7 * 86400_000);
  await writeFile(path.join(projectDir, "README.md"), "x", "utf8");
});

afterAll(async () => {
  const fs = await import("node:fs/promises");
  await Promise.all([
    fs.rm(sessionsDir, { recursive: true, force: true }),
    fs.rm(projectDir, { recursive: true, force: true }),
  ]);
});

describe("hook-main 子进程协议：注入路径", () => {
  it("stdin hook JSON → stdout 单行合法 hook JSON（additionalContext 含降级候选），退出码 0", { timeout: 20000 }, async () => {
    const result = await runHook(hookJson());
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1); // stdout 只允许 hook JSON 本体，日志不得混入
    const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    const specific = parsed.hookSpecificOutput as Record<string, unknown> | undefined;
    expect(specific?.hookEventName).toBe("UserPromptSubmit");
    expect(typeof specific?.additionalContext).toBe("string");
    expect(String(specific?.additionalContext)).toContain("[潜意识引擎·待确认]");
    expect(String(specific?.additionalContext)).toContain("aaa-newer");
    // 永不阻塞：不输出 decision:block / continue:false / stopReason
    expect(parsed.decision).toBeUndefined();
    expect(parsed.continue).toBeUndefined();
    expect(parsed.stopReason).toBeUndefined();
  });

  it("已解析注入（project 指代）→ additionalContext 含已解析块与工作目录", { timeout: 20000 }, async () => {
    const result = await runHook(hookJson({ prompt: "介绍一下这个项目" }));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("[潜意识引擎·已解析]");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("工作目录");
  });
});

describe("hook-main 子进程协议：fail-open（任何失败输出空，绝不阻塞）", () => {
  it("无指代 prompt → stdout 为空（原样透传），退出码 0", { timeout: 20000 }, async () => {
    const result = await runHook(hookJson({ prompt: "现在几点了？直接回答" }));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("非 JSON stdin → 退出码 0、stdout 空、日志仅出现在 stderr", { timeout: 20000 }, async () => {
    const result = await runHook("this is not json");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).not.toBe("");
  });

  it("非 UserPromptSubmit 事件 → no-op（stdout 空，退出码 0）", { timeout: 20000 }, async () => {
    const result = await runHook(hookJson({ hook_event_name: "PreToolUse", tool_name: "Write" }));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("cwd 缺失 → no-op（stdout 空，退出码 0）", { timeout: 20000 }, async () => {
    const input = JSON.parse(hookJson()) as Record<string, unknown>;
    delete input.cwd;
    const result = await runHook(JSON.stringify(input));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("stdin 悬挂不关闭 → 总超时兜底：退出码 0、stdout 空，绝不挂死", { timeout: 20000 }, async () => {
    const startedAt = Date.now();
    const result = await runHook(null, { SUBCONSCIOUS_HOOK_TIMEOUT_MS: "800" });
    const elapsed = Date.now() - startedAt;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(elapsed).toBeLessThan(10000);
  });

  it("空 stdin 立即关闭 → no-op（stdout 空，退出码 0）", { timeout: 20000 }, async () => {
    const result = await runHook("");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});
