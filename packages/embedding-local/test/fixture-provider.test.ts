import { describe, expect, it } from "vitest";
import {
  createFixtureKeywordProvider,
  fixtureEmbed,
  FIXTURE_DIMENSION,
  FIXTURE_PROVIDER_ID,
} from "../src/fixture-provider.js";
import { createEmbeddingDetector } from "@subconscious/core";

/**
 * 确定性关键词 fixture provider：离线评估与演示的"本地向量"替身。
 * 纪律：纯函数、无 node API、无网络、无文件；同文本必得同向量。
 */

describe("fixture keyword provider", () => {
  it("确定性：同文本同向量；维度恒定；全部有限且已归一化", () => {
    const a = fixtureEmbed("那个方法");
    const b = fixtureEmbed("那个方法");
    expect(a).toEqual(b);
    expect(a.length).toBe(FIXTURE_DIMENSION);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    for (const x of a) expect(Number.isFinite(x)).toBe(true);
  });

  it("类型词命中对应轴；无关键词文本落噪声轴", () => {
    const cs = fixtureEmbed("那个方法");
    expect(cs[0]).toBeCloseTo(1, 6);
    const noise = fixtureEmbed("你好呀");
    expect(noise[FIXTURE_DIMENSION - 1]).toBeCloseTo(1, 6);
  });

  it("拉丁词按 token 精确匹配（lastIndexOf 不命中 last）", () => {
    const he = fixtureEmbed("our previous discussion");
    expect(he[4]).toBeCloseTo(1, 6);
    const noise = fixtureEmbed("lastIndexOf 的复杂度");
    expect(noise[FIXTURE_DIMENSION - 1]).toBeCloseTo(1, 6);
  });

  it("作为 provider 接入 core 检测器：规则外表述可检出", async () => {
    const provider = createFixtureKeywordProvider();
    expect(provider.id).toBe(FIXTURE_PROVIDER_ID);
    const detector = createEmbeddingDetector(provider, { thresholds: { accept: 0.6, margin: 0.2 } });
    const refs = await detector.detectAsync("照老规矩处理这段代码");
    const types = refs.map((r) => r.expectedType);
    expect(types).toContain("history-content");
    expect(types).toContain("code-symbol");
  });
});
