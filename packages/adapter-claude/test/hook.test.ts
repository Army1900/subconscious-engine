import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageAcquisitionSource, type EnrichOutput, type EngineOptions, type LogEntry, type SubconsciousEngine } from "@subconscious/core";
import { CLAUDE_L0_SOURCES, handleUserPromptSubmit } from "../src/hook.js";
import type { ClaudeHookInput } from "../src/input.js";
import type { GitExec } from "../src/host-env.js";

let sessionsDir: string;
let projectDir: string;
const T0 = new Date("2026-09-14T10:00:00Z").getTime();

async function touch(file: string, atMs: number): Promise<void> {
  await writeFile(file, "{}\n", "utf8");
  const d = new Date(atMs);
  await utimes(file, d, d);
}

function hookInput(prompt: string): ClaudeHookInput {
  return {
    hookEventName: "UserPromptSubmit",
    sessionId: "current-session",
    transcriptPath: path.join(sessionsDir, "current-session.jsonl"),
    cwd: projectDir,
    prompt,
  };
}

const gitOk: GitExec = async () => ({ code: 0, stdout: " M packages/core/src/engine.ts\n" });

beforeAll(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "sc-claude-hook-s-"));
  projectDir = await mkdtemp(path.join(tmpdir(), "sc-claude-hook-p-"));
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

describe("CLAUDE_L0_SOURCES：只服务 L0 数据源", () => {
  it("恰为 cwd-context/active-editor/recent-sessions/session-content，全部 L0-free，不含 clipboard(L1)", () => {
    expect(CLAUDE_L0_SOURCES.map((s) => s.id)).toEqual([
      "cwd-context",
      "active-editor",
      "recent-sessions",
      "session-content",
    ]);
    for (const source of CLAUDE_L0_SOURCES) expect(source.permission).toBe("L0-free");
  });
});

describe("handleUserPromptSubmit：no-op 与已解析注入", () => {
  it("无指代 prompt → undefined（零注入，行为与裸 Claude Code 一致）", async () => {
    const result = await handleUserPromptSubmit(hookInput("现在几点了？直接回答"), { deps: { exec: gitOk } });
    expect(result).toBeUndefined();
  });

  it("project 指代解析成功 → additionalContext 为 core 已解析块（含来源工作目录与 git 状态）", async () => {
    const result = await handleUserPromptSubmit(hookInput("介绍一下这个项目"), { deps: { exec: gitOk } });
    expect(result).toBeDefined();
    expect(result?.additionalContext).toContain("[潜意识引擎·已解析]");
    expect(result?.additionalContext).toContain("工作目录");
    expect(result?.additionalContext).toContain("engine.ts");
    expect(result?.additionalContext).not.toContain("[潜意识引擎·待确认]");
  });
});

describe("handleUserPromptSubmit：ambiguous 降级（注入候选，不冒充结论）", () => {
  it("「上次」多会话 → 注入候选列表让大模型问用户，不得出现已解析结论", async () => {
    const result = await handleUserPromptSubmit(hookInput("参考上次的修改"), { deps: { exec: gitOk } });
    expect(result).toBeDefined();
    expect(result?.additionalContext).toContain("[潜意识引擎·待确认]");
    expect(result?.additionalContext).toContain("aaa-newer");
    expect(result?.additionalContext).toContain("bbb-older");
    expect(result?.additionalContext).toContain("请向用户确认");
    expect(result?.additionalContext).not.toContain("[潜意识引擎·已解析]");
  });

  it("已解析 + 歧义并存 → 已解析块在前，待确认块拼在后", async () => {
    const result = await handleUserPromptSubmit(hookInput("结合这个项目和上次的会话总结一下"), { deps: { exec: gitOk } });
    const text = result?.additionalContext ?? "";
    expect(text).toContain("[潜意识引擎·已解析]");
    expect(text).toContain("[潜意识引擎·待确认]");
    expect(text.indexOf("[潜意识引擎·已解析]")).toBeLessThan(text.indexOf("[潜意识引擎·待确认]"));
  });

  it("无编辑器时 code-symbol 诚实 not-found：绝不注入「当前编辑器」类猜测", async () => {
    const result = await handleUserPromptSubmit(hookInput("把这个函数改成和上次一样的错误处理"), { deps: { exec: gitOk } });
    expect(result?.additionalContext).not.toContain("当前编辑器");
    expect(result?.additionalContext).not.toContain("[潜意识引擎·已解析]");
  });
});

describe("handleUserPromptSubmit：need-acquisition 降级（注入提示或放弃）", () => {
  it("图片指代 → 注入「需要补充数据」提示，不伪造图片路径", async () => {
    const result = await handleUserPromptSubmit(hookInput("看看这张图"), {
      deps: { exec: gitOk },
      sources: [imageAcquisitionSource],
    });
    expect(result).toBeDefined();
    expect(result?.additionalContext).toContain("[潜意识引擎·待确认]");
    expect(result?.additionalContext).toContain("需要补充数据");
    expect(result?.additionalContext).toContain("请选择「这张图」所指的图片");
    expect(result?.additionalContext).not.toContain("[潜意识引擎·已解析]");
  });
});

describe("handleUserPromptSubmit：fail-open 与界限", () => {
  it("引擎异常 → undefined（绝不阻塞 hook）", async () => {
    const boomEngine: SubconsciousEngine = {
      enrich: () => Promise.reject(new Error("engine exploded")),
    };
    const result = await handleUserPromptSubmit(hookInput("参考上次的修改"), {
      deps: { exec: gitOk, createEngineFn: () => boomEngine },
    });
    expect(result).toBeUndefined();
  });

  it("attachments 通道不存在于 UserPromptSubmit：丢弃附件并记 warn，保留文本注入", async () => {
    const logs: LogEntry[] = [];
    const fakeEngine: SubconsciousEngine = {
      enrich: async (): Promise<EnrichOutput> => ({
        context: "[潜意识引擎·已解析]\n- 文本注入",
        attachments: [{ mediaType: "image/png", base64: "aGk=" }],
        resolvedRefs: [],
        droppedRefs: [],
      }),
    };
    const result = await handleUserPromptSubmit(hookInput("看看这张图"), {
      deps: { exec: gitOk, createEngineFn: (options: EngineOptions) => (void options, fakeEngine) },
      logger: (entry) => logs.push(entry),
    });
    expect(result?.additionalContext).toBe("[潜意识引擎·已解析]\n- 文本注入");
    expect(logs.some((l) => l.event === "attachments-dropped" && l.level === "warn")).toBe(true);
  });

  it("注入总量受 maxContextChars 界限（默认与自定义）", async () => {
    const result = await handleUserPromptSubmit(hookInput("参考上次的修改"), { deps: { exec: gitOk } });
    expect(result?.additionalContext.length ?? 0).toBeLessThanOrEqual(4000);
    const tight = await handleUserPromptSubmit(hookInput("参考上次的修改"), {
      deps: { exec: gitOk },
      limits: { maxContextChars: 150 },
    });
    expect(tight?.additionalContext.length ?? 0).toBeLessThanOrEqual(150);
  });
});
