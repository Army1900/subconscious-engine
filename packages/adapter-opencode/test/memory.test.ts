/**
 * 记忆层接线测试（M5b，DECISIONS D24；opencode 宿主特殊性：chat.message 插件无
 * confirm/select API——InteractPort 是录制型 unsupported，先验「学习」在本宿主不
 * 发生，但共享 memory.json 的先验（pi 等宿主学到/手工写入）在此可用：达门槛即
 * 自动代选）。全部用例离线、临时目录，绝不触碰真实 ~/.subconscious。
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine } from "@subconscious/core";
import type { Detector, EngineOptions } from "@subconscious/core";
import { handleChatMessage } from "../src/plugin.js";
import type { ChatMessageOutputLike, SdkSessionClient } from "../src/plugin.js";
import { resolveMemoryFilePath, wireMemory } from "../src/memory.js";

async function tempMemoryFile(prefix = "sc-oc-mem-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(dir, "memory.json");
}

async function writeMemory(file: string, data: unknown): Promise<void> {
  await writeFile(file, typeof data === "string" ? data : JSON.stringify(data), "utf8");
}

/** 官方 heyapi 形状的 SDK session 客户端假实现（离线；同 plugin.test.ts 证据形态） */
function fakeSdkSession(sessions: unknown[], diffs: readonly unknown[] = []): SdkSessionClient {
  return {
    async list() {
      return { data: sessions };
    },
    async get(options: { path: { id: string } }) {
      return { data: sessions.find((item) => (item as { id?: string } | null)?.id === options.path.id) ?? null };
    },
    async diff() {
      return { data: [...diffs] };
    },
  };
}

function sessionEntry(id: string, title: string, updated: number): unknown {
  return { id, directory: "/repo", title, time: { created: updated - 1000, updated } };
}

function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
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
// handleChatMessage 端到端（真实插件处理器 + 临时目录 + SDK 假客户端）
// ---------------------------------------------------------------------------

interface ChatSetup {
  projectDir: string;
  memFile: string;
  engineOptions: EngineOptions[];
  call: (prompt: string, sessions?: unknown[]) => Promise<{ ok: boolean; text: string }>;
}

async function setupChat(memFile: string): Promise<ChatSetup> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "sc-oc-mem-p-"));
  await writeFile(path.join(projectDir, "a.ts"), "export {};\n", "utf8");
  const engineOptions: EngineOptions[] = [];
  return {
    projectDir,
    memFile,
    engineOptions,
    call: async (prompt: string, sessions: unknown[] = []) => {
      const output: ChatMessageOutputLike = { parts: [textPart(prompt)] };
      const ok = await handleChatMessage(
        { sessionID: "ses_now", cwd: projectDir, client: { session: fakeSdkSession(sessions) } },
        output,
        {
          deps: {
            env: { SUBCONSCIOUS_MEMORY_FILE: memFile },
            createEngineFn: (options: EngineOptions) => {
              engineOptions.push(options);
              return createEngine(options);
            },
          },
        },
      );
      return { ok, text: (output.parts[0] as { text?: string }).text ?? "" };
    },
  };
}

