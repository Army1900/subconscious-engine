import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { CONVENTIONS_SOURCE_ID } from "../src/conventions.js";
import { InMemoryGrantStore } from "../src/grants.js";
import { cwdContextSource, recentSessionsSource, sessionContentSource } from "../src/sources/index.js";
import type {
  ConventionEntry,
  GrantStore,
  HostEnv,
  InteractPort,
  MemoryStore,
  SessionSummary,
  Timer,
} from "../src/types.js";
import { FakeInteract, sessionRecordFixture } from "./helpers.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 15, 12);
const CWD = "/work/proj";

function fixedTimer(): Timer {
  return { now: () => NOW, set: () => 0, clear: () => undefined };
}

function convention(overrides: Partial<ConventionEntry> = {}): ConventionEntry {
  return {
    id: "c-1",
    projectKey: CWD,
    expression: "错误处理",
    content: "统一 try/catch 包裹并 log 错误，不吞异常",
    basedOnSessionId: "abc123",
    basedOnSessionTitle: "错误处理改造",
    generatedAt: new Date(NOW - 3 * DAY).toISOString(),
    lastHitAt: new Date(NOW - 1 * DAY).toISOString(),
    hitCount: 3,
    ...overrides,
  };
}

const SESSIONS: readonly SessionSummary[] = [
  { id: "s1", title: "重构会话", at: "2026-09-14T10:00:00.000Z" },
  { id: "s2", title: "错误处理会话", at: "2026-09-13T10:00:00.000Z" },
];

/** 可编程记忆存储：注入惯例、记录命中回写；可模拟读取/回写故障 */
class ConventionMemory implements MemoryStore {
  conventions: ConventionEntry[] = [];
  readonly hits: Array<{ projectKey: string; id: string; at: string }> = [];
  listCalls = 0;
  failRead = false;
  failHit = false;

  async listDisambiguation(): Promise<readonly []> {
    return [];
  }
  async recordDisambiguation(): Promise<void> {}
  async listPhrases(): Promise<readonly []> {
    return [];
  }
  async addPersonalPhrase(): Promise<void> {}

  async listConventions(projectKey: string): Promise<readonly ConventionEntry[]> {
    this.listCalls += 1;
    if (this.failRead) throw new Error("memory unreadable");
    return this.conventions.filter((c) => c.projectKey === projectKey);
  }
  async addConvention(): Promise<void> {}
  async recordConventionHit(projectKey: string, id: string, at: string): Promise<void> {
    if (this.failHit) throw new Error("hit write failed");
    this.hits.push({ projectKey, id, at });
  }
}

/** 纯文本环境：只有 cwd（无会话数据源可解析） */
function plainEnv(): HostEnv {
  return { cwd: CWD };
}

/** 历史环境：可列会话 + 可读会话内容（记录 readSessionContent 调用） */
function historyEnv(): { env: HostEnv; contentCalls: string[] } {
  const contentCalls: string[] = [];
  const env: HostEnv = {
    cwd: CWD,
    listRecentSessions: async () => [...SESSIONS],
    readSessionContent: async (session) => {
      contentCalls.push(session.id);
      return sessionRecordFixture(session.id);
    },
  };
  return { env, contentCalls };
}

function labelOf(id: string): string {
  const s = SESSIONS.find((x) => x.id === id);
  return `${s?.title ?? id}（${s?.at ?? ""}）`;
}

/** 捕获 select 选项并按规则回选 */
function scriptedSelect(pick: (options: readonly string[]) => string): { interact: InteractPort; calls: string[][] } {
  const calls: string[][] = [];
  const interact: InteractPort = {
    confirm: async () => "yes",
    select: async (_title, options) => {
      calls.push([...options]);
      return pick(options);
    },
    acquire: async () => null,
  };
  return { interact, calls };
}

