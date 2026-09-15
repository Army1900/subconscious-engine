/**
 * 记忆层接线测试（M5b，DECISIONS D24）：
 * - 路径解析：默认 ~/.subconscious/memory.json；SUBCONSCIOUS_MEMORY_FILE 覆盖；
 * - wireMemory：文件缺失/损坏 fail-open（零词条、detector 原样、永不抛出）；非零词条
 *   → createPersonalPhraseDetector 包装且个人短语优先于基座重叠命中；base 缺省时包规则
 *   检测器；同路径 store memoize（进程内写队列串行化）；
 * - handler 端到端（离线临时目录，真实 SessionManager fixture）：学习闭环（select 亲选
 *   两次 → 第三次零交互自动解析，先验真实落盘 memory.json）；词典短语端到端注入与
 *   手工编辑热生效（D11 每事件重建引擎 → 每 prompt 重读）；文件缺失 = 行为不变；
 *   env 路径覆盖生效。全程不触碰真实 ~/.subconscious。
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine } from "@subconscious/core";
import type { Detector, EngineOptions } from "@subconscious/core";
import { createBeforeAgentStartHandler } from "../src/handler.js";
import type { AdapterDeps } from "../src/handler.js";
import { resolveMemoryFilePath, wireMemory } from "../src/memory.js";
import { cleanup, fakeExec, FakeUi, makeEvent, makeFakeCtx, makeTempDirs, writeFixtureSession } from "./helpers.js";
import type { TempDirs } from "./helpers.js";

async function tempMemoryFile(prefix = "sc-pi-mem-unit-"): Promise<string> {
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
    expect(wiring.detector).toBe(base); // 不包装
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
    expect(refs).toHaveLength(1); // 基座重叠命中让位，不重复计数
    expect(refs[0]?.expectedType).toBe("project"); // 个人注册强于通用规则
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
    expect(wiring.detector).toBeDefined();
    const refs = wiring.detector?.detect("把咱们那个摊子的构建修一下") ?? [];
    expect(refs.some((ref) => ref.expectedType === "project" && ref.text === "咱们那个摊子")).toBe(true);
  });

  it("同路径 store memoize：两次接线共享同一 store（进程内写队列串行化）", async () => {
    const file = await tempMemoryFile();
    const env = { SUBCONSCIOUS_MEMORY_FILE: file };
    const first = await wireMemory(undefined, { env });
    const second = await wireMemory(undefined, { env });
    expect(second.store).toBe(first.store);
  });
});

// ---------------------------------------------------------------------------
// handler 端到端：真实 createBeforeAgentStartHandler + 真实 SessionManager fixture
// ---------------------------------------------------------------------------

interface MemorySetup {
  dirs: TempDirs;
  ui: FakeUi;
  memFile: string;
  engineOptions: EngineOptions[];
  handler: (prompt: string) => ReturnType<ReturnType<typeof createBeforeAgentStartHandler>>;
}

/** 与 handler.test.ts 同源的证据形态：真实引擎 + 真实 SessionManager.list（临时目录），exec/ui mock */
async function setupMemory(memFile: string): Promise<MemorySetup> {
  const dirs = await makeTempDirs("sc-pi-memory-");
  await writeFile(path.join(dirs.projectDir, "README.md"), "x", "utf8");
  const ui = new FakeUi();
  const exec = fakeExec([{ stdout: " M src/api.ts\n", stderr: "", code: 0, killed: false }]);
  const engineOptions: EngineOptions[] = [];
  const deps: AdapterDeps = {
    exec: exec.exec,
    listSessions: async (cwd, sessionDir) => {
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      return SessionManager.list(cwd, sessionDir);
    },
    createEngineFn: (options: EngineOptions) => {
      engineOptions.push(options);
      return createEngine(options);
    },
    env: { SUBCONSCIOUS_MEMORY_FILE: memFile },
  };
  const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir, ui });
  const handler = createBeforeAgentStartHandler({ deps });
  return {
    dirs,
    ui,
    memFile,
    engineOptions,
    handler: (prompt: string) => handler(makeEvent(prompt), ctx),
  };
}

