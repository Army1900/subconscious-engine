import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONVENTION_DECAY_DAYS,
  conventionNegationMatches,
  domainAnchoredConventions,
  activeConventions,
  MAX_CONVENTIONS_PER_PROJECT,
  MAX_CONVENTIONS_TOTAL,
  rankConventionsByRecency,
} from "../src/conventions.js";
import {
  exportMemory,
  FileMemoryStore,
  importMemory,
  InMemoryMemoryStore,
  isConvention,
  parseMemoryData,
} from "../src/memory.js";
import { EngineConfigError } from "../src/errors.js";
import type { ConventionEntry, PersonalPhrase } from "../src/types.js";

const DAY = 86_400_000;
/** 固定"现在"：2026-09-15T12:00:00.000Z（与测试注入的 store 时钟一致） */
const NOW = Date.UTC(2026, 8, 15, 12);
const fixedNow = (): number => NOW;

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

const CWD = "/work/proj";
const OTHER = "/work/other";

/** 完整合法惯例条目（字段可覆盖） */
function convention(overrides: Partial<ConventionEntry> = {}): ConventionEntry {
  return {
    id: "c-1",
    projectKey: CWD,
    expression: "错误处理",
    content: "统一 try/catch 包裹并 log 错误，不吞异常",
    basedOnSessionId: "abc123",
    basedOnSessionTitle: "错误处理改造",
    generatedAt: isoDaysAgo(3),
    lastHitAt: isoDaysAgo(1),
    hitCount: 3,
    ...overrides,
  };
}

const PHRASE: PersonalPhrase = { phrase: "咱们那个摊子", expectedType: "project" };

async function pathFor(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "subconscious-conventions-")), name);
}

describe("isConvention（形状校验）", () => {
  it("合法条目通过；缺字段/超长/非法 hitCount 拒绝", () => {
    expect(isConvention(convention())).toBe(true);
    expect(isConvention({ ...convention(), id: "" })).toBe(false);
    expect(isConvention({ ...convention(), projectKey: "" })).toBe(false);
    expect(isConvention({ ...convention(), expression: "" })).toBe(false);
    expect(isConvention({ ...convention(), expression: "x".repeat(17) })).toBe(false); // expression ≤16
    expect(isConvention({ ...convention(), content: "" })).toBe(false);
    expect(isConvention({ ...convention(), content: "x".repeat(121) })).toBe(false); // content ≤120
    expect(isConvention({ ...convention(), basedOnSessionId: "" })).toBe(false);
    expect(isConvention({ ...convention(), basedOnSessionTitle: 1 })).toBe(false);
    expect(isConvention({ ...convention(), generatedAt: 123 })).toBe(false);
    expect(isConvention({ ...convention(), lastHitAt: null })).toBe(false);
    expect(isConvention({ ...convention(), hitCount: 1.5 })).toBe(false);
    expect(isConvention({ ...convention(), hitCount: -1 })).toBe(false);
    expect(isConvention({ ...convention(), hitCount: "3" })).toBe(false);
    expect(isConvention(null)).toBe(false);
    expect(isConvention("x")).toBe(false);
  });

  it("标题允许为空（会话可能无标题），其余字段仍须齐全", () => {
    expect(isConvention(convention({ basedOnSessionTitle: "" }))).toBe(true);
  });
});

