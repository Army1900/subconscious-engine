/**
 * SessionEnd 子进程协议测试（M5c-2）：真实 spawn `node dist/hook-main.js`，经
 * stdin 注入 SessionEnd JSON，验证蒸馏全链路（transcript 尾读 → headless claude
 * 假可执行文件 → 校验写回 memory.json）与防递归哨兵 / 开关 / fail-open。
 *
 * mock 边界（如实区分）：headless claude 用**假可执行文件**（shell 脚本回放固定
 * JSON），绝不真调宿主 CLI；hook 进程本身是真实编译产物与真实子进程协议。
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importMemory } from "@subconscious/core";

const hookPath = fileURLToPath(new URL("../dist/hook-main.js", import.meta.url));

let root: string;
let projectDir: string;
const CANNED = '[{"expression":"错误处理","content":"统一 try/catch 并 log 错误，不吞异常"}]';

/** 假 headless claude 可执行文件：忽略参数（约定 -p <提示词>），回放固定 JSON */
let fakeClaudeBin: string;

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHook(stdinText: string, env: NodeJS.ProcessEnv = {}): Promise<ProcResult> {
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
        reject(new Error("hook 子进程 20s 未退出"));
      }
    }, 20000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
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
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function sessionEndPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "ses_end_1",
    transcript_path: path.join(root, "transcripts", "ses_end_1.jsonl"),
    cwd: projectDir,
    permission_mode: "default",
    hook_event_name: "SessionEnd",
    reason: "clear",
    ...over,
  });
}

async function readMemory(file: string): Promise<{ conventions: unknown[] } | null> {
  try {
    const memory = importMemory(await readFile(file, "utf8"));
    return memory === null ? null : { conventions: [...memory.conventions] };
  } catch {
    return null;
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sc-claude-session-end-"));
  projectDir = path.join(root, "project");
  const transcripts = path.join(root, "transcripts");
  await mkdir(projectDir, { recursive: true });
  await mkdir(transcripts, { recursive: true });
  await writeFile(
    path.join(transcripts, "ses_end_1.jsonl"),
    [
      '{"type":"user","message":{"role":"user","content":"错误处理都按老规矩，统一 try/catch"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"好的，已统一"}}',
      '{"type":"user","message":{"role":"user","content":"提交信息也按惯例来"}}',
      "",
    ].join("\n"),
    "utf8",
  );
  fakeClaudeBin = path.join(root, "fake-claude.sh");
  await writeFile(fakeClaudeBin, `#!/bin/sh\necho '${CANNED}'\n`, "utf8");
  await chmod(fakeClaudeBin, 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("SessionEnd hook（真实子进程 + 假 headless claude）", () => {
  it("蒸馏全链路：transcript 尾读 → 假 claude 回放 → 校验写回 memory.json；stdout 恒空、退出码 0", async () => {
    const memoryFile = path.join(root, "mem-ok.json");
    const result = await runHook(sessionEndPayload(), {
      SUBCONSCIOUS_DISTILL_BIN: fakeClaudeBin,
      SUBCONSCIOUS_MEMORY_FILE: memoryFile,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(""); // SessionEnd 无 stdout 通道：输出必须为空
    expect(result.stderr).toContain("distill-written");
    const memory = await readMemory(memoryFile);
    expect(memory).not.toBeNull();
    expect(memory?.conventions).toHaveLength(1);
    const entry = memory?.conventions[0] as Record<string, unknown>;
    expect(entry.expression).toBe("错误处理");
    expect(entry.projectKey).toBe(projectDir);
    expect(entry.basedOnSessionId).toBe("ses_end_1");
  });

  it("SUBCONSCIOUS_DISTILL=0 关闭：不蒸馏、不写记忆", async () => {
    const memoryFile = path.join(root, "mem-off.json");
    const result = await runHook(sessionEndPayload(), {
      SUBCONSCIOUS_DISTILL: "0",
      SUBCONSCIOUS_DISTILL_BIN: fakeClaudeBin,
      SUBCONSCIOUS_MEMORY_FILE: memoryFile,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("distill-written");
    expect(await readMemory(memoryFile)).toBeNull();
  });

  it("防递归哨兵：SUBCONSCIOUS_DISTILL_CHILD=1 → 全事件 no-op（不蒸馏）", async () => {
    const memoryFile = path.join(root, "mem-guard.json");
    const result = await runHook(sessionEndPayload(), {
      SUBCONSCIOUS_DISTILL_CHILD: "1",
      SUBCONSCIOUS_DISTILL_BIN: fakeClaudeBin,
      SUBCONSCIOUS_MEMORY_FILE: memoryFile,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("distill-child-guard");
    expect(await readMemory(memoryFile)).toBeNull();
  });

  it("缺 transcript_path → 跳过蒸馏（warn），退出码 0、stdout 空", async () => {
    const memoryFile = path.join(root, "mem-notranscript.json");
    const result = await runHook(sessionEndPayload({ transcript_path: undefined }), {
      SUBCONSCIOUS_DISTILL_BIN: fakeClaudeBin,
      SUBCONSCIOUS_MEMORY_FILE: memoryFile,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("distill-skipped");
    expect(await readMemory(memoryFile)).toBeNull();
  });

  it("假 claude 回放非法 JSON → 放弃本次蒸馏（fail-open），不写记忆", async () => {
    const badBin = path.join(root, "fake-claude-bad.sh");
    await writeFile(badBin, "#!/bin/sh\necho '没有可蒸馏的惯例'\n", "utf8");
    await chmod(badBin, 0o755);
    const memoryFile = path.join(root, "mem-bad.json");
    const result = await runHook(sessionEndPayload({ session_id: "ses_bad" }), {
      SUBCONSCIOUS_DISTILL_BIN: badBin,
      SUBCONSCIOUS_MEMORY_FILE: memoryFile,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("distill-skipped");
    expect(await readMemory(memoryFile)).toBeNull();
  });

  it("UserPromptSubmit 路径不受 SessionEnd 接线影响：非法蒸馏事件载荷不误触发", async () => {
    // hook_event_name 既非 UserPromptSubmit 又非 SessionEnd → invalid-input，无副作用
    const memoryFile = path.join(root, "mem-other.json");
    const result = await runHook(
      JSON.stringify({ hook_event_name: "SessionStart", cwd: projectDir, session_id: "s" }),
      { SUBCONSCIOUS_DISTILL_BIN: fakeClaudeBin, SUBCONSCIOUS_MEMORY_FILE: memoryFile },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid-input");
    expect(await readMemory(memoryFile)).toBeNull();
  });
});
