/**
 * 记忆层接线测试（M5b，DECISIONS D24；claude 宿主特殊性：UserPromptSubmit hook 的
 * InteractPort 是录制型 unsupported——select 结构性不可用，先验「学习」在本宿主不
 * 发生，但共享 memory.json 的先验（pi 等宿主学到/手工写入）在此可用：达门槛即自动
 * 代选）。全部用例离线、临时目录，绝不触碰真实 ~/.subconscious。
 */
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine } from "@subconscious/core";
import type { Detector, EngineOptions } from "@subconscious/core";
import { handleUserPromptSubmit } from "../src/hook.js";
import type { HookOutput } from "../src/hook.js";
import type { ClaudeHookInput, GitExec } from "../src/index.js";
import { resolveMemoryFilePath, wireMemory } from "../src/memory.js";

async function tempMemoryFile(prefix = "sc-claude-mem-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(dir, "memory.json");
}

async function writeMemory(file: string, data: unknown): Promise<void> {
  await writeFile(file, typeof data === "string" ? data : JSON.stringify(data), "utf8");
}

describe("resolveMemoryFilePath", () => {
  it("env 未设置/空白 → 默认 ~/.subconscious/memory.json（与 grants.json 同目录）", () => {
    const home = () => "/fixture/home";
    expect(resolveMemoryFilePath({}, home)).toBe(path.join("/fixture/home", ".subconscious", "memory.json"));
    expect(resolveMemoryFilePath({ SUBCONSCIOUS_MEMORY_FILE: "  " }, home)).toBe(
      path.join("/fixture/home", ".subconscious", "memory.json"),
    );
  });

  it("SUBCONSCIOUS_MEMORY_FILE 非空 → 原样生效（测试/多配置隔离）", () => {
    expect(resolveMemoryFilePath({ SUBCONSCIOUS_MEMORY_FILE: "/tmp/alt.json" })).toBe("/tmp/alt.json");
  });
});

describe("wireMemory", () => {
  it("文件缺失 → 零词条、detector 原样透传（行为与无记忆层一致）", async () => {
    const file = await tempMemoryFile();
    const base: Detector = { detect: () => [] };
    const wiring = await wireMemory(base, { env: { SUBCONSCIOUS_MEMORY_FILE: file } });
    expect(wiring.detector).toBe(base);
    expect(wiring.store).toBeDefined();
  });

  it("损坏文件 fail-open：不抛出、零词条、detector 原样", async () => {
    const file = await tempMemoryFile();
    await writeMemory(file, "{corrupted!!!");
    const base: Detector = { detect: () => [] };
    const wiring = await wireMemory(base, { env: { SUBCONSCIOUS_MEMORY_FILE: file } });
    expect(wiring.detector).toBe(base);
  });

  it("非零词条 → 包装基座；个人短语优先于基座重叠命中", async () => {
    const file = await tempMemoryFile();
    await writeMemory(file, {
      version: 1,
      disambiguation: [],
      phrases: [{ phrase: "咱们那个摊子", expectedType: "project" }],
    });
    const prompt = "咱们那个摊子修一下";
    const base: Detector = {
      detect: () => [{ id: "x", span: [0, 6], text: prompt.slice(0, 6), expectedType: "code-symbol", confidence: 0.9 }],
    };
    const wiring = await wireMemory(base, { env: { SUBCONSCIOUS_MEMORY_FILE: file } });
    expect(wiring.detector).not.toBe(base);
    const refs = wiring.detector?.detect(prompt) ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]?.expectedType).toBe("project");
    expect(refs[0]?.span).toEqual([0, 6]);
  });

  it("base 为 undefined 且有词条 → 包装规则检测器（短语可检出）", async () => {
    const file = await tempMemoryFile();
    await writeMemory(file, {
      version: 1,
      disambiguation: [],
      phrases: [{ phrase: "咱们那个摊子", expectedType: "project" }],
    });
    const wiring = await wireMemory(undefined, { env: { SUBCONSCIOUS_MEMORY_FILE: file } });
    const refs = wiring.detector?.detect("把咱们那个摊子的构建修一下") ?? [];
    expect(refs.some((ref) => ref.expectedType === "project" && ref.text === "咱们那个摊子")).toBe(true);
  });

  it("同路径 store memoize：两次接线共享同一 store", async () => {
    const file = await tempMemoryFile();
    const env = { SUBCONSCIOUS_MEMORY_FILE: file };
    expect((await wireMemory(undefined, { env })).store).toBe((await wireMemory(undefined, { env })).store);
  });
});