describe("parseMemoryData（schema v1/v2 兼容读，写恒 v2）", () => {
  it("version 1 文件：conventions 视为空，先验/词条照常解析", () => {
    const parsed = parseMemoryData({
      version: 1,
      disambiguation: [{ projectKey: CWD, sessionId: "s1", title: "t", at: isoDaysAgo(1) }],
      phrases: [PHRASE],
    });
    expect(parsed).toEqual({
      version: 2,
      disambiguation: [{ projectKey: CWD, sessionId: "s1", title: "t", at: isoDaysAgo(1) }],
      phrases: [PHRASE],
      conventions: [],
    });
  });

  it("version 2 文件：conventions 逐条校验后重建", () => {
    const entry = convention();
    const parsed = parseMemoryData({ version: 2, disambiguation: [], phrases: [], conventions: [entry] });
    expect(parsed?.conventions).toEqual([entry]);
    expect(parsed?.version).toBe(2);
  });

  it("v2 缺 conventions 数组 / 非法条目 / 超全局上限 → null（不产出半份数据）", () => {
    expect(parseMemoryData({ version: 2, disambiguation: [], phrases: [] })).toBeNull();
    expect(parseMemoryData({ version: 2, disambiguation: [], phrases: [], conventions: {} })).toBeNull();
    expect(
      parseMemoryData({ version: 2, disambiguation: [], phrases: [], conventions: [{ ...convention(), expression: "" }] }),
    ).toBeNull();
    expect(
      parseMemoryData({
        version: 2,
        disambiguation: [],
        phrases: [],
        conventions: Array.from({ length: MAX_CONVENTIONS_TOTAL + 1 }, (_, i) => convention({ id: `c-${i}` })),
      }),
    ).toBeNull();
  });

  it("version 3 或未知版本 → null（封闭版本集）", () => {
    expect(parseMemoryData({ version: 3, disambiguation: [], phrases: [], conventions: [] })).toBeNull();
    expect(parseMemoryData({ version: "2", disambiguation: [], phrases: [], conventions: [] })).toBeNull();
  });
});

describe("FileMemoryStore·conventions（持久化与 fail-open）", () => {
  it("addConvention 落盘 version:2 文件，跨实例恢复；无残留临时文件", async () => {
    const file = await pathFor("memory.json");
    const first = new FileMemoryStore(file, fixedNow);
    await first.addConvention(convention());

    const raw = await readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 2,
      disambiguation: [],
      phrases: [],
      conventions: [convention()],
    });
    expect(raw).toContain("\"version\": 2"); // 人可编辑两空格缩进；写恒 v2
    const leftovers = (await readdir(join(file, ".."))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);

    const restored = new FileMemoryStore(file, fixedNow);
    await expect(restored.listConventions(CWD)).resolves.toEqual([convention()]);
  });

  it("v1 文件被新 store 采用：先验/词条可读，任何写入后文件升级为 v2（conventions 为空）", async () => {
    const file = await pathFor("memory.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        disambiguation: [{ projectKey: CWD, sessionId: "s1", title: "t", at: isoDaysAgo(1) }],
        phrases: [PHRASE],
      }),
      "utf8",
    );
    const store = new FileMemoryStore(file, fixedNow);
    await expect(store.listConventions(CWD)).resolves.toEqual([]);
    await expect(store.listPhrases()).resolves.toEqual([PHRASE]);

    await store.addConvention(convention());
    const raw = await readFile(file, "utf8");
    expect(JSON.parse(raw).version).toBe(2);
    expect(JSON.parse(raw).disambiguation).toEqual([
      { projectKey: CWD, sessionId: "s1", title: "t", at: isoDaysAgo(1) },
    ]);
  });

  it("损坏文件 fail-open 为空记忆；后续 addConvention 可恢复", async () => {
    const file = await pathFor("memory.json");
    await writeFile(file, "not json {{{", "utf8");
    const store = new FileMemoryStore(file, fixedNow);
    await expect(store.listConventions(CWD)).resolves.toEqual([]);
    await store.addConvention(convention());
    await expect(store.listConventions(CWD)).resolves.toEqual([convention()]);
  });

  it("listConventions 按项目精确隔离：异项目条目不可见（跨项目不串扰的存储层保证）", async () => {
    const store = new InMemoryMemoryStore(undefined, fixedNow);
    await store.addConvention(convention());
    await store.addConvention(convention({ projectKey: OTHER, expression: "提交信息", id: "c-2" }));
    await expect(store.listConventions(CWD)).resolves.toEqual([convention()]);
    await expect(store.listConventions(OTHER)).resolves.toEqual([
      convention({ projectKey: OTHER, expression: "提交信息", id: "c-2" }),
    ]);
    await expect(store.listConventions("/nope")).resolves.toEqual([]);
  });

  it("addConvention 非法条目受控失败（EngineConfigError invalid-memory）", async () => {
    const store = new InMemoryMemoryStore(undefined, fixedNow);
    await expect(store.addConvention({ ...convention(), expression: "x".repeat(17) })).rejects.toThrow(EngineConfigError);
    await expect(store.addConvention({ ...convention(), hitCount: -1 })).rejects.toThrow(EngineConfigError);
  });
});

