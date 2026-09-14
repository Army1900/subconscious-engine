import { mkdtemp, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReadRequest } from "@subconscious/core";
import { createClaudeHostEnv, MAX_SESSION_ENTRIES } from "../src/host-env.js";
import type { ClaudeHookInput } from "../src/input.js";
import type { GitExec, GitExecResult } from "../src/host-env.js";

let sessionsDir: string;
let projectDir: string;

const T0 = new Date("2026-09-14T10:00:00Z").getTime();

async function touch(file: string, atMs: number): Promise<void> {
  await writeFile(file, "{}\n", "utf8");
  const d = new Date(atMs);
  await utimes(file, d, d);
}

function hookInput(overrides: Partial<ClaudeHookInput> = {}): ClaudeHookInput {
  return {
    hookEventName: "UserPromptSubmit",
    sessionId: "current-session",
    transcriptPath: path.join(sessionsDir, "current-session.jsonl"),
    cwd: projectDir,
    prompt: "参考上次的修改",
    ...overrides,
  };
}

const req = (signal?: AbortSignal): ReadRequest => ({ signal: signal ?? new AbortController().signal, maxBytes: 64000 });

beforeAll(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "sc-claude-sessions-"));
  projectDir = await mkdtemp(path.join(tmpdir(), "sc-claude-project-"));
  // 会话目录：当前会话 + 两个历史会话 + 一个非会话文件
  await touch(path.join(sessionsDir, "current-session.jsonl"), T0);
  await touch(path.join(sessionsDir, "bbb-older.jsonl"), T0 - 7 * 86400_000);
  await touch(path.join(sessionsDir, "aaa-newer.jsonl"), T0 - 86400_000);
  await touch(path.join(sessionsDir, "not-a-session.txt"), T0 - 1000);
  await writeFile(path.join(projectDir, "README.md"), "x", "utf8");
  await mkdir(path.join(projectDir, "src"), { recursive: true });
});

afterAll(async () => {
  await Promise.all([
    import("node:fs/promises").then((m) => m.rm(sessionsDir, { recursive: true, force: true })),
    import("node:fs/promises").then((m) => m.rm(projectDir, { recursive: true, force: true })),
  ]);
});

describe("createClaudeHostEnv：快照字段诚实性", () => {
  it("cwd 取 hook 输入的 cwd；activeEditor/readSessionContent/readClipboardText 结构性缺失", () => {
    const env = createClaudeHostEnv(hookInput());
    expect(env.cwd).toBe(projectDir);
    expect(env.activeEditor).toBeUndefined(); // hooks 无编辑器状态 → 诚实缺失，绝不猜「最近编辑的文件」
    expect(env.readSessionContent).toBeUndefined(); // 会话 JSONL 内部格式无官方文档 → 不解析不猜
    expect(env.readClipboardText).toBeUndefined(); // L1 无确认通道 → 不得读取
  });
});

describe("createClaudeHostEnv：listRecentSessions", () => {
  it("列 transcript 同目录 *.jsonl，排除当前会话，按 mtime 降序", async () => {
    const env = createClaudeHostEnv(hookInput());
    const sessions = await env.listRecentSessions?.(req());
    expect(sessions).not.toBeNull();
    expect(sessions?.map((s) => s.id)).toEqual(["aaa-newer", "bbb-older"]);
    expect(sessions?.[0]?.title).toContain("aaa-newer");
    expect(sessions?.[0]?.path).toBe(path.join(sessionsDir, "aaa-newer.jsonl"));
    expect(sessions?.[0]?.at).toBe(new Date(T0 - 86400_000).toISOString());
  });

  it("sessionId 为空时不排除任何文件（无当前会话信息可用）", async () => {
    const env = createClaudeHostEnv(hookInput({ sessionId: "" }));
    const sessions = await env.listRecentSessions?.(req());
    expect(sessions?.map((s) => s.id).sort()).toEqual(["aaa-newer", "bbb-older", "current-session"]);
  });

  it("transcriptPath 缺失 / 相对路径 → null（不猜目录）", async () => {
    const missing = createClaudeHostEnv(hookInput({ transcriptPath: "" }));
    expect(await missing.listRecentSessions?.(req())).toBeNull();
    const relative = createClaudeHostEnv(hookInput({ transcriptPath: "current-session.jsonl" }));
    expect(await relative.listRecentSessions?.(req())).toBeNull();
  });

  it("目录不存在 / 读取中止 → null", async () => {
    const ghost = createClaudeHostEnv(hookInput({ transcriptPath: path.join(sessionsDir, "ghost", "x.jsonl") }));
    expect(await ghost.listRecentSessions?.(req())).toBeNull();
    const controller = new AbortController();
    controller.abort();
    const env = createClaudeHostEnv(hookInput());
    expect(await env.listRecentSessions?.(req(controller.signal))).toBeNull();
  });

  it("条数上限 MAX_SESSION_ENTRIES", async () => {
    expect(MAX_SESSION_ENTRIES).toBeGreaterThan(0);
    const env = createClaudeHostEnv(hookInput());
    const controller = new AbortController();
    const list = await env.listRecentSessions?.(req(controller.signal));
    expect(list === null || list === undefined || list.length <= MAX_SESSION_ENTRIES).toBe(true);
  });
});

describe("createClaudeHostEnv：readCwdContext", () => {
  it("目录摘要有界；无 exec 时 gitStatus 诚实缺失", async () => {
    const env = createClaudeHostEnv(hookInput());
    const snap = await env.readCwdContext?.(req());
    expect(snap).not.toBeNull();
    expect(snap?.cwd).toBe(projectDir);
    expect(snap?.dirSummary).toContain("README.md");
    expect(snap?.dirSummary).toContain("src/");
    expect(snap?.gitStatus).toBeUndefined();
  });

  it("注入 exec：git 成功且非空 → gitStatus 进入快照；非零退出 → 缺失", async () => {
    const ok: GitExec = async () => ({ code: 0, stdout: " M packages/core/src/engine.ts\n" });
    const env = createClaudeHostEnv(hookInput(), { exec: ok });
    const snap = await env.readCwdContext?.(req());
    expect(snap?.gitStatus).toContain("engine.ts");

    const dirtyExit: GitExec = async (): Promise<GitExecResult> => ({ code: 128, stdout: "" });
    const env2 = createClaudeHostEnv(hookInput(), { exec: dirtyExit });
    expect((await env2.readCwdContext?.(req()))?.gitStatus).toBeUndefined();
  });

  it("exec 抛错 / 中止 → gitStatus 缺失，目录摘要仍可用；中止时整体 null", async () => {
    const boom: GitExec = async () => {
      throw new Error("git missing");
    };
    const env = createClaudeHostEnv(hookInput(), { exec: boom });
    const snap = await env.readCwdContext?.(req());
    expect(snap?.dirSummary).toBeDefined();
    expect(snap?.gitStatus).toBeUndefined();

    const controller = new AbortController();
    controller.abort();
    expect(await env.readCwdContext?.(req(controller.signal))).toBeNull();
  });

  it("目录条目超上限时摘要带显式截断标注", async () => {
    const many = await mkdtemp(path.join(tmpdir(), "sc-claude-many-"));
    for (let i = 0; i < 40; i += 1) await writeFile(path.join(many, `f${String(i).padStart(2, "0")}.ts`), "", "utf8");
    const env = createClaudeHostEnv(hookInput({ cwd: many, transcriptPath: "" }));
    const snap = await env.readCwdContext?.(req());
    expect(snap?.dirSummary).toContain("另有");
    await import("node:fs/promises").then((m) => m.rm(many, { recursive: true, force: true }));
  });
});
