import { describe, expect, it, onTestFinished } from "vitest";
import {
  createEmbeddingDetector,
  type EmbeddingDetectorOptions,
  type EmbeddingExample,
  type EmbeddingProvider,
} from "../src/embedding.js";
import { createRuleDetector } from "../src/detector.js";
import type { DanglingRef, DetectorContext } from "../src/types.js";
import { deferred, flushMicrotasks } from "./helpers.js";

/**
 * M3 embedding 检测器（DESIGN §4.1 演进第 2 步；docs/ACCEPTANCE.md「M3 embedding」行）。
 *
 * 离线固定向量 fixture 测分类逻辑：provider 由测试注入，绝不依赖网络与真实模型。
 * 锁定的行为：
 * - 同一 Detector 接口（同步 detect = 规则回退），异步 detectAsync 做向量近邻分类；
 * - provider 缺失/抛错/非有限/维度不匹配/预算不足/中止 → 规则检测结果（fail-open）；
 * - span 与原文切片严格一致，置信度由相似度单调映射；
 * - 与规则结果合并，重叠时规则优先。
 */

const rule = createRuleDetector();
const ruleRefs = (prompt: string): readonly DanglingRef[] => rule.detect(prompt);

const EXAMPLES: readonly EmbeddingExample[] = [
  { text: "这个函数", type: "code-symbol" },
  { text: "那个方法", type: "code-symbol" },
  { text: "this function", type: "code-symbol" },
  { text: "老规矩", type: "history-content" },
  { text: "照旧处理", type: "history-content" },
  { text: "你好", type: "negative" },
  { text: "run the tests", type: "negative" },
];

/** 三维 one-hot fixture：code-symbol / history-content / negative */
const threeDim = (text: string): readonly number[] => {
  if (/函数|方法|function|method/.test(text)) return [1, 0, 0];
  if (/老规矩|照旧/.test(text)) return [0, 1, 0];
  return [0, 0, 1];
};

function noBudget(): DetectorContext {
  return { signal: new AbortController().signal, remainingMs: () => 1_000_000 };
}

