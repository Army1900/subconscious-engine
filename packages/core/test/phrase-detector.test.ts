import { describe, expect, it } from "vitest";
import { createRuleDetector, isAsyncDetector } from "../src/detector.js";
import { createPersonalPhraseDetector } from "../src/phrase-detector.js";
import type { DanglingRef, Detector, PersonalPhrase } from "../src/types.js";

const LEXICON: readonly PersonalPhrase[] = [
  { phrase: "咱们那个摊子", expectedType: "project" },
  { phrase: "上次的需求", expectedType: "history-content" },
];

describe("createPersonalPhraseDetector（个人惯用语词典·运行时扩展）", () => {
  it("命中个人短语 → 产出带真实 span 的 DanglingRef，类型取自词条", () => {
    const detector = createPersonalPhraseDetector(createRuleDetector(), LEXICON);
    const prompt = "在咱们那个摊子里把登录修一下";
    const refs = detector.detect(prompt);
    expect(refs.length).toBe(1);
    const ref = refs[0] as DanglingRef;
    expect(ref.text).toBe("咱们那个摊子");
    expect(prompt.slice(ref.span[0], ref.span[1])).toBe("咱们那个摊子");
    expect(ref.expectedType).toBe("project");
    expect(ref.confidence).toBeGreaterThan(0.9);
  });

  it("同一短语多次出现 → 多个指代；span 与原文切片一致且互不重叠", () => {
    const detector = createPersonalPhraseDetector(createRuleDetector(), LEXICON);
    const prompt = "咱们那个摊子的文档呢，咱们那个摊子叫什么来着";
    const refs = detector.detect(prompt);
    expect(refs.map((r) => r.text)).toEqual(["咱们那个摊子", "咱们那个摊子"]);
    for (const ref of refs) {
      expect(prompt.slice(ref.span[0], ref.span[1])).toBe(ref.text);
    }
    expect(refs[0]?.span[1] ?? 0).toBeLessThanOrEqual(refs[1]?.span[0] ?? 0);
  });

  it("未命中短语 → 输出与被包装检测器逐字节一致（零开销透传不变）", () => {
    const base = createRuleDetector();
    const detector = createPersonalPhraseDetector(base, LEXICON);
    const prompt = "把这个函数改成和上次一样的错误处理";
    expect(detector.detect(prompt)).toEqual(base.detect(prompt));
  });

  it("个人短语与规则词典重叠时个人短语优先", () => {
    const detector = createPersonalPhraseDetector(createRuleDetector(), LEXICON);
    // 规则版会把 "上次" 判为 history-event；个人短语 "上次的需求"（history-content）覆盖之
    const refs = detector.detect("把上次的需求再过一遍");
    expect(refs.length).toBe(1);
    expect(refs[0]?.text).toBe("上次的需求");
    expect(refs[0]?.expectedType).toBe("history-content");
  });

  it("个人短语与非重叠规则命中合并共存，按出现位置排序", () => {
    const detector = createPersonalPhraseDetector(createRuleDetector(), LEXICON);
    const refs = detector.detect("上次说过的东西在咱们那个摊子里怎么找");
    expect(refs.map((r) => r.text)).toEqual(["上次", "咱们那个摊子"]);
    expect(refs.map((r) => r.expectedType)).toEqual(["history-event", "project"]);
  });

  it("非法词条被跳过（不抛出）；全部非法或空词典 → 原样返回被包装检测器", () => {
    const base = createRuleDetector();
    const bad = [
      { phrase: "", expectedType: "project" },
      { phrase: "  ", expectedType: "project" },
      { phrase: "好词条", expectedType: "not-a-type" as PersonalPhrase["expectedType"] },
    ] as unknown as readonly PersonalPhrase[];
    const detector = createPersonalPhraseDetector(base, bad);
    expect(detector.detect("好词条 咱们看看")).toEqual(base.detect("好词条 咱们看看"));
    expect(createPersonalPhraseDetector(base, []).detect("随便说点什么")).toEqual(base.detect("随便说点什么"));
  });

  it("包装异步检测器：detectAsync 合并短语命中且仍被识别为 AsyncDetector；同步契约保持", async () => {
    const asyncRef: DanglingRef = {
      id: "x",
      span: [0, 4] as readonly [number, number],
      text: "那个架构",
      expectedType: "project",
      confidence: 0.8,
    };
    const base: Detector & { detectAsync(prompt: string): Promise<readonly DanglingRef[]> } = {
      detect: () => [],
      async detectAsync(prompt: string) {
        // 模拟 embedding 命中：只在特定句子出现
        return prompt.includes("那个架构") ? [asyncRef] : [];
      },
    };
    const detector = createPersonalPhraseDetector(base, LEXICON);
    if (!isAsyncDetector(detector)) throw new Error("包装异步基座后仍应是 AsyncDetector");

    const prompt = "那个架构在咱们那个摊子里落地了吗";
    const viaAsync = await detector.detectAsync(prompt);
    expect(viaAsync.map((r) => r.text)).toEqual(["那个架构", "咱们那个摊子"]);
    // 同步契约恒可用：基座同步零命中 → 只剩短语命中
    expect(detector.detect(prompt).map((r) => r.text)).toEqual(["咱们那个摊子"]);
  });
});
