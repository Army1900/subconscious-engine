import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { createRuleDetector } from "../src/detector.js";
import { DEFAULT_SOURCES } from "../src/sources/index.js";
import { recordingEnv } from "./helpers.js";

/**
 * 监督者 holdout 行为用例（.supervision/detector-holdout.json）。
 * expected = 显式指代必须被检出（不保证解析成功）；负例必须零指代；
 * ambiguous 用例在 UI unsupported 时不得猜测。
 */

interface HoldoutCase {
  prompt: string;
  mustInclude: string[];
  minimumRefs?: number;
}

interface Holdout {
  positive: HoldoutCase[];
  negative: string[];
  ambiguousMustNotGuess: string[];
  m3SeparateFromM1: string[];
}

function loadHoldout(): Holdout {
  const raw = readFileSync(new URL("../../../.supervision/detector-holdout.json", import.meta.url), "utf8");
  const data: unknown = JSON.parse(raw);
  if (typeof data !== "object" || data === null) throw new Error("holdout JSON 形状非法");
  const h = data as Partial<Holdout>;
  if (!Array.isArray(h.positive) || !Array.isArray(h.negative)) throw new Error("holdout JSON 缺少正/负例");
  return {
    positive: h.positive,
    negative: h.negative,
    ambiguousMustNotGuess: h.ambiguousMustNotGuess ?? [],
    m3SeparateFromM1: h.m3SeparateFromM1 ?? [],
  };
}

const holdout = loadHoldout();
const detector = createRuleDetector();

describe("holdout：正例（显式指代必须检出）", () => {
  for (const testCase of holdout.positive) {
    it(`"${testCase.prompt}" 包含 ${testCase.mustInclude.join(",")}`, () => {
      const refs = detector.detect(testCase.prompt);
      const types = refs.map((r) => r.expectedType);
      for (const must of testCase.mustInclude) {
        expect(types).toContain(must);
      }
      if (testCase.minimumRefs !== undefined) {
        expect(refs.length).toBeGreaterThanOrEqual(testCase.minimumRefs);
      }
      // span 一致性（每一例都真实）
      for (const ref of refs) {
        expect(testCase.prompt.slice(ref.span[0], ref.span[1])).toBe(ref.text);
      }
    });
  }
});

describe("holdout：负例（必须零指代）", () => {
  for (const prompt of holdout.negative) {
    it(`"${prompt}" → 零指代`, () => {
      expect(detector.detect(prompt)).toEqual([]);
    });
  }
});

describe("holdout：ambiguous 用例在 UI unsupported 时不猜测", () => {
  for (const prompt of holdout.ambiguousMustNotGuess) {
    it(`"${prompt}" → 不注入任何确定结论`, async () => {
      const { env, calls } = recordingEnv({
        cwd: "/tmp/proj",
        listRecentSessions: async () => [
          { id: "s1", title: "改错误处理", at: "2026-09-10T10:00:00.000Z" },
          { id: "s2", title: "另一个会话", at: "2026-09-09T10:00:00.000Z" },
        ],
        readSessionContent: async () => null,
      });
      const engine = createEngine({ sources: DEFAULT_SOURCES }); // 无 interact → 全 unsupported
      const out = await engine.enrich(prompt, env);
      // 多候选未消歧 + UI 不可用：不产生 resolved 注入（不猜测）
      expect(out.resolvedRefs).toEqual([]);
      expect(out.context).toBeUndefined();
      expect(out.attachments).toBeUndefined();
      // 历史内容在无绑定下不得读取
      expect(calls.some((c) => c.startsWith("readSessionContent"))).toBe(false);
    });
  }
});

describe("holdout：M3 专属表述不在 M1 规则内强行检出", () => {
  for (const prompt of holdout.m3SeparateFromM1) {
    it(`"${prompt}" → M1 规则零指代（不臆测）`, () => {
      expect(detector.detect(prompt)).toEqual([]);
    });
  }
});