async function writeTwoSessions(dirs: TempDirs): Promise<{ firstId: string; secondId: string }> {
  const first = await writeFixtureSession({
    projectDir: dirs.projectDir,
    sessionDir: dirs.sessionDir,
    firstMessage: "第一次：处理登录",
    changes: [{ tool: "edit", path: "src/login.ts", oldText: "l", newText: "l2" }],
  });
  const second = await writeFixtureSession({
    projectDir: dirs.projectDir,
    sessionDir: dirs.sessionDir,
    firstMessage: "第二次：处理重试",
    changes: [{ tool: "edit", path: "src/retry.ts", oldText: "r", newText: "r2" }],
  });
  return { firstId: first.id, secondId: second.id };
}

/** 选择器标签由 core 生成（标题+时间后缀）；从真实记录里取含关键字的完整标签 */
function labelOf(ui: FakeUi, keyword: string): string {
  const call = [...ui.calls].reverse().find((c) => c.method === "select");
  const labels = (call?.messageOrOptions ?? "").split("|");
  const label = labels.find((l) => l.includes(keyword));
  if (label === undefined) throw new Error(`select 候选缺「${keyword}」：${call?.messageOrOptions ?? ""}`);
  return label;
}

const AMBIGUOUS_PROMPT = "按上次的方式改成一样的错误处理";

describe("handler 端到端：消歧先验（学习/代选/落盘）", () => {
  it("select 亲选两次 → 先验真实落盘；第三次零交互自动解析并标注「常用选择」", async () => {
    const s = await setupMemory(await tempMemoryFile("sc-pi-mem-e2e-"));
    try {
      const { firstId } = await writeTwoSessions(s.dirs);

      // 探针轮（取消）：记录 core 生成的完整候选标签，不作学习
      s.ui.selectResult = undefined;
      await s.handler(AMBIGUOUS_PROMPT);
      expect(s.ui.countOf("select")).toBe(1);
      const loginLabel = labelOf(s.ui, "处理登录");

      // 第一、二次亲选「处理登录」（同日两次 → count=2、权重占优）
      s.ui.selectResult = loginLabel;
      await s.handler(AMBIGUOUS_PROMPT);
      expect(s.ui.countOf("select")).toBe(2);
      await s.handler(AMBIGUOUS_PROMPT);
      expect(s.ui.countOf("select")).toBe(3);

      // 学习真实落盘：memory.json 出现两条同项目同会话先验
      const raw = await readFile(s.memFile, "utf8");
      const data = JSON.parse(raw) as { disambiguation: Array<{ projectKey: string; sessionId: string }> };
      const mine = data.disambiguation.filter((p) => p.projectKey === s.dirs.projectDir && p.sessionId === firstId);
      expect(mine.length).toBeGreaterThanOrEqual(2);

      // 第三次：零交互自动解析（ui.selectResult 设为取消也轮不到弹）
      s.ui.selectResult = undefined;
      const third = await s.handler(AMBIGUOUS_PROMPT);
      expect(s.ui.countOf("select")).toBe(3); // 无新 select
      const content = third?.message?.content ?? "";
      expect(content).toContain("[潜意识引擎·已解析]");
      expect(content).toContain("src/login.ts"); // 解析到亲选的会话内容
      expect(content).toContain("常用选择"); // 透明性标注
      expect(content).not.toContain("src/retry.ts");
    } finally {
      await cleanup(s.dirs.root);
    }
  });

  it("文件缺失 = 行为不变：歧义照旧弹 select、亲选照常解析、无先验文件产生", async () => {
    const s = await setupMemory(await tempMemoryFile("sc-pi-mem-miss-"));
    try {
      await writeTwoSessions(s.dirs);
      s.ui.selectResult = undefined;
      const cancelled = await s.handler(AMBIGUOUS_PROMPT);
      expect(cancelled).toBeUndefined(); // 取消 → 不注入（既有行为）
      expect(s.ui.countOf("select")).toBe(1);
      s.ui.selectResult = labelOf(s.ui, "处理重试");
      const picked = await s.handler(AMBIGUOUS_PROMPT);
      expect(picked?.message?.content ?? "").toContain("src/retry.ts"); // 亲选照常生效
      // 取消轮不写记忆；亲选一轮也只写一条（count=1 < 2 不代选）
      const data = JSON.parse(await readFile(s.memFile, "utf8")) as { disambiguation: unknown[] };
      expect(data.disambiguation).toHaveLength(1);
    } finally {
      await cleanup(s.dirs.root);
    }
  });
});