describe("EmbeddingDetector：回退（fail-open）", () => {
  it("provider 缺失 → detect/detectAsync 与规则检测器逐字一致", async () => {
    const detector = createEmbeddingDetector(undefined, { examples: EXAMPLES });
    const prompt = "把这个函数改成和上次一样的错误处理";
    expect(detector.detect(prompt)).toEqual(ruleRefs(prompt));
    expect(await detector.detectAsync(prompt)).toEqual(ruleRefs(prompt));
  });

  it("同步 detect() 始终返回规则结果且不触发任何 embed（同步契约）", async () => {
    let calls = 0;
    const provider: EmbeddingProvider = {
      id: "fixture-sync",
      async embed(text: string) {
        calls += 1;
        return threeDim(text);
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: EXAMPLES,
      thresholds: { accept: 0.6, margin: 0.2 },
    });
    expect(detector.detect("照老规矩处理")).toEqual(ruleRefs("照老规矩处理"));
    expect(calls).toBe(0);
    await detector.detectAsync("照老规矩处理");
    expect(calls).toBeGreaterThan(0);
  });

  it("provider 抛错 → 规则回退；连续失败达上限后永久禁用", async () => {
    let calls = 0;
    const provider: EmbeddingProvider = {
      id: "fixture-throws",
      async embed() {
        calls += 1;
        throw new Error("model missing");
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: EXAMPLES,
      thresholds: { accept: 0.6, margin: 0.2 },
      maxProviderFailures: 3,
    });
    const prompt = "把这个函数改一下";
    for (let i = 0; i < 4; i += 1) {
      expect(await detector.detectAsync(prompt)).toEqual(ruleRefs(prompt));
    }
    expect(calls).toBe(3); // 3 次尝试各失败一次，此后不再调用
  });

  it("init 后 provider 换维度 → 该次规则回退，达上限后永久禁用", async () => {
    let calls = 0;
    const provider: EmbeddingProvider = {
      id: "fixture-dim",
      async embed(text: string) {
        calls += 1;
        return calls <= EXAMPLES.length ? threeDim(text) : [1, 0]; // init 后换维度
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: EXAMPLES,
      thresholds: { accept: 0.6, margin: 0.2 },
      maxProviderFailures: 3,
    });
    const prompt = "把这个函数改一下";
    for (let i = 0; i < 4; i += 1) {
      expect(await detector.detectAsync(prompt)).toEqual(ruleRefs(prompt));
    }
    // init(7) + 每次 detectAsync 的第一个候选各 1 次 = 10；永久禁用后不再增长
    expect(calls).toBe(EXAMPLES.length + 3);
  });

  it("非有限向量（NaN/Infinity/空数组）→ 规则回退", async () => {
    const badVectors: readonly (readonly number[])[] = [
      [Number.NaN, 0, 0],
      [1, Number.POSITIVE_INFINITY, 0],
      [],
    ];
    for (const bad of badVectors) {
      let calls = 0;
      const provider: EmbeddingProvider = {
        id: "fixture-bad-vector",
        async embed(text: string) {
          calls += 1;
          return calls <= EXAMPLES.length ? threeDim(text) : bad;
        },
      };
      const detector = createEmbeddingDetector(provider, {
        examples: EXAMPLES,
        thresholds: { accept: 0.6, margin: 0.2 },
      });
      const prompt = "把这个函数改一下";
      expect(await detector.detectAsync(prompt)).toEqual(ruleRefs(prompt));
    }
  });

  it("signal 已中止 → 不发起任何 embed（含原型构建），直接规则回退", async () => {
    let calls = 0;
    const provider: EmbeddingProvider = {
      id: "fixture-aborted",
      async embed(text: string) {
        calls += 1;
        return threeDim(text);
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: EXAMPLES,
      thresholds: { accept: 0.6, margin: 0.2 },
    });
    const controller = new AbortController();
    controller.abort();
    const refs = await detector.detectAsync("把这个函数改一下", {
      signal: controller.signal,
      remainingMs: () => 0,
    });
    expect(refs).toEqual(ruleRefs("把这个函数改一下"));
    expect(calls).toBe(0);
  });

  it("remainingMs 低于预留 → 规则回退且零 embed；预算充足时正常走 embedding", async () => {
    let calls = 0;
    const provider: EmbeddingProvider = {
      id: "fixture-budget",
      async embed(text: string) {
        calls += 1;
        return threeDim(text);
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: EXAMPLES,
      thresholds: { accept: 0.6, margin: 0.2 },
      budgetReserveMs: 300,
    });
    const refs = await detector.detectAsync("照老规矩处理", {
      signal: new AbortController().signal,
      remainingMs: () => 100,
    });
    expect(refs).toEqual(ruleRefs("照老规矩处理"));
    expect(calls).toBe(0);

    const refs2 = await detector.detectAsync("照老规矩处理", noBudget());
    expect(refs2.map((r) => r.expectedType)).toContain("history-content");
    expect(calls).toBeGreaterThan(0);
  });

  it("prompt 超长 → 规则回退，不 embed", async () => {
    let calls = 0;
    const provider: EmbeddingProvider = {
      id: "fixture-long",
      async embed(text: string) {
        calls += 1;
        return threeDim(text);
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: EXAMPLES,
      thresholds: { accept: 0.6, margin: 0.2 },
      maxPromptChars: 10,
    });
    const prompt = "照老规矩处理这段代码顺便再多说几句无关的话";
    expect(await detector.detectAsync(prompt)).toEqual(ruleRefs(prompt));
    expect(calls).toBe(0);
  });

  it("embed 悬挂时中止 → 返回规则结果不悬挂；迟到的 rejection 不外溢", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    onTestFinished(() => {
      process.off("unhandledRejection", onUnhandled);
    });

    const gate = deferred<readonly number[]>();
    let calls = 0;
    const provider: EmbeddingProvider = {
      id: "fixture-hang",
      async embed(text: string) {
        calls += 1;
        return calls === 1 ? gate.promise : threeDim(text);
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: EXAMPLES,
      thresholds: { accept: 0.6, margin: 0.2 },
    });
    const controller = new AbortController();
    const pending = detector.detectAsync("照老规矩处理", {
      signal: controller.signal,
      remainingMs: () => 1_000_000,
    });
    await flushMicrotasks();
    controller.abort();
    const prompt = "照老规矩处理";
    expect(await pending).toEqual(ruleRefs(prompt));

    gate.reject(new Error("late failure"));
    await flushMicrotasks(20);
    await new Promise((r) => setTimeout(r, 5));
    expect(unhandled).toEqual([]);
  });

  it("空串与非字符串输入 → 空结果", async () => {
    const provider: EmbeddingProvider = { id: "fixture-empty", embed: async () => [1, 0, 0] };
    const detector = createEmbeddingDetector(provider, {
      examples: EXAMPLES,
      thresholds: { accept: 0.6, margin: 0.2 },
    });
    expect(await detector.detectAsync("")).toEqual([]);
    expect(await detector.detectAsync(undefined as unknown as string)).toEqual([]);
  });
});