describe("同名冲突与自增强防线（写时语义）", () => {
  it("同项目同 expression 内容不同 → 后写胜：整条替换（id/basedOn/generatedAt 一并更新，不留双活）", async () => {
    const store = new InMemoryMemoryStore(undefined, fixedNow);
    await store.addConvention(convention());
    const newer = convention({
      id: "c-99",
      content: "错误统一抛 Result，不吞异常",
      basedOnSessionId: "def456",
      basedOnSessionTitle: "错误处理二期",
      generatedAt: isoDaysAgo(0),
      hitCount: 0,
    });
    await store.addConvention(newer);
    await expect(store.listConventions(CWD)).resolves.toEqual([newer]);
  });

  it("相同输出（expression+content 逐字节相同）不洗 lastHitAt/generatedAt（防自增强）", async () => {
    const store = new InMemoryMemoryStore(undefined, fixedNow);
    await store.addConvention(convention());
    const duplicate = convention({
      id: "c-distilled-again",
      basedOnSessionId: "another-session",
      generatedAt: isoDaysAgo(0),
      lastHitAt: isoDaysAgo(0), // 蒸馏重放试图刷新时间
      hitCount: 99,
    });
    await store.addConvention(duplicate);
    await expect(store.listConventions(CWD)).resolves.toEqual([convention()]); // 原条目原样保留
  });

  it("不同 expression 各自独立并存", async () => {
    const store = new InMemoryMemoryStore(undefined, fixedNow);
    await store.addConvention(convention());
    await store.addConvention(convention({ expression: "提交信息", id: "c-2" }));
    await expect((await store.listConventions(CWD)).length).toBe(2);
  });
});

describe("写时淘汰与封顶", () => {
  it("90 天未命中（lastHitAt）的惯例在下次写入时淘汰；恰好 90 天保留", async () => {
    const store = new InMemoryMemoryStore(undefined, fixedNow);
    await store.addConvention(convention({ id: "stale", lastHitAt: isoDaysAgo(CONVENTION_DECAY_DAYS + 1) }));
    await store.addConvention(convention({ expression: "提交信息", id: "fresh" })); // 触发写时淘汰
    const kept = await store.listConventions(CWD);
    expect(kept.map((c) => c.id)).toEqual(["fresh"]);

    const edge = new InMemoryMemoryStore(undefined, fixedNow);
    await edge.addConvention(convention({ id: "edge", lastHitAt: isoDaysAgo(CONVENTION_DECAY_DAYS) }));
    await edge.addConvention(convention({ expression: "提交信息", id: "other" }));
    expect((await edge.listConventions(CWD)).length).toBe(2); // 恰 90 天不淘汰
  });

  it("lastHitAt 无效时间的惯例在写入时受控淘汰", async () => {
    const store = new InMemoryMemoryStore(undefined, fixedNow);
    await store.addConvention(convention({ id: "bad-time", lastHitAt: "not-a-date" }));
    await store.addConvention(convention({ expression: "提交信息", id: "good" }));
    expect((await store.listConventions(CWD)).map((c) => c.id)).toEqual(["good"]);
  });

  it("每项目 ≤20 条：超限按 lastHitAt 最旧淘汰；全局 ≤200 条跨项目同样最旧先出", async () => {
    const store = new InMemoryMemoryStore(undefined, fixedNow);
    // 22 条同项目惯例，lastHitAt 互异（i 越大越新）
    for (let i = 0; i < MAX_CONVENTIONS_PER_PROJECT + 2; i += 1) {
      await store.addConvention(convention({ id: `c-${i}`, expression: `惯例${i}`, lastHitAt: isoDaysAgo(i) }));
    }
    let kept = await store.listConventions(CWD);
    expect(kept.length).toBe(MAX_CONVENTIONS_PER_PROJECT);
    expect(kept.map((c) => c.id)).not.toContain("c-21"); // 最旧被淘汰
    expect(kept.map((c) => c.id)).not.toContain("c-20");
    expect(kept.map((c) => c.id)).toContain("c-0"); // 最新保留

    // 全局封顶：20 个项目 × 20 条 = 400 → 收敛到 200（每项目被均匀裁剪后全局最旧先出）
    const bulk = new InMemoryMemoryStore(undefined, fixedNow);
    for (let p = 0; p < 20; p += 1) {
      for (let i = 0; i < MAX_CONVENTIONS_PER_PROJECT; i += 1) {
        await bulk.addConvention(
          convention({ id: `g-${p}-${i}`, projectKey: `/work/p${p}`, expression: `惯例${i}`, lastHitAt: isoDaysAgo(i) }),
        );
      }
    }
    const allKept: ConventionEntry[] = [];
    for (let p = 0; p < 20; p += 1) allKept.push(...(await bulk.listConventions(`/work/p${p}`)));
    expect(allKept.length).toBe(MAX_CONVENTIONS_TOTAL);
    // 每项目只剩 10 条（同构裁剪：全局 200/20 项目），且都是较新的（lastHitAt 0..9 天）
    expect(allKept.every((c) => Date.parse(c.lastHitAt) >= NOW - 10 * DAY)).toBe(true);
  });
});