describe("handler 端到端：个人惯用语词典", () => {
  const PHRASE_PROMPT = "把咱们那个摊子的构建修一下";

  it("词典短语端到端注入：注册后检出并解析；未注册（文件缺失）= 透传 undefined", async () => {
    const file = await tempMemoryFile("sc-pi-mem-phrase-");
    const withPhrase = await setupMemory(file);
    try {
      const bare = await withPhrase.handler(PHRASE_PROMPT);
      expect(bare).toBeUndefined(); // 文件缺失：无词典、无其他指代 → no-op
      await writeMemory(file, {
        version: 1,
        disambiguation: [],
        phrases: [{ phrase: "咱们那个摊子", expectedType: "project" }],
      });
      const injected = await withPhrase.handler(PHRASE_PROMPT);
      expect(injected?.message?.content ?? "").toContain("[潜意识引擎·已解析]");
    } finally {
      await cleanup(withPhrase.dirs.root);
    }
  });

  it("手工编辑热生效：同一进程内改 memory.json，下一次 prompt 即按新词典行为（D11 每事件重读）", async () => {
    const file = await tempMemoryFile("sc-pi-mem-hot-");
    const s = await setupMemory(file);
    try {
      await writeMemory(file, {
        version: 1,
        disambiguation: [],
        phrases: [{ phrase: "摊子甲", expectedType: "project" }],
      });
      expect((await s.handler("把摊子甲的结构讲一下"))?.message?.content ?? "").toContain("[潜意识引擎·已解析]");
      // 手工编辑：换词条
      await writeMemory(file, {
        version: 1,
        disambiguation: [],
        phrases: [{ phrase: "摊子乙", expectedType: "project" }],
      });
      expect(await s.handler("把摊子甲的结构讲一下")).toBeUndefined(); // 旧词条已移除
      expect((await s.handler("把摊子乙的结构讲一下"))?.message?.content ?? "").toContain("[潜意识引擎·已解析]");
    } finally {
      await cleanup(s.dirs.root);
    }
  });

  it("损坏 memory.json fail-open：等同无词典，绝不阻塞注入路径", async () => {
    const file = await tempMemoryFile("sc-pi-mem-bad-");
    const s = await setupMemory(file);
    try {
      await writeMemory(file, "{corrupted!!!");
      expect(await s.handler(PHRASE_PROMPT)).toBeUndefined(); // 等同文件缺失
      await writeMemory(file, {
        version: 1,
        disambiguation: [],
        phrases: [{ phrase: "咱们那个摊子", expectedType: "project" }],
      });
      expect((await s.handler(PHRASE_PROMPT))?.message?.content ?? "").toContain("[潜意识引擎·已解析]"); // 修复后恢复
    } finally {
      await cleanup(s.dirs.root);
    }
  });
});

describe("handler 端到端：env 路径覆盖", () => {
  it("同一宿主进程，不同 SUBCONSCIOUS_MEMORY_FILE → 词典互不串扰", async () => {
    const fileA = await tempMemoryFile("sc-pi-mem-a-");
    const fileB = await tempMemoryFile("sc-pi-mem-b-");
    await writeMemory(fileA, {
      version: 1,
      disambiguation: [],
      phrases: [{ phrase: "摊子甲", expectedType: "project" }],
    });
    const a = await setupMemory(fileA);
    const b = await setupMemory(fileB); // B 路径无文件
    try {
      expect((await a.handler("把摊子甲的结构讲一下"))?.message?.content ?? "").toContain("[潜意识引擎·已解析]");
      expect(await b.handler("把摊子甲的结构讲一下")).toBeUndefined();
      // 引擎选项确实带上了各自的 memory store（接线证据）
      expect(a.engineOptions[0]?.memory).toBeDefined();
      expect(b.engineOptions[0]?.memory).toBeDefined();
      expect(b.engineOptions[0]?.memory).not.toBe(a.engineOptions[0]?.memory);
    } finally {
      await cleanup(a.dirs.root);
      await cleanup(b.dirs.root);
    }
  });
});
