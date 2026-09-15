import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { createRuleDetector } from "../src/detector.js";
import { FileMemoryStore, importMemory } from "../src/memory.js";
import { createPersonalPhraseDetector } from "../src/phrase-detector.js";
import { cwdContextSource, recentSessionsSource } from "../src/sources/index.js";
import type {
  DisambiguationPrior,
  HostEnv,
  InteractPort,
  MemoryStore,
  PersonalPhrase,
  SessionSummary,
  Timer,
} from "../src/types.js";
import { FakeInteract } from "./helpers.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 15, 12);
const PROMPT = "参考上次的修改"; // 仅命中 history-event（"上次"）
const CWD = "/work/proj";

const SESSIONS: readonly SessionSummary[] = [
  { id: "s1", title: "重构会话", at: "2026-09-14T10:00:00.000Z" },
  { id: "s2", title: "错误处理会话", at: "2026-09-13T10:00:00.000Z" },
  { id: "s3", title: "文档会话", at: "2026-09-12T10:00:00.000Z" },
];

function labelOf(id: string): string {
  const s = SESSIONS.find((x) => x.id === id);
  return `${s?.title ?? id}（${s?.at ?? ""}）`;
}

function prior(sessionId: string, daysAgo: number, projectKey = CWD): DisambiguationPrior {
  return { projectKey, sessionId, title: "t", at: new Date(NOW - daysAgo * DAY).toISOString() };
}

function fixedTimer(): Timer {
  return { now: () => NOW, set: () => 0, clear: () => undefined };
}

function historyEnv(): HostEnv {
  return {
    cwd: CWD,
    listRecentSessions: async () => [...SESSIONS],
  };
}

/** 捕获 select 选项并按规则回选（不在回调内断言：guard 会吞掉端口异常） */
function scriptedSelect(pick: (options: readonly string[]) => string): { interact: InteractPort; calls: string[][] } {
  const calls: string[][] = [];
  const interact: InteractPort = {
    confirm: async () => "no",
    select: async (_title, options) => {
      calls.push([...options]);
      return pick(options);
    },
    acquire: async () => null,
  };
  return { interact, calls };
}

/** 可编程记忆存储：记录学习写入，可注入先验、可模拟读取故障 */
class FakeMemory implements MemoryStore {
  priors: DisambiguationPrior[] = [];
  readonly records: DisambiguationPrior[] = [];
  readonly calls: string[] = [];
  failRead = false;

  async listDisambiguation(): Promise<readonly DisambiguationPrior[]> {
    this.calls.push("list");
    if (this.failRead) throw new Error("memory unreadable");
    return this.priors;
  }

  async recordDisambiguation(entry: DisambiguationPrior): Promise<void> {
    this.calls.push(`record:${entry.sessionId}`);
    this.records.push(entry);
  }

  async listPhrases(): Promise<readonly PersonalPhrase[]> {
    return [];
  }

  async addPersonalPhrase(): Promise<void> {
    throw new Error("not used in engine tests");
  }
}

