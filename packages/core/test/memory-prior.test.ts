import { describe, expect, it } from "vitest";
import { autoResolvePriorCandidate, disambiguationWeights, PRIOR_WINDOW_DAYS, rankByPrior } from "../src/memory.js";
import type { Candidate, DisambiguationPrior } from "../src/types.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 15, 12);

function prior(sessionId: string, daysAgo: number, projectKey = "/work/proj"): DisambiguationPrior {
  return { projectKey, sessionId, title: `会话 ${sessionId}`, at: new Date(NOW - daysAgo * DAY).toISOString() };
}

function historyCandidate(id: string): Candidate {
  return {
    id,
    label: `label-${id}`,
    value: { type: "history-event", sessionId: id, title: `title-${id}`, at: "2026-09-14T00:00:00.000Z" },
  };
}

function fileCandidate(id: string): Candidate {
  return { id, label: `label-${id}`, value: { type: "file", path: `/tmp/${id}.ts` } };
}

describe("disambiguationWeights（先验加权）", () => {
  it("只统计同项目记录；窗口外记录忽略；无效时间忽略", () => {
    const priors = [
      prior("s1", 1),
      prior("s1", 3, "/other/project"), // 异项目：不计
      prior("s2", PRIOR_WINDOW_DAYS + 0.5), // 窗口外：不计
      { ...prior("s3", 1), at: "not-a-date" }, // 无效时间：不计
    ];
    const weights = disambiguationWeights(priors, "/work/proj", NOW);
    expect(weights.get("s1")).toEqual({ count: 1, score: 1 + 13 / 14 });
    expect(weights.has("s2")).toBe(false);
    expect(weights.has("s3")).toBe(false);
  });

  it("窗口边界（恰 14 天）计入，近期选择权重高", () => {
    const weights = disambiguationWeights(
      [prior("edge", PRIOR_WINDOW_DAYS), prior("fresh", 0), prior("mid", 7)],
      "/work/proj",
      NOW,
    );
    expect(weights.get("edge")?.score).toBeCloseTo(1, 10); // 1 + 0/14
    expect(weights.get("fresh")?.score).toBeCloseTo(2, 10); // 1 + 14/14
    expect(weights.get("mid")?.score).toBeCloseTo(1.5, 10); // 1 + 7/14
  });

  it("同一会话多次选择累积 count 与 score；未来时间戳按当下计（时钟偏移容错）", () => {
    const weights = disambiguationWeights(
      [prior("s1", 1), prior("s1", 2), { ...prior("s2", 1), at: new Date(NOW + DAY).toISOString() }],
      "/work/proj",
      NOW,
    );
    expect(weights.get("s1")?.count).toBe(2);
    expect(weights.get("s1")?.score).toBeCloseTo(2 + 13 / 14 + 12 / 14, 10);
    expect(weights.get("s2")?.count).toBe(1);
    expect(weights.get("s2")?.score).toBeCloseTo(2, 10);
  });
});

describe("autoResolvePriorCandidate（保守自动解析）", () => {
  it("同项目同会话 14 天内 ≥2 次、权重 ≥2× 次选 → 自动解析该候选", () => {
    const candidates = [historyCandidate("s1"), historyCandidate("s2"), historyCandidate("s3")];
    const weights = disambiguationWeights([prior("s2", 1), prior("s2", 2)], "/work/proj", NOW);
    const auto = autoResolvePriorCandidate(candidates, weights);
    expect(auto?.candidate.id).toBe("s2");
    expect(auto?.weight.count).toBe(2);
  });

  it("仅 1 次选择不自动解析（次数门槛）", () => {
    const weights = disambiguationWeights([prior("s2", 1)], "/work/proj", NOW);
    expect(autoResolvePriorCandidate([historyCandidate("s1"), historyCandidate("s2")], weights)).toBeNull();
  });

  it("权重不显著高于次选（<2×）不自动解析", () => {
    // s1：两次较久远 ≈ 1.93 + 1.86 = 3.79；s2：今天一次 = 2.0；3.79 < 4.0
    const weights = disambiguationWeights([prior("s1", 1), prior("s1", 2), prior("s2", 0)], "/work/proj", NOW);
    expect(autoResolvePriorCandidate([historyCandidate("s1"), historyCandidate("s2")], weights)).toBeNull();
  });

  it("先验会话不在候选集内 → 不注入（红线：只作用于已有显式指代的候选）", () => {
    const weights = disambiguationWeights([prior("ghost", 1), prior("ghost", 2)], "/work/proj", NOW);
    expect(autoResolvePriorCandidate([historyCandidate("s1"), historyCandidate("s2")], weights)).toBeNull();
  });

  it("候选值非 history-event → 不自动解析（先验只服务会话消歧）", () => {
    const weights = disambiguationWeights([prior("f2", 1), prior("f2", 2)], "/work/proj", NOW);
    expect(autoResolvePriorCandidate([fileCandidate("f1"), fileCandidate("f2")], weights)).toBeNull();
  });

  it("权重并列 → 不自动解析（不确定时不替用户猜）", () => {
    const weights = disambiguationWeights([prior("s1", 1), prior("s2", 1)], "/work/proj", NOW);
    expect(autoResolvePriorCandidate([historyCandidate("s1"), historyCandidate("s2")], weights)).toBeNull();
  });
});

describe("rankByPrior（候选按先验加权排序）", () => {
  it("权重高者在前；零权重保持原顺序（稳定）", () => {
    const candidates = [historyCandidate("s1"), historyCandidate("s2"), historyCandidate("s3")];
    const weights = disambiguationWeights([prior("s3", 1)], "/work/proj", NOW);
    const ordered = rankByPrior(candidates, weights);
    expect(ordered.map((c) => c.id)).toEqual(["s3", "s1", "s2"]);
    // 原数组不被改动
    expect(candidates.map((c) => c.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("无先验 → 原顺序", () => {
    const candidates = [historyCandidate("s1"), historyCandidate("s2")];
    expect(rankByPrior(candidates, new Map())).toEqual(candidates);
  });
});