describe("惯例命中·锚定与注入形态", () => {
  it("域锚命中：话语提及 expression → 直取该条，display 带生成出处与已用次数，来源标注 conventions", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [
      convention(),
      convention({ id: "c-2", expression: "提交信息", content: "feat/fix 前缀 + 中文主题" }),
    ];
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    const grants = new InMemoryGrantStore();
    const engine = createEngine({
      sources: [recentSessionsSource, sessionContentSource],
      interact,
      grants,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("按老规矩把错误处理补上", plainEnv());
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.resolvedRefs[0]?.display).toBe(
      "惯例：错误处理 = 统一 try/catch 包裹并 log 错误，不吞异常（惯例·生成于「错误处理改造」会话 · 已用 3 次）",
    );
    expect(out.context).toContain("（来源：conventions）");
    expect(out.context).toContain('"按老规矩"'); // 注入行引用指代原文（span）
    expect(out.context).not.toContain("提交信息"); // 域锚唯一：另一条不注入
    expect(memory.hits).toEqual([{ projectKey: CWD, id: "c-1", at: new Date(NOW).toISOString() }]);
  });

  it("裸指代唯一惯例 → 直取（无域锚也命中唯一条）", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("按老规矩处理一下", plainEnv());
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.resolvedRefs[0]?.display).toContain("惯例：错误处理 = ");
  });

  it("多惯例裸指代 → 候选列表问用户，绝不静默注入；选中后注入该条并回写命中", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [
      convention({ id: "c-err", lastHitAt: new Date(NOW - 2 * DAY).toISOString() }),
      convention({ id: "c-commit", expression: "提交信息", content: "feat/fix 前缀 + 中文主题" }),
    ];
    const { interact, calls } = scriptedSelect((options) =>
      options.find((o) => o.includes("提交信息")) ?? options[0] as string,
    );
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("按老规矩来", plainEnv());
    expect(calls.length).toBe(1); // 弹了一次候选选择
    expect(calls[0]?.length).toBe(2);
    expect(calls[0]?.some((o) => o.includes("错误处理"))).toBe(true);
    expect(calls[0]?.some((o) => o.includes("提交信息"))).toBe(true);
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.resolvedRefs[0]?.display).toContain("提交信息");
    expect(out.context).toContain("（来源：conventions）");
    expect(memory.hits.map((h) => h.id)).toEqual(["c-commit"]); // 回写命中被选条
  });

  it("多惯例 + 选择器不可用（confirm 可用）→ interaction-unsupported 丢弃，零注入", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [
      convention(),
      convention({ id: "c-2", expression: "提交信息", content: "feat/fix 前缀 + 中文主题" }),
    ];
    const interact: InteractPort = {
      confirm: async () => "yes",
      select: async () => "unsupported",
      acquire: async () => null,
    };
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("按老规矩来", plainEnv());
    expect(out.context).toBeUndefined(); // 绝不静默注入（D-F）
    expect(out.droppedRefs.length).toBe(1);
    expect(out.dropReasons?.[out.droppedRefs[0] as string]).toBe("interaction-unsupported");
    expect(memory.hits).toEqual([]);
  });

  it("多惯例候选按 lastHitAt 近期排序（最近使用的排前）", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [
      convention({ id: "c-old", lastHitAt: new Date(NOW - 30 * DAY).toISOString() }),
      convention({ id: "c-new", expression: "提交信息", content: "feat/fix 前缀" }),
    ];
    const { interact, calls } = scriptedSelect((options) => options[0] as string);
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    await engine.enrich("按老规矩来", plainEnv());
    expect(calls[0]?.[0]).toContain("提交信息"); // c-new 最近命中，排最前
  });
});