describe("recordConventionHit（命中回写）", () => {
  it("按（projectKey, id）定位：lastHitAt 更新、hitCount +1，并触发写时淘汰", async () => {
    const store = new InMemoryMemoryStore(undefined, fixedNow);
    await store.addConvention(convention({ id: "c-1", hitCount: 3 }));
    await store.addConvention(convention({ expression: "stale", id: "c-stale", lastHitAt: isoDaysAgo(120) }));
    await store.recordConventionHit(CWD, "c-1", isoDaysAgo(0));

    const kept = await store.listConventions(CWD);
    expect(kept.map((c) => c.id)).toEqual(["c-1"]); // 回写同样执行写时淘汰
    expect(kept[0]?.hitCount).toBe(4);
    expect(kept[0]?.lastHitAt).toBe(isoDaysAgo(0));
  });

  it("未知 id / 异项目 id / 非法时间 → no-op（尽力而为，不抛出）", async () => {
    const store = new InMemoryMemoryStore(undefined, fixedNow);
    await store.addConvention(convention());
    await expect(store.recordConventionHit(CWD, "nope", isoDaysAgo(0))).resolves.toBeUndefined();
    await expect(store.recordConventionHit(OTHER, "c-1", isoDaysAgo(0))).resolves.toBeUndefined(); // id 撞名也不跨项目
    await expect(store.recordConventionHit(CWD, "c-1", "garbage")).resolves.toBeUndefined();
    await expect(store.listConventions(CWD)).resolves.toEqual([convention()]);
  });
});

describe("exportMemory / importMemory（v2 可移植）", () => {
  const data = {
    version: 2 as const,
    disambiguation: [],
    phrases: [PHRASE] as readonly PersonalPhrase[],
    conventions: [convention()],
  };

  it("round-trip：导出再导入得到等值 v2 数据", () => {
    const text = exportMemory(data);
    expect(importMemory(text)).toEqual(data);
  });

  it("v1 文本经 importMemory 归一化为 v2（写恒 v2 的读侧入口）；导入文件可被 FileMemoryStore 直接采用", async () => {
    const v1Text = JSON.stringify({ version: 1, disambiguation: [], phrases: [] });
    expect(importMemory(v1Text)).toEqual({ version: 2, disambiguation: [], phrases: [], conventions: [] });

    const file = await pathFor("memory.json");
    await writeFile(file, exportMemory(data), "utf8");
    const store = new FileMemoryStore(file, fixedNow);
    await expect(store.listConventions(CWD)).resolves.toEqual([convention()]);
  });

  it("导入非法 v2 输入返回 null（不抛出、不产出半份数据）", () => {
    expect(importMemory(JSON.stringify({ version: 2, disambiguation: [], phrases: [], conventions: [{}] }))).toBeNull();
    expect(importMemory("not json")).toBeNull();
  });
});