describe("消歧先验·学习", () => {
  it("用户在 select 中选定历史会话 → 记录先验 {项目、会话 id、标题、时间}", async () => {
    const memory = new FakeMemory();
    const interact = new FakeInteract();
    interact.selectResult = labelOf("s2");
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich(PROMPT, historyEnv());
    expect(out.resolvedRefs.length).toBe(1);
    expect(memory.records).toEqual([
      {
        projectKey: CWD,
        sessionId: "s2",
        title: "错误处理会话",
        at: new Date(NOW).toISOString(),
      },
    ]);
  });

  it("非 history-event 的消歧选择不学习、不受先验影响（先验只服务会话消歧）", async () => {
    const memory = new FakeMemory();
    memory.priors = [prior("f2", 1), prior("f2", 2)]; // 即使有同 id 先验也不得影响 file 消歧
    const interact = new FakeInteract();
    interact.selectResult = "b.ts";
    const engine = createEngine({
      sources: [
        {
          id: "files",
          types: ["file"],
          permission: "L0-free",
          async resolve() {
            return {
              status: "ambiguous",
              candidates: [
                { id: "f1", label: "a.ts", value: { type: "file", path: "/tmp/a.ts" } },
                { id: "f2", label: "b.ts", value: { type: "file", path: "/tmp/b.ts" } },
              ],
            };
          },
        },
      ],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("把这个文件打包一下", historyEnv());
    expect(interact.log.some((line) => line.startsWith("select:"))).toBe(true); // 照旧弹 select
    expect(interact.log.some((line) => line.includes("select:") && line.endsWith("a.ts|b.ts"))).toBe(true); // 原顺序
    expect(out.resolvedRefs.length).toBe(1);
    expect(memory.records).toEqual([]); // 不学习
  });
});

describe("消歧先验·保守自动解析", () => {
  it("同项目同会话 14 天内被选 ≥2 次且权重 ≥2× 次选 → 不弹 select，注入标注「按你的常用选择」", async () => {
    const memory = new FakeMemory();
    memory.priors = [prior("s2", 1), prior("s2", 2)];
    const interact = new FakeInteract();
    interact.selectResult = labelOf("s1"); // 若误弹选择器会选错会话，让断言暴露
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich(PROMPT, historyEnv());
    expect(interact.log).toEqual([]); // 零交互：未弹 select
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.resolvedRefs[0]?.display).toContain("错误处理会话");
    expect(out.resolvedRefs[0]?.display).toContain("按你的常用选择");
    expect(out.context).toContain("来源：recent-sessions");
    expect(out.context).toContain("按你的常用选择");
    expect(memory.records).toEqual([]); // 自动解析不再学习（防自增强）
  });

  it("先验不足（仅 1 次）→ 照旧弹 select，候选按先验加权排序，选择后继续学习", async () => {
    const memory = new FakeMemory();
    memory.priors = [prior("s2", 1)];
    const { interact, calls } = scriptedSelect((options) => options[0] as string);
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich(PROMPT, historyEnv());
    // s2（错误处理会话）应排最前，其余保持原顺序 s1、s3
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([labelOf("s2"), labelOf("s1"), labelOf("s3")]);
    expect(out.resolvedRefs[0]?.display).toContain("错误处理会话");
    expect(out.resolvedRefs[0]?.display).not.toContain("按你的常用选择"); // 用户亲选，非先验代选
    expect(memory.records.map((r) => r.sessionId)).toEqual(["s2"]);
  });

  it("先验指向不在候选集中的会话（ghost）→ 不注入、照旧弹 select（红线：先验只排序已有候选）", async () => {
    const memory = new FakeMemory();
    memory.priors = [prior("ghost", 1), prior("ghost", 2)];
    const { interact, calls } = scriptedSelect((options) => options[0] as string);
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich(PROMPT, historyEnv());
    expect(calls.length).toBe(1); // 照旧弹 select
    expect(out.context ?? "").not.toContain("ghost");
    expect(out.context ?? "").not.toContain("按你的常用选择");
  });

  it("异项目先验不参与加权（项目隔离），学习仍记当前项目", async () => {
    const memory = new FakeMemory();
    memory.priors = [prior("s2", 1, "/other/proj"), prior("s2", 2, "/other/proj")];
    const { interact, calls } = scriptedSelect((options) => options[0] as string);
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich(PROMPT, historyEnv());
    expect(calls[0]?.[0]).toBe(labelOf("s1")); // 无同项目先验 → 原顺序（按时间降序 s1 在前）
    expect(out.context ?? "").not.toContain("按你的常用选择");
    expect(memory.records.map((r) => r.projectKey)).toEqual([CWD]);
  });

  it("记忆读取故障 → fail-open：照旧弹 select，不阻塞解析，学习照常", async () => {
    const memory = new FakeMemory();
    memory.failRead = true;
    const interact = new FakeInteract();
    interact.selectResult = labelOf("s3");
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich(PROMPT, historyEnv());
    expect(interact.log.some((line) => line.startsWith("select:"))).toBe(true);
    expect(out.resolvedRefs[0]?.display).toContain("文档会话");
    expect(memory.records.length).toBe(1); // 写路径不受读故障影响
  });
});

describe("快照纪律与持久语义", () => {
  it("无指代话语 → 零记忆访问（无指代零开销透传不因记忆改变）", async () => {
    const memory = new FakeMemory();
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact: new FakeInteract(),
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("今天天气不错", historyEnv());
    expect(out.context).toBeUndefined();
    expect(memory.calls).toEqual([]);
  });

  it("引擎按次读取记忆（无实例内缓存）：先验变化在下一次 enrich 生效", async () => {
    const memory = new FakeMemory();
    memory.priors = [prior("s2", 1)]; // 第一次：仅 1 次，弹 select
    const { interact, calls } = scriptedSelect((options) => options[0] as string);
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    await engine.enrich(PROMPT, historyEnv());
    expect(calls.length).toBe(1);

    memory.priors = [prior("s2", 1), prior("s2", 2)]; // 第二次：达到自动解析门槛
    calls.length = 0;
    const out = await engine.enrich(PROMPT, historyEnv());
    expect(calls).toEqual([]); // 本次零交互
    expect(out.context).toContain("按你的常用选择");
  });

  it("跨引擎实例共享文件记忆：先学习两次，新引擎实例无需交互即自动解析（越用越懂我）", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "subconscious-memory-")), "memory.json");
    const store = new FileMemoryStore(file, () => NOW);
    const learnInteract = new FakeInteract();
    learnInteract.selectResult = labelOf("s2");
    const learner = createEngine({
      sources: [recentSessionsSource],
      interact: learnInteract,
      memory: store,
      timer: fixedTimer(),
    });
    await learner.enrich(PROMPT, historyEnv()); // 学习 1：0 先验 → select
    await learner.enrich(PROMPT, historyEnv()); // 学习 2：1 先验 → 仍 select（次数不足）

    // 文件持久化证据：两条先验可从磁盘读回（复制此文件即迁移）
    const onDisk = importMemory(await readFile(file, "utf8"));
    expect(onDisk?.disambiguation.length).toBe(2);
    expect(onDisk?.disambiguation.every((p) => p.sessionId === "s2" && p.projectKey === CWD)).toBe(true);

    // 新引擎实例（D11 每事件重建的形态）：共享同一持久存储，自动解析
    const autoInteract = new FakeInteract();
    autoInteract.selectResult = labelOf("s1"); // 若误弹选择器会选错，让断言暴露
    const engine2 = createEngine({
      sources: [recentSessionsSource],
      interact: autoInteract,
      memory: store,
      timer: fixedTimer(),
    });
    const out = await engine2.enrich(PROMPT, historyEnv());
    expect(autoInteract.log).toEqual([]);
    expect(out.context).toContain("错误处理会话");
    expect(out.context).toContain("按你的常用选择");
  });
});