describe("EmbeddingDetector：向量近邻分类与合并", () => {
  const zhOptions = (overrides?: Partial<EmbeddingDetectorOptions>): EmbeddingDetectorOptions => ({
    examples: EXAMPLES,
    thresholds: { accept: 0.6, margin: 0.2 },
    ...overrides,
  });
  const zhProvider = (): { provider: EmbeddingProvider; calls: () => number } => {
    let calls = 0;
    return {
      provider: {
        id: "fixture-zh",
        async embed(text: string) {
          calls += 1;
          return threeDim(text);
        },
      },
      calls: () => calls,
    };
  };

  it("「照老规矩」已由规则覆盖：重叠时规则优先，span 用规则完整短语", async () => {
    const { provider } = zhProvider();
    const detector = createEmbeddingDetector(provider, zhOptions());
    const prompt = "照老规矩处理这段代码";
    const refs = await detector.detectAsync(prompt);
    expect(refs.length).toBe(1);
    const ref = refs[0] as DanglingRef;
    expect(ref.expectedType).toBe("history-content");
    expect(ref.text).toBe("照老规矩"); // 规则模板 span（前缀动词 + 老规矩）优先于 embedding 子窗口
    expect(prompt.slice(ref.span[0], ref.span[1])).toBe(ref.text);
    expect(ref.confidence).toBeCloseTo(0.85, 5); // 规则模板置信度，不被 embedding 改写
  });

  it("与规则结果合并：重叠时规则优先，非重叠 embedding 补充，按 span 排序", async () => {
    const { provider } = zhProvider();
    const detector = createEmbeddingDetector(provider, zhOptions());
    const prompt = "把这个函数改成照老规矩处理";
    const refs = await detector.detectAsync(prompt);
    expect(refs.map((r) => r.text)).toEqual(["这个函数", "照老规矩"]);
    expect(refs.map((r) => r.expectedType)).toEqual(["code-symbol", "history-content"]);
    expect(refs.map((r) => r.id)).toEqual(["ref-1", "ref-2"]);
    // 规则项置信度保持模板值，不被 embedding 改写
    expect((refs[0] as DanglingRef).confidence).toBeCloseTo(0.95, 5);
  });

  it("负例零检出：普通话语不产生 embedding 误报", async () => {
    const { provider } = zhProvider();
    const detector = createEmbeddingDetector(provider, zhOptions());
    for (const prompt of ["This is a test", "你好世界", "run the tests now", "解释快速排序"]) {
      expect(await detector.detectAsync(prompt)).toEqual([]);
    }
  });

  it("裸指示词不成指代：仅含这个/那个/that 的 span 即使分类通过也拒绝（无类型信息）", async () => {
    // 构造 provider 模拟真实形态：裸指示词（"那个"/"that"）单轴高分，
    // 指示词+名词短语次之，其余落噪声轴（真实模型中上下文稀释使裸词得分更高）
    const demoExamples: readonly EmbeddingExample[] = [
      { text: "那个方法", type: "code-symbol" },
      { text: "那个常量", type: "code-symbol" },
      { text: "你好", type: "negative" },
      { text: "跑测试", type: "negative" },
    ];
    const provider: EmbeddingProvider = {
      id: "fixture-bare-demo",
      async embed(text: string) {
        if (text === "那个" || text === "that") return [1, 0];
        if (text.includes("那个方法")) return [0.85, 0.53];
        return [0, 1];
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: demoExamples,
      thresholds: { accept: 0.6, margin: 0.2 },
    });
    expect(await detector.detectAsync("我看那个啊再想想")).toEqual([]);
    expect(await detector.detectAsync("I like that idea")).toEqual([]);
    // 指示词 + 类型名词仍可命中（span 不是裸指示词，且不因裸词占位被挤掉）
    const refs = await detector.detectAsync("改一下那个方法");
    expect(refs.map((r) => r.text)).toEqual(["那个方法"]);
  });

  it("Unicode（emoji 前缀）下 span 仍按码元精确且不切断代理对", async () => {
    const { provider } = zhProvider();
    const detector = createEmbeddingDetector(provider, zhOptions());
    const prompt = "🙂 照老规矩办";
    const refs = await detector.detectAsync(prompt);
    expect(refs.length).toBe(1);
    const ref = refs[0] as DanglingRef;
    expect(ref.expectedType).toBe("history-content");
    expect(prompt.slice(ref.span[0], ref.span[1])).toBe(ref.text);
  });

  it("maxCandidates 上限：候选 + span 扩展的 embed 次数有界（各 ≤ maxCandidates）", async () => {
    const { provider, calls } = zhProvider();
    const detector = createEmbeddingDetector(provider, zhOptions({ maxCandidates: 5 }));
    await detector.detectAsync("照老规矩处理这段代码再顺带整理一下这些零散的工具函数和配置", noBudget());
    const candidateCalls = calls() - EXAMPLES.length;
    expect(candidateCalls).toBeGreaterThan(0);
    expect(candidateCalls).toBeLessThanOrEqual(10); // 分类 ≤5 + 扩展 ≤5（D23 有界性）
  });

  it("span 扩展：种子窗口在 CJK 连续段内延展到同类短语边界（标点即界）", async () => {
    // 一维轴 fixture：含"聊出"→ history-content，否则 negative
    const extendExamples: readonly EmbeddingExample[] = [
      { text: "聊出来的结论", type: "history-content" },
      { text: "碰出来的点子", type: "history-content" },
      { text: "你好", type: "negative" },
      { text: "跑测试", type: "negative" },
    ];
    const provider: EmbeddingProvider = {
      id: "fixture-extend",
      async embed(text: string) {
        return text.includes("聊出") ? [1, 0] : [0, 1];
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: extendExamples,
      thresholds: { accept: 0.6, margin: 0.2 },
    });
    const prompt = "把咱们聊出来的那套思路，往下推";
    const refs = await detector.detectAsync(prompt);
    expect(refs.length).toBe(1);
    const ref = refs[0] as DanglingRef;
    expect(ref.expectedType).toBe("history-content");
    // 种子"聊出"(2 字) 扩展覆盖整个 CJK 连续段（该 fixture 下所有超串同类），
    // 标点"，"截断：不越过到"往下推"
    expect(ref.text).toBe("把咱们聊出来的那套思路");
    expect(prompt.slice(ref.span[0], ref.span[1])).toBe(ref.text);
  });

  it("span 扩展：不越过规则命中区间（模板优先，扩展让位）", async () => {
    const extendExamples: readonly EmbeddingExample[] = [
      { text: "聊出来的结论", type: "history-content" },
      { text: "碰出来的点子", type: "history-content" },
      { text: "你好", type: "negative" },
      { text: "跑测试", type: "negative" },
    ];
    const provider: EmbeddingProvider = {
      id: "fixture-extend-rule",
      async embed(text: string) {
        return text.includes("聊出") ? [1, 0] : [0, 1];
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: extendExamples,
      thresholds: { accept: 0.6, margin: 0.2 },
    });
    const prompt = "咱们聊出来的那套思路改到这个文件里";
    const refs = await detector.detectAsync(prompt);
    const ruleRef = refs.find((r) => r.expectedType === "file");
    const embRef = refs.find((r) => r.expectedType === "history-content");
    expect(ruleRef?.text).toBe("这个文件");
    expect(embRef).toBeDefined();
    // 扩展在规则区间前停下：不与"这个文件"重叠，且从"咱们"起覆盖完整思路短语
    expect((embRef as DanglingRef).span[1]).toBeLessThanOrEqual((ruleRef as DanglingRef).span[0]);
    expect((embRef as DanglingRef).text).toContain("咱们聊出来的那套思路");
  });

  it("init 单飞：并发 detectAsync 只构建一次原型（每个示例只 embed 一次）", async () => {
    const counts = new Map<string, number>();
    const provider: EmbeddingProvider = {
      id: "fixture-singleflight",
      async embed(text: string) {
        counts.set(text, (counts.get(text) ?? 0) + 1);
        return threeDim(text);
      },
    };
    const detector = createEmbeddingDetector(provider, zhOptions());
    // 两个 prompt 的候选窗口都不与示例文本相同，避免候选 embed 与原型 embed 计数混淆
    await Promise.all([
      detector.detectAsync("照旧再来一次", noBudget()),
      detector.detectAsync("把那个函数再改一下", noBudget()),
    ]);
    for (const ex of EXAMPLES) {
      expect(counts.get(ex.text)).toBe(1);
    }
  });
});