async function rmrf(dir: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

const AMBIGUOUS_SESSIONS = () => [
  sessionEntry("ses_aaa", "错误处理改造", Date.now() - 86_400_000),
  sessionEntry("ses_bbb", "分页优化", Date.now() - 3 * 86_400_000),
];
const AMBIGUOUS_PROMPT = "参考上次的修改";

describe("handleChatMessage 端到端：消歧先验（使用；学习结构性不可能）", () => {
  it("共享先验达门槛 → 自动代选（已解析 + 「常用选择」标注），不再弹待确认；且不自增强", async () => {
    const s = await setupChat(await tempMemoryFile("sc-oc-mem-prior-"));
    try {
      await writeMemory(s.memFile, {
        version: 1,
        disambiguation: [
          { projectKey: s.projectDir, sessionId: "ses_aaa", title: "错误处理改造", at: new Date().toISOString() },
          { projectKey: s.projectDir, sessionId: "ses_aaa", title: "错误处理改造", at: new Date().toISOString() },
        ],
        phrases: [],
      });
      const result = await s.call(AMBIGUOUS_PROMPT, AMBIGUOUS_SESSIONS());
      expect(result.ok).toBe(true);
      expect(result.text).toContain("[潜意识引擎·已解析]");
      expect(result.text).toContain("错误处理改造"); // 代选到先验会话
      expect(result.text).toContain("常用选择"); // 透明性标注
      expect(result.text).not.toContain("[潜意识引擎·待确认]");
      const data = JSON.parse(await readFile(s.memFile, "utf8")) as { disambiguation: unknown[] };
      expect(data.disambiguation).toHaveLength(2); // 自动代选不学习（防自增强）
    } finally {
      await rmrf(s.projectDir);
    }
  });

  it("文件缺失 = 行为不变：歧义照旧注入待确认候选，no-op prompt 照旧 false，且不产生记忆文件", async () => {
    const s = await setupChat(await tempMemoryFile("sc-oc-mem-miss-"));
    try {
      const noRef = await s.call("列出所有 TODO");
      expect(noRef.ok).toBe(false);
      const ambiguous = await s.call(AMBIGUOUS_PROMPT, AMBIGUOUS_SESSIONS());
      expect(ambiguous.ok).toBe(true);
      expect(ambiguous.text).toContain("[潜意识引擎·待确认]");
      expect(ambiguous.text).not.toContain("常用选择");
      await expect(readFile(s.memFile, "utf8")).rejects.toThrow(); // 无 select → 零写入
    } finally {
      await rmrf(s.projectDir);
    }
  });
});

describe("handleChatMessage 端到端：个人惯用语词典", () => {
  const PHRASE_PROMPT = "把咱们那个摊子的构建修一下";

  it("词典短语端到端注入；未注册（文件缺失）= 透传 false", async () => {
    const s = await setupChat(await tempMemoryFile("sc-oc-mem-phrase-"));
    try {
      expect((await s.call(PHRASE_PROMPT)).ok).toBe(false);
      await writeMemory(s.memFile, {
        version: 1,
        disambiguation: [],
        phrases: [{ phrase: "咱们那个摊子", expectedType: "project" }],
      });
      const injected = await s.call(PHRASE_PROMPT);
      expect(injected.ok).toBe(true);
      expect(injected.text).toContain("[潜意识引擎·已解析]");
    } finally {
      await rmrf(s.projectDir);
    }
  });

  it("手工编辑热生效：同一长寿命进程内改 memory.json，下一次消息即按新词典行为（D11 每事件重读）", async () => {
    const s = await setupChat(await tempMemoryFile("sc-oc-mem-hot-"));
    try {
      await writeMemory(s.memFile, {
        version: 1,
        disambiguation: [],
        phrases: [{ phrase: "摊子甲", expectedType: "project" }],
      });
      expect((await s.call("把摊子甲的结构讲一下")).text).toContain("[潜意识引擎·已解析]");
      await writeMemory(s.memFile, {
        version: 1,
        disambiguation: [],
        phrases: [{ phrase: "摊子乙", expectedType: "project" }],
      });
      expect((await s.call("把摊子甲的结构讲一下")).ok).toBe(false); // 旧词条移除即时生效
      expect((await s.call("把摊子乙的结构讲一下")).text).toContain("[潜意识引擎·已解析]");
    } finally {
      await rmrf(s.projectDir);
    }
  });

  it("损坏 memory.json fail-open：等同无词典，绝不阻塞消息流", async () => {
    const s = await setupChat(await tempMemoryFile("sc-oc-mem-bad-"));
    try {
      await writeMemory(s.memFile, "{corrupted!!!");
      expect((await s.call(PHRASE_PROMPT)).ok).toBe(false);
    } finally {
      await rmrf(s.projectDir);
    }
  });
});

describe("handleChatMessage 端到端：env 路径覆盖", () => {
  it("不同 SUBCONSCIOUS_MEMORY_FILE → 词典互不串扰；引擎选项带上各自 memory store", async () => {
    const fileA = await tempMemoryFile("sc-oc-mem-a-");
    const fileB = await tempMemoryFile("sc-oc-mem-b-");
    await writeMemory(fileA, {
      version: 1,
      disambiguation: [],
      phrases: [{ phrase: "摊子甲", expectedType: "project" }],
    });
    const a = await setupChat(fileA);
    const b = await setupChat(fileB);
    try {
      expect((await a.call("把摊子甲的结构讲一下")).text).toContain("[潜意识引擎·已解析]");
      expect((await b.call("把摊子甲的结构讲一下")).ok).toBe(false);
      expect(a.engineOptions[0]?.memory).toBeDefined();
      expect(b.engineOptions[0]?.memory).toBeDefined();
      expect(b.engineOptions[0]?.memory).not.toBe(a.engineOptions[0]?.memory);
    } finally {
      await rmrf(a.projectDir);
      await rmrf(b.projectDir);
    }
  });
});