describe("窄否定模式（D-D：单次跳过惯例解析）", () => {
  it("任务书示例与常见窄否定形态命中", () => {
    expect(conventionNegationMatches("别按老规矩处理")).toBe(true);
    expect(conventionNegationMatches("这次不用惯例")).toBe(true);
    expect(conventionNegationMatches("先别照旧")).toBe(true);
    expect(conventionNegationMatches("不按老规矩出牌")).toBe(true);
    expect(conventionNegationMatches("不要沿用惯例")).toBe(true);
    expect(conventionNegationMatches("这次不照旧处理")).toBe(true);
  });

  it("肯定表述与近邻干扰不命中（窄模式，避免误伤正常惯例指代）", () => {
    expect(conventionNegationMatches("按老规矩处理")).toBe(false);
    expect(conventionNegationMatches("照旧来")).toBe(false);
    expect(conventionNegationMatches("沿用惯例")).toBe(false);
    expect(conventionNegationMatches("别的不说，按老规矩来")).toBe(false); // "别"与"老规矩"不相邻
    expect(conventionNegationMatches("他不停按老规矩办事")).toBe(false); // "不停"=持续沿用，非否定
    expect(conventionNegationMatches("今天天气不错")).toBe(false);
    expect(conventionNegationMatches("换个新方案")).toBe(false);
  });
});

describe("域锚与活跃过滤（引擎侧纯函数）", () => {
  const entries: readonly ConventionEntry[] = [
    convention({ id: "c-err", expression: "错误处理" }),
    convention({ id: "c-commit", expression: "提交信息" }),
  ];

  it("域锚 = 话语精确包含 expression；不含则空", () => {
    expect(domainAnchoredConventions("按老规矩把错误处理补上", entries).map((c) => c.id)).toEqual(["c-err"]);
    expect(domainAnchoredConventions("按老规矩来", entries)).toEqual([]);
    // "处理错误"≠"错误处理"：不做近义猜测（近义属 embedding 臂）
    expect(domainAnchoredConventions("照旧处理错误", entries)).toEqual([]);
  });

  it("activeConventions：lastHitAt 距今 ≤90 天为活跃；无效时间不活跃；未来时间按当下计", () => {
    const now = NOW;
    const list: readonly ConventionEntry[] = [
      convention({ id: "ok", lastHitAt: isoDaysAgo(1) }),
      convention({ id: "edge", expression: "A", lastHitAt: isoDaysAgo(CONVENTION_DECAY_DAYS) }),
      convention({ id: "stale", expression: "B", lastHitAt: isoDaysAgo(CONVENTION_DECAY_DAYS + 1) }),
      convention({ id: "bad", expression: "C", lastHitAt: "not-a-date" }),
      convention({ id: "future", expression: "D", lastHitAt: new Date(NOW + DAY).toISOString() }),
    ];
    expect(activeConventions(list, now).map((c) => c.id)).toEqual(["ok", "edge", "future"]);
  });

  it("rankConventionsByRecency：lastHitAt 降序稳定排序，无效时间排最后", () => {
    const list: readonly ConventionEntry[] = [
      convention({ id: "old", lastHitAt: isoDaysAgo(5) }),
      convention({ id: "new", expression: "A", lastHitAt: isoDaysAgo(0) }),
      convention({ id: "mid", expression: "B", lastHitAt: isoDaysAgo(2) }),
      convention({ id: "bad", expression: "C", lastHitAt: "not-a-date" }),
      convention({ id: "old2", expression: "D", lastHitAt: isoDaysAgo(5) }),
    ];
    expect(rankConventionsByRecency(list).map((c) => c.id)).toEqual(["new", "mid", "old", "old2", "bad"]);
  });
});