describe("L1 授权（D-C：sourceId=conventions、scope=projectKey、grant-once）", () => {
  function grantedEngine(memory: ConventionMemory, interact: FakeInteract, grants: GrantStore = new InMemoryGrantStore()) {
    return createEngine({
      sources: [recentSessionsSource],
      interact,
      grants,
      memory,
      timer: fixedTimer(),
    });
  }

  it("未授权 → confirm；同意 → 按既有 grants 机制持久化，注入成功", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    const grants = new InMemoryGrantStore();
    const engine = grantedEngine(memory, interact, grants);
    const out = await engine.enrich("按老规矩处理一下", plainEnv());
    expect(interact.log.some((line) => line.startsWith("confirm:"))).toBe(true);
    expect(out.context).toContain("惯例：错误处理 = ");
    const records = await grants.list();
    expect(records.some((r) => r.sourceId === CONVENTIONS_SOURCE_ID && r.scope === CWD)).toBe(true);
  });

  it("授权一次后不再打扰：第二次 enrich 零 confirm 直接注入", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    const engine = grantedEngine(memory, interact);
    await engine.enrich("按老规矩处理一下", plainEnv());
    interact.log.length = 0;
    interact.confirmResult = "no"; // 若误弹 confirm 会拒绝并暴露
    const out = await engine.enrich("按老规矩处理一下", plainEnv());
    expect(interact.log).toEqual([]);
    expect(out.context).toContain("惯例：错误处理 = ");
    expect(memory.hits.length).toBe(2); // 两次命中都回写
  });

  it("拒绝 → permission-denied，不注入内容", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    const interact = new FakeInteract();
    interact.confirmResult = "no";
    const engine = grantedEngine(memory, interact);
    const out = await engine.enrich("按老规矩处理一下", plainEnv());
    expect(out.context).toBeUndefined();
    expect(out.dropReasons?.[out.droppedRefs[0] as string]).toBe("permission-denied");
    expect(memory.hits).toEqual([]);
  });

  it("无确认通道（unsupported）→ interaction-unsupported 降级，不注入确定结论", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    const engine = createEngine({
      sources: [recentSessionsSource],
      memory,
      timer: fixedTimer(),
    }); // 缺省 interact = 全 unsupported
    const out = await engine.enrich("按老规矩处理一下", plainEnv());
    expect(out.context).toBeUndefined();
    expect(out.dropReasons?.[out.droppedRefs[0] as string]).toBe("interaction-unsupported");
    expect(memory.hits).toEqual([]);
  });
});

