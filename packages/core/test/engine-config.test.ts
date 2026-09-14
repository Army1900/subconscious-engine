import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { EngineConfigError } from "../src/errors.js";
import { DataSourceRegistry } from "../src/registry.js";
import type { DataSource, EngineLimits } from "../src/types.js";
import { stubSource } from "./helpers.js";

/**
 * 监督整改 5：构造期配置校验。
 * - registry 运行时校验 permission 必须是四个允许值（JS 消费者可能传任意字符串/缺省）；
 * - createEngine 校验合并后的 limits 为有限正数（minConfidence 0..1，其余正整数），
 *   防止负 timeout / NaN 绕过超时与置信度纪律。
 */

describe("registry：permission 运行时校验（四个允许值）", () => {
  it("非法授权级别抛 EngineConfigError(invalid-permission)", () => {
    const reg = new DataSourceRegistry();
    const bad = {
      id: "bad-perm",
      types: ["file"],
      permission: "L9-root",
      resolve: async () => ({ status: "not-found" as const }),
    } as unknown as DataSource;
    expect(() => reg.register(bad)).toThrow(EngineConfigError);
    try {
      reg.register(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EngineConfigError);
      expect((err as EngineConfigError).code).toBe("invalid-permission");
    }
  });

  it("permission 缺省（undefined）同样受控失败", () => {
    const reg = new DataSourceRegistry();
    const noPerm = {
      id: "no-perm",
      types: ["file"],
      resolve: async () => ({ status: "not-found" as const }),
    } as unknown as DataSource;
    try {
      reg.register(noPerm);
      expect.unreachable();
    } catch (err) {
      expect((err as EngineConfigError).code).toBe("invalid-permission");
    }
  });

  it("四个合法值均可注册；createEngine 同样受控", () => {
    const reg = new DataSourceRegistry();
    const levels = ["L0-free", "L1-grant-once", "L2-confirm-each", "L3-acquire"] as const;
    for (const p of levels) {
      reg.register(stubSource({ id: `ok-${p}`, types: ["file"], permission: p }));
    }
    expect(reg.list().length).toBe(4);

    expect(() =>
      createEngine({
        sources: [
          {
            id: "x",
            types: ["file"],
            permission: "L4-super",
            resolve: async () => ({ status: "not-found" as const }),
          } as unknown as DataSource,
        ],
      }),
    ).toThrow(EngineConfigError);
  });
});

describe("createEngine：limits 校验（有限正数，防 NaN/负值绕过纪律）", () => {
  const badCases: ReadonlyArray<readonly [string, Partial<EngineLimits>]> = [
    ["负 timeoutMs", { timeoutMs: -1 }],
    ["零 timeoutMs", { timeoutMs: 0 }],
    ["NaN timeoutMs", { timeoutMs: Number.NaN }],
    ["Infinity timeoutMs", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["非整数 timeoutMs", { timeoutMs: 100.5 }],
    ["负 interactTimeoutMs", { interactTimeoutMs: -5 }],
    ["NaN interactTimeoutMs", { interactTimeoutMs: Number.NaN }],
    ["负 minConfidence", { minConfidence: -0.01 }],
    ["超 1 的 minConfidence", { minConfidence: 1.5 }],
    ["NaN minConfidence", { minConfidence: Number.NaN }],
    ["Infinity minConfidence", { minConfidence: Number.POSITIVE_INFINITY }],
    ["零 maxContextChars", { maxContextChars: 0 }],
    ["负 maxSourceBytes", { maxSourceBytes: -64000 }],
    ["NaN maxListItems", { maxListItems: Number.NaN }],
    ["非整数 maxCandidates", { maxCandidates: 2.5 }],
    ["零 maxDiffEntries", { maxDiffEntries: 0 }],
    ["字符串 maxRefDisplayChars（JS）", { maxRefDisplayChars: "1200" as unknown as number }],
  ];

  for (const [name, limits] of badCases) {
    it(`${name} → EngineConfigError(invalid-limits)`, () => {
      try {
        createEngine({ sources: [], limits });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(EngineConfigError);
        expect((err as EngineConfigError).code).toBe("invalid-limits");
      }
    });
  }

  it("minConfidence 边界 0 与 1 合法；合法自定义 limits 可构造并运行", async () => {
    expect(() => createEngine({ sources: [], limits: { minConfidence: 0 } })).not.toThrow();
    expect(() => createEngine({ sources: [], limits: { minConfidence: 1 } })).not.toThrow();
    const engine = createEngine({
      sources: [],
      limits: { timeoutMs: 500, interactTimeoutMs: 1000, maxContextChars: 2000 },
    });
    const out = await engine.enrich("没有任何指代的普通话语", { cwd: "/tmp" });
    expect(out.resolvedRefs).toEqual([]);
  });
});