// ---------------------------------------------------------------------------
// handleUserPromptSubmit 端到端（真实 hook 处理器 + 临时会话目录）
// ---------------------------------------------------------------------------

const gitOk: GitExec = async () => ({ code: 0, stdout: " M packages/core/src/engine.ts\n" });

interface HookSetup {
  sessionsDir: string;
  projectDir: string;
  memFile: string;
  engineOptions: EngineOptions[];
  call: (prompt: string) => Promise<HookOutput | undefined>;
}

async function setupHook(memFile: string): Promise<HookSetup> {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "sc-claude-mem-s-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "sc-claude-mem-p-"));
  const now = Date.now();
  await writeFile(path.join(sessionsDir, "current-session.jsonl"), "{}\n", "utf8");
  await utimes(path.join(sessionsDir, "current-session.jsonl"), new Date(now), new Date(now));
  await writeFile(path.join(sessionsDir, "aaa-newer.jsonl"), "{}\n", "utf8");
  await utimes(path.join(sessionsDir, "aaa-newer.jsonl"), new Date(now - 86_400_000), new Date(now - 86_400_000));
  await writeFile(path.join(sessionsDir, "bbb-older.jsonl"), "{}\n", "utf8");
  await utimes(path.join(sessionsDir, "bbb-older.jsonl"), new Date(now - 7 * 86_400_000), new Date(now - 7 * 86_400_000));
  await writeFile(path.join(projectDir, "README.md"), "x", "utf8");

  const engineOptions: EngineOptions[] = [];
  const input = (prompt: string): ClaudeHookInput => ({
    hookEventName: "UserPromptSubmit",
    sessionId: "current-session",
    transcriptPath: path.join(sessionsDir, "current-session.jsonl"),
    cwd: projectDir,
    prompt,
  });
  return {
    sessionsDir,
    projectDir,
    memFile,
    engineOptions,
    call: (prompt: string) =>
      handleUserPromptSubmit(input(prompt), {
        deps: {
          exec: gitOk,
          env: { SUBCONSCIOUS_MEMORY_FILE: memFile },
          createEngineFn: (options: EngineOptions) => {
            engineOptions.push(options);
            return createEngine(options);
          },
        },
      }),
  };
}

const AMBIGUOUS_PROMPT = "参考上次的修改";

describe("handleUserPromptSubmit 端到端：消歧先验（使用；学习结构性不可能）", () => {
  it("共享先验达门槛 → 自动代选（已解析 + 「常用选择」标注），不再弹待确认；且不自增强", async () => {
    const s = await setupHook(await tempMemoryFile("sc-claude-mem-prior-"));
    try {
      await writeMemory(s.memFile, {
        version: 1,
        disambiguation: [
          { projectKey: s.projectDir, sessionId: "aaa-newer", title: "Claude 会话 aaa-newer", at: new Date().toISOString() },
          { projectKey: s.projectDir, sessionId: "aaa-newer", title: "Claude 会话 aaa-newer", at: new Date().toISOString() },
        ],
        phrases: [],
      });
      const result = await s.call(AMBIGUOUS_PROMPT);
      const text = result?.additionalContext ?? "";
      expect(text).toContain("[潜意识引擎·已解析]");
      expect(text).toContain("aaa-newer"); // 代选到先验会话
      expect(text).toContain("常用选择"); // 透明性标注
      expect(text).not.toContain("[潜意识引擎·待确认]");
      // 自动代选不学习（防自增强）：先验条数不变
      const data = JSON.parse(await readFile(s.memFile, "utf8")) as { disambiguation: unknown[] };
      expect(data.disambiguation).toHaveLength(2);
    } finally {
      await Promise.all([
        import("node:fs/promises").then((fs) => fs.rm(s.sessionsDir, { recursive: true, force: true })),
        import("node:fs/promises").then((fs) => fs.rm(s.projectDir, { recursive: true, force: true })),
      ]);
    }
  });

  it("文件缺失 = 行为不变：歧义照旧注入待确认候选，no-op prompt 照旧 undefined，且不产生记忆文件", async () => {
    const s = await setupHook(await tempMemoryFile("sc-claude-mem-miss-"));
    try {
      expect(await s.call("直接回答就好")).toBeUndefined();
      const result = await s.call(AMBIGUOUS_PROMPT);
      expect(result?.additionalContext ?? "").toContain("[潜意识引擎·待确认]");
      expect(result?.additionalContext ?? "").not.toContain("常用选择");
      await expect(readFile(s.memFile, "utf8")).rejects.toThrow(); // 无 select → 零写入
    } finally {
      await Promise.all([
        import("node:fs/promises").then((fs) => fs.rm(s.sessionsDir, { recursive: true, force: true })),
        import("node:fs/promises").then((fs) => fs.rm(s.projectDir, { recursive: true, force: true })),
      ]);
    }
  });
});