describe("EmbeddingDetector：阈值与置信度映射（确定性公式）", () => {
  // 二维构造空间：code-symbol 原型 = [1,0]；negative 原型见 provider
  const SIM_EXAMPLES: readonly EmbeddingExample[] = [
    { text: "alpha one", type: "code-symbol" },
    { text: "beta two", type: "code-symbol" },
    { text: "gamma", type: "negative" },
    { text: "delta", type: "negative" },
  ];

  it("置信度 = 0.5 + 0.5×(sim−accept)/(1−accept)，按相似度单调", async () => {
    const provider: EmbeddingProvider = {
      id: "fixture-sim",
      async embed(text: string) {
        if (text.includes("magic")) return [0.6, 0.8]; // cos([1,0]) = 0.6
        if (text.includes("wizard")) return [0.9, Math.sqrt(0.19)]; // cos([1,0]) = 0.9
        if (text === "alpha one" || text === "beta two") return [1, 0];
        if (text === "gamma" || text === "delta") return [-1, 0];
        return [0, 1];
      },
    };
    const detector = createEmbeddingDetector(provider, {
      examples: SIM_EXAMPLES,
      thresholds: { accept: 0.5, margin: 0.1 },
    });
    const refs = await detector.detectAsync("use magic and wizard here", noBudget());
    expect(refs.map((r) => r.text)).toEqual(["magic", "wizard"]);
    expect((refs[0] as DanglingRef).confidence).toBeCloseTo(0.6, 3);
    expect((refs[1] as DanglingRef).confidence).toBeCloseTo(0.9, 3);
    for (const ref of refs) {
      expect(ref.expectedType).toBe("code-symbol");
    }
  });

  it("margin 门：与 negative 原型过近时拒绝，调低 margin 后接受", async () => {
    // c=[0.7,0.714]：与 code-symbol 原型 [1,0] cos≈0.70；与 negative 原型 cos≈0.68 → margin≈0.02
    const provider: EmbeddingProvider = {
      id: "fixture-margin",
      async embed(text: string) {
        if (text.includes("murky")) return [0.7, 0.714];
        if (text === "alpha one" || text === "beta two") return [1, 0];
        if (text === "gamma" || text === "delta") return [-0.0471, 0.9989];
        return [0, -1];
      },
    };
    const strict = createEmbeddingDetector(provider, {
      examples: SIM_EXAMPLES,
      thresholds: { accept: 0.6, margin: 0.1 },
    });
    expect(await strict.detectAsync("consider murky stuff", noBudget())).toEqual([]);

    const loose = createEmbeddingDetector(provider, {
      examples: SIM_EXAMPLES,
      thresholds: { accept: 0.6, margin: 0.01 },
    });
    const refs = await loose.detectAsync("consider murky stuff", noBudget());
    expect(refs.length).toBe(1);
    expect((refs[0] as DanglingRef).expectedType).toBe("code-symbol");
  });

  it("非法配置在构造期受控失败", () => {
    const provider: EmbeddingProvider = { id: "fixture-config", embed: async () => [1, 0, 0] };
    expect(() =>
      createEmbeddingDetector(provider, { examples: EXAMPLES, thresholds: { accept: 1.5, margin: 0.1 } }),
    ).toThrow();
    expect(() =>
      createEmbeddingDetector(provider, { examples: EXAMPLES, thresholds: { accept: 0.6, margin: -0.1 } }),
    ).toThrow();
    expect(() => createEmbeddingDetector(provider, { examples: [] })).toThrow();
    expect(() =>
      createEmbeddingDetector(provider, { examples: [{ text: "只有负例", type: "negative" }] }),
    ).toThrow();
    expect(() => createEmbeddingDetector(provider, { examples: [{ text: "", type: "code-symbol" }] })).toThrow();
  });
});