describe("个人惯用语词典·端到端", () => {
  const LEXICON: readonly PersonalPhrase[] = [{ phrase: "咱们那个摊子", expectedType: "project" }];
  const PHRASE_PROMPT = "咱们那个摊子的依赖装一下";

  function cwdEnv(): HostEnv {
    return { cwd: CWD, readCwdContext: async () => ({ cwd: CWD, gitStatus: "M src/a.ts" }) };
  }

  it("注册短语经运行时扩展命中 → 走正常解析并注入（来源可审计）", async () => {
    const engine = createEngine({
      sources: [cwdContextSource],
      detector: createPersonalPhraseDetector(createRuleDetector(), LEXICON),
      timer: fixedTimer(),
    });
    const out = await engine.enrich(PHRASE_PROMPT, cwdEnv());
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.resolvedRefs[0]?.display).toContain(CWD);
    expect(out.context).toContain("来源：cwd-context");
    expect(out.context).toContain("咱们那个摊子");
  });

  it("未注册同句 → 规则检测零命中，no-op 透传且数据源零调用（词典不改变默认行为）", async () => {
    let providerCalls = 0;
    const env: HostEnv = {
      cwd: CWD,
      readCwdContext: async (req) => {
        providerCalls += 1;
        return cwdEnv().readCwdContext?.(req) ?? null;
      },
    };
    const engine = createEngine({
      sources: [cwdContextSource],
      detector: createRuleDetector(),
      timer: fixedTimer(),
    });
    const out = await engine.enrich(PHRASE_PROMPT, env);
    expect(out.context).toBeUndefined();
    expect(providerCalls).toBe(0);
  });
});