describe("handleUserPromptSubmit 端到端：个人惯用语词典", () => {
  const PHRASE_PROMPT = "把咱们那个摊子的构建修一下";

  it("词典短语端到端注入；未注册（文件缺失）= 透传 undefined", async () => {
    const s = await setupHook(await tempMemoryFile("sc-claude-mem-phrase-"));
    try {
      expect(await s.call(PHRASE_PROMPT)).toBeUndefined();
      await writeMemory(s.memFile, {
        version: 1,
        disambiguation: [],
        phrases: [{ phrase: "咱们那个摊子", expectedType: "project" }],
      });
      const injected = await s.call(PHRASE_PROMPT);
      expect(injected?.additionalContext ?? "").toContain("[潜意识引擎·已解析]");
    } finally {
      await Promise.all([
        import("node:fs/promises").then((fs) => fs.rm(s.sessionsDir, { recursive: true, force: true })),
        import("node:fs/promises").then((fs) => fs.rm(s.projectDir, { recursive: true, force: true })),
      ]);
    }
  });

  it("手工编辑热生效：一次性子进程语义下按 prompt 重读，两次调用间改文件即改行为", async () => {
    const s = await setupHook(await tempMemoryFile("sc-claude-mem-hot-"));
    try {
      await writeMemory(s.memFile, {
        version: 1,
        disambiguation: [],
        phrases: [{ phrase: "摊子甲", expectedType: "project" }],
      });
      expect((await s.call("把摊子甲的结构讲一下"))?.additionalContext ?? "").toContain("[潜意识引擎·已解析]");
      await writeMemory(s.memFile, {
        version: 1,
        disambiguation: [],
        phrases: [{ phrase: "摊子乙", expectedType: "project" }],
      });
      expect(await s.call("把摊子甲的结构讲一下")).toBeUndefined(); // 旧词条移除即时生效
      expect((await s.call("把摊子乙的结构讲一下"))?.additionalContext ?? "").toContain("[潜意识引擎·已解析]");
    } finally {
      await Promise.all([
        import("node:fs/promises").then((fs) => fs.rm(s.sessionsDir, { recursive: true, force: true })),
        import("node:fs/promises").then((fs) => fs.rm(s.projectDir, { recursive: true, force: true })),
      ]);
    }
  });

  it("损坏 memory.json fail-open：等同无词典，绝不阻塞注入路径", async () => {
    const s = await setupHook(await tempMemoryFile("sc-claude-mem-bad-"));
    try {
      await writeMemory(s.memFile, "{corrupted!!!");
      expect(await s.call(PHRASE_PROMPT)).toBeUndefined();
    } finally {
      await Promise.all([
        import("node:fs/promises").then((fs) => fs.rm(s.sessionsDir, { recursive: true, force: true })),
        import("node:fs/promises").then((fs) => fs.rm(s.projectDir, { recursive: true, force: true })),
      ]);
    }
  });
});

describe("handleUserPromptSubmit 端到端：env 路径覆盖", () => {
  it("不同 SUBCONSCIOUS_MEMORY_FILE → 词典互不串扰；引擎选项带上各自 memory store", async () => {
    const fileA = await tempMemoryFile("sc-claude-mem-a-");
    const fileB = await tempMemoryFile("sc-claude-mem-b-");
    await writeMemory(fileA, {
      version: 1,
      disambiguation: [],
      phrases: [{ phrase: "摊子甲", expectedType: "project" }],
    });
    const a = await setupHook(fileA);
    const b = await setupHook(fileB);
    try {
      expect((await a.call("把摊子甲的结构讲一下"))?.additionalContext ?? "").toContain("[潜意识引擎·已解析]");
      expect(await b.call("把摊子甲的结构讲一下")).toBeUndefined();
      expect(a.engineOptions[0]?.memory).toBeDefined();
      expect(b.engineOptions[0]?.memory).toBeDefined();
      expect(b.engineOptions[0]?.memory).not.toBe(a.engineOptions[0]?.memory);
    } finally {
      for (const s of [a, b]) {
        await Promise.all([
          import("node:fs/promises").then((fs) => fs.rm(s.sessionsDir, { recursive: true, force: true })),
          import("node:fs/promises").then((fs) => fs.rm(s.projectDir, { recursive: true, force: true })),
        ]);
      }
    }
  });
});