describe("优先序与回退（行为不劣化）", () => {
  it("惯例优先于会话绑定：命中惯例时 session-content 零调用", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    const { env, contentCalls } = historyEnv();
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    interact.selectResult = labelOf("s1"); // wave 1 会话消歧用
    const engine = createEngine({
      sources: [recentSessionsSource, sessionContentSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("参考上次的修改，按老规矩处理", env);
    expect(out.resolvedRefs.length).toBe(2); // 会话事件 + 惯例内容
    expect(contentCalls).toEqual([]); // session-content 未被调用（惯例优先）
    expect(out.context).toContain("（来源：conventions）");
  });

  it("无惯例/无 memory → 回退既有 session-content 路径，行为与今天逐字节一致", async () => {
    const { env } = historyEnv();
    const mkEngine = (memory?: MemoryStore) => {
      const interact = new FakeInteract();
      interact.selectResult = labelOf("s2");
      return createEngine({
        sources: [recentSessionsSource, sessionContentSource],
        interact,
        ...(memory !== undefined ? { memory } : {}),
        timer: fixedTimer(),
      });
    };
    const PROMPT = "参考上次的修改，和上次一样的错误处理";
    const baseline = await mkEngine().enrich(PROMPT, env);
    const withEmpty = await mkEngine(new ConventionMemory()).enrich(PROMPT, env);
    expect(withEmpty).toEqual(baseline);

    // 无 memory 时历史指代照常解析（2 个"上次"事件指代 + 绑定会话内容注入）
    expect(baseline.resolvedRefs.length).toBe(3);
    expect(baseline.context).toContain("（来源：session-content）");
  });

  it("跨项目/ghost 惯例（projectKey 不匹配）不注入：回退既有行为", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention({ projectKey: "/work/other" })];
    const { env } = historyEnv();
    const interact = new FakeInteract();
    interact.selectResult = labelOf("s2");
    const engine = createEngine({
      sources: [recentSessionsSource, sessionContentSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("参考上次的修改，和上次一样的错误处理", env);
    expect(out.context ?? "").not.toContain("惯例：");
    expect(out.context ?? "").not.toContain("（来源：conventions）");
    expect(memory.listCalls).toBe(1); // 查过本项目惯例（结果为空）
    expect(memory.hits).toEqual([]);
  });

  it("91 天未命中的惯例不活跃：不注入，回退既有行为（读侧衰减）", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention({ lastHitAt: new Date(NOW - 91 * DAY).toISOString() })];
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("按老规矩处理一下", plainEnv());
    expect(out.context).toBeUndefined();
    expect(interact.log).toEqual([]); // 连授权确认都不发起
    expect(memory.hits).toEqual([]);
  });

  it("记忆读取故障 → fail-open：回退既有路径，不阻塞", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    memory.failRead = true;
    const { env } = historyEnv();
    const interact = new FakeInteract();
    interact.selectResult = labelOf("s2");
    const engine = createEngine({
      sources: [recentSessionsSource, sessionContentSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("参考上次的修改，和上次一样的错误处理", env);
    expect(out.resolvedRefs.length).toBe(3); // 会话路径照常（2 个事件指代 + 1 个内容指代）
    expect(out.context).toContain("（来源：session-content）");
  });

  it("命中回写失败不影响本次注入（回写是尽力而为）", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    memory.failHit = true;
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("按老规矩处理一下", plainEnv());
    expect(out.context).toContain("惯例：错误处理 = ");
  });
});

describe("否定语单次跳过（D-D）", () => {
  it("窄否定命中 → 本轮跳过惯例解析，其余指代照常", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    const interact = new FakeInteract();
    interact.confirmResult = "yes"; // 若误发起授权确认会通过并被断言暴露
    const engine = createEngine({
      sources: [cwdContextSource, recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const env: HostEnv = { cwd: CWD, readCwdContext: async () => ({ cwd: CWD, gitStatus: "M src/a.ts" }) };
    const out = await engine.enrich("别按老规矩处理，把当前项目的依赖升级", env);
    expect(out.context ?? "").not.toContain("惯例：");
    expect(out.context ?? "").not.toContain("（来源：conventions）");
    expect(interact.log.filter((line) => line.startsWith("confirm:"))).toEqual([]); // 未发起惯例授权
    expect(memory.hits).toEqual([]);
    expect(out.context).toContain("（来源：cwd-context）"); // 其余指代照常解析
  });

  it("否定语跳过后内容指代走既有路径（无绑定 → 诚实丢弃，不静默注入惯例）", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    const engine = createEngine({
      sources: [recentSessionsSource, sessionContentSource],
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("这次不用惯例，换个新方案，但沿用老规矩之外的做法", plainEnv());
    expect(out.context).toBeUndefined();
    expect(out.dropReasons?.[out.droppedRefs[0] as string]).toBe("no-binding"); // 既有路径：无绑定丢弃
  });
});

describe("无指代零开销（红线不因惯例改变）", () => {
  it("无指代话语 → 零记忆访问、零交互、no-op 透传", async () => {
    const memory = new ConventionMemory();
    memory.conventions = [convention()];
    const interact = new FakeInteract();
    const engine = createEngine({
      sources: [recentSessionsSource],
      interact,
      memory,
      timer: fixedTimer(),
    });
    const out = await engine.enrich("今天天气不错", plainEnv());
    expect(out.context).toBeUndefined();
    expect(memory.listCalls).toBe(0);
    expect(interact.log).toEqual([]);
  });
});
