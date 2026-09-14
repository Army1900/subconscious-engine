import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { createRuleDetector } from "../src/detector.js";
import { DEFAULT_SOURCES } from "../src/sources/index.js";
import { FakeInteract, RecordingGrants, recordingEnv, recordingSource } from "./helpers.js";

/**
 * 验收矩阵「无指代」行：原始 prompt 不变；source/交互/grants 无调用。
 * 无指代 → no-op 透传，零数据源读取、零授权查询、零交互。
 */

describe("无指代：零 source/grant/interact 调用", () => {
  const noRefPrompts = [
    "你好",
    "解释快速排序",
    "This is a test",
    "请帮我写一个排序算法并解释复杂度",
    "🙂 今天天气怎么样",
  ];

  for (const prompt of noRefPrompts) {
    it(`"${prompt}" → 无注入且零调用`, async () => {
      const wrapped = DEFAULT_SOURCES.map((s) => recordingSource(s));
      const grants = new RecordingGrants();
      const interact = new FakeInteract();
      const { env, calls } = recordingEnv({
        cwd: "/tmp/proj",
        activeEditor: { path: "/tmp/proj/src/api.ts", line: 42 },
        listRecentSessions: async () => {
          throw new Error("无指代时不得读取会话");
        },
        readSessionContent: async () => {
          throw new Error("无指代时不得读取会话内容");
        },
        readCwdContext: async () => {
          throw new Error("无指代时不得读取 cwd");
        },
      });

      const engine = createEngine({
        sources: wrapped.map((w) => w.source),
        grants,
        interact,
      });
      const out = await engine.enrich(prompt, env);

      expect(out.context).toBeUndefined();
      expect(out.attachments).toBeUndefined();
      expect(out.resolvedRefs).toEqual([]);
      expect(out.droppedRefs).toEqual([]);
      // 零调用（source / provider / grants / interact 全部）
      expect(calls).toEqual([]);
      expect(wrapped.flatMap((w) => w.calls)).toEqual([]);
      expect(grants.log).toEqual([]);
      expect(interact.log).toEqual([]);
    });
  }

  it("空字符串与空白话语同样零调用", async () => {
    const grants = new RecordingGrants();
    const interact = new FakeInteract();
    const wrapped = DEFAULT_SOURCES.map((s) => recordingSource(s));
    const engine = createEngine({ sources: wrapped.map((w) => w.source), grants, interact });
    for (const prompt of ["", "   "]) {
      const out = await engine.enrich(prompt, { cwd: "/tmp" });
      expect(out.context).toBeUndefined();
      expect(out.resolvedRefs).toEqual([]);
    }
    expect(grants.log).toEqual([]);
    expect(interact.log).toEqual([]);
    expect(wrapped.flatMap((w) => w.calls)).toEqual([]);
  });

  it("低置信指代被丢弃且不触发任何调用", async () => {
    // 自定义检测器返回低置信指代：引擎必须透传而非解析（DESIGN §4.1）
    const lowConfidenceDetector = {
      detect: (prompt: string) =>
        prompt.includes("那啥")
          ? [
              {
                id: "x",
                span: [0, 2] as const,
                text: prompt.slice(0, 2),
                expectedType: "file" as const,
                confidence: 0.2,
              },
            ]
          : [],
    };
    const grants = new RecordingGrants();
    const interact = new FakeInteract();
    const wrapped = DEFAULT_SOURCES.map((s) => recordingSource(s));
    const engine = createEngine({
      detector: lowConfidenceDetector,
      sources: wrapped.map((w) => w.source),
      grants,
      interact,
    });
    const out = await engine.enrich("那啥帮我看看", { cwd: "/tmp" });
    expect(out.context).toBeUndefined();
    expect(out.resolvedRefs).toEqual([]);
    expect(out.droppedRefs.length).toBe(1);
    expect(out.dropReasons?.[out.droppedRefs[0] ?? ""]).toBe("low-confidence");
    expect(grants.log).toEqual([]);
    expect(interact.log).toEqual([]);
    expect(wrapped.flatMap((w) => w.calls)).toEqual([]);
  });

  it("minConfidence 调高后规则检测器的结果也全部透传", async () => {
    const grants = new RecordingGrants();
    const interact = new FakeInteract();
    const engine = createEngine({
      detector: createRuleDetector(),
      sources: DEFAULT_SOURCES,
      grants,
      interact,
      limits: { minConfidence: 0.99 },
    });
    const out = await engine.enrich("把这个函数改成和上次一样的错误处理", { cwd: "/tmp" });
    expect(out.context).toBeUndefined();
    expect(out.resolvedRefs).toEqual([]);
    expect(grants.log).toEqual([]);
    expect(interact.log).toEqual([]);
  });
});
