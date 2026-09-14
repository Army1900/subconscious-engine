import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { InMemoryGrantStore } from "../src/grants.js";
import { DEFAULT_SOURCES } from "../src/sources/index.js";
import type { DataSource, Resolution } from "../src/types.js";
import { FakeInteract, RecordingGrants, stubSource } from "./helpers.js";

/**
 * 监督整改 3：同一类型可注册多个 sources，按注册顺序尝试。
 * 继续/停止策略（DECISIONS D13）：
 * - not-found / 非法形状 / 源抛错 / interaction-unsupported → 尝试后源（fail-open，单源错误不损失其他可用源）；
 * - 权限拒绝 / 用户取消 / 获取拒绝 / budget-exhausted → 停止（用户决定与预算红线优先于 fail-open）；
 * - 每个源在调用前单独过权限检查。
 */

const PROMPT = "分析这个项目";

function projectResult(id: string): Resolution {
  return {
    status: "resolved",
    value: { type: "project", cwd: `/tmp/${id}`, summary: `${id} 的项目摘要` },
    display: `${id} 的项目摘要`,
  };
}

describe("按注册顺序尝试后源（fail-open）", () => {
  it("首源 not-found → 后源解析成功", async () => {
    const calls: string[] = [];
    const first = stubSource({
      id: "first",
      types: ["project"],
      resolve: () => {
        calls.push("first");
        return { status: "not-found" };
      },
    });
    const second = stubSource({
      id: "second",
      types: ["project"],
      resolve: () => {
        calls.push("second");
        return projectResult("second");
      },
    });
    const engine = createEngine({ sources: [first, second] });
    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(calls).toEqual(["first", "second"]);
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toContain("second 的项目摘要");
    expect(out.context).toContain("来源：second");
  });

  it("首源抛错 → 后源解析成功（不因单源错误丢掉同类型其他可用源）", async () => {
    const logs: string[] = [];
    const broken = stubSource({
      id: "broken",
      types: ["project"],
      resolve: () => {
        throw new Error("源内部崩溃");
      },
    });
    const good = stubSource({ id: "good", types: ["project"], resolve: () => projectResult("good") });
    const engine = createEngine({ sources: [broken, good], logger: (e) => logs.push(`${e.level}:${e.event}`) });
    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toContain("good 的项目摘要");
    expect(logs).toContain("warn:source-error");
  });

  it("首源返回非法四态形状 → 受控丢弃并尝试后源", async () => {
    const garbage = stubSource({
      id: "garbage",
      types: ["project"],
      resolve: () => ({ status: "weird" }) as unknown as Resolution,
    });
    const good = stubSource({ id: "good", types: ["project"], resolve: () => projectResult("good") });
    const engine = createEngine({ sources: [garbage, good] });
    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toContain("good 的项目摘要");
  });

  it("首源 resolved → 后源不再被调用（顺序短路）", async () => {
    const calls: string[] = [];
    const first = stubSource({
      id: "first",
      types: ["project"],
      resolve: () => {
        calls.push("first");
        return projectResult("first");
      },
    });
    const second = stubSource({
      id: "second",
      types: ["project"],
      resolve: () => {
        calls.push("second");
        return projectResult("second");
      },
    });
    const engine = createEngine({ sources: [first, second] });
    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(calls).toEqual(["first"]);
    expect(out.context).toContain("来源：first");
  });

  it("全部源 not-found → 丢弃原因为 not-found；全部抛错 → error", async () => {
    const empty1 = stubSource({ id: "e1", types: ["project"], resolve: () => ({ status: "not-found" }) });
    const empty2 = stubSource({ id: "e2", types: ["project"], resolve: () => ({ status: "not-found" }) });
    const engine = createEngine({ sources: [empty1, empty2] });
    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });
    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons?.["ref-1"]).toBe("not-found");

    const boom1 = stubSource({ id: "b1", types: ["project"], resolve: () => Promise.reject(new Error("x")) });
    const boom2 = stubSource({ id: "b2", types: ["project"], resolve: () => Promise.reject(new Error("y")) });
    const engine2 = createEngine({ sources: [boom1, boom2] });
    const out2 = await engine2.enrich(PROMPT, { cwd: "/tmp" });
    expect(out2.dropReasons?.["ref-1"]).toBe("error");
  });
});

describe("权限与交互的继续/停止策略", () => {
  it("首源 L1 用户拒绝 → 停止尝试后源（尊重用户拒绝，不绕过再读）", async () => {
    const laterReads: string[] = [];
    const gated = stubSource({
      id: "gated",
      types: ["project"],
      permission: "L1-grant-once",
      resolve: () => {
        throw new Error("拒绝后不得读取");
      },
    });
    const open = stubSource({
      id: "open",
      types: ["project"],
      resolve: () => {
        laterReads.push("open");
        return projectResult("open");
      },
    });
    const interact = new FakeInteract();
    interact.confirmResult = "no";
    const engine = createEngine({ sources: [gated, open], interact });
    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(laterReads).toEqual([]); // 后源未被调用
    expect(out.dropReasons?.["ref-1"]).toBe("permission-denied");
    expect(out.context).toBeUndefined();
  });

  it("首源 L1 无 UI（unsupported）→ 继续后源 L0 并解析（环境限制≠用户拒绝）", async () => {
    const gatedReads: string[] = [];
    const gated = stubSource({
      id: "gated",
      types: ["project"],
      permission: "L1-grant-once",
      resolve: () => {
        gatedReads.push("gated");
        return projectResult("gated");
      },
    });
    const open = stubSource({ id: "open", types: ["project"], resolve: () => projectResult("open") });
    const grants = new RecordingGrants();
    const engine = createEngine({ sources: [gated, open], grants }); // 默认 interact 全 unsupported
    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(gatedReads).toEqual([]); // 首源未过闸，未读取
    expect(grants.log).toEqual(["has:gated"]); // 首源单独查过授权
    expect(out.resolvedRefs.length).toBe(1); // 后源 L0 免授权解析成功
    expect(out.context).toContain("来源：open");
  });

  it("每个源在调用前单独过权限检查（两个 L1：已授权者直读，未授权者 confirm 后写授权）", async () => {
    const store = new InMemoryGrantStore();
    await store.grant({ sourceId: "secret-a" }); // 首源已有授权
    const grants = new RecordingGrants(store);
    const reads: string[] = [];
    const a = stubSource({
      id: "secret-a",
      types: ["project"],
      permission: "L1-grant-once",
      resolve: () => {
        reads.push("a");
        return { status: "not-found" }; // 已授权但没找到 → 继续后源
      },
    });
    const b = stubSource({
      id: "secret-b",
      types: ["project"],
      permission: "L1-grant-once",
      resolve: () => {
        reads.push("b");
        return projectResult("secret-b");
      },
    });
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    const engine = createEngine({ sources: [a, b], grants, interact });
    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(reads).toEqual(["a", "b"]);
    expect(grants.log).toEqual(["has:secret-a", "has:secret-b", "grant:secret-b"]); // 每源单独过闸
    expect(interact.log.length).toBe(1);
    expect(interact.log[0]).toContain("secret-b"); // 确认提示指向后源
    expect(out.context).toContain("来源：secret-b");
  });

  it("首源 ambiguous 且 select 不可用（unsupported）→ 继续后源直接解析，不注入候选猜测", async () => {
    const ambiguous = stubSource({
      id: "amb",
      types: ["project"],
      resolve: () => ({
        status: "ambiguous",
        candidates: [{ id: "c1", label: "候选一", value: { type: "project", cwd: "/x", summary: "一" } }],
      }),
    });
    const direct = stubSource({ id: "direct", types: ["project"], resolve: () => projectResult("direct") });
    const engine = createEngine({ sources: [ambiguous, direct] }); // 无 UI
    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toContain("来源：direct");
    expect(out.context).not.toContain("候选一");
  });

  it("真实源栈也允许多源共存：DEFAULT_SOURCES + 追加同类源不互相挤占", async () => {
    const extra = stubSource({
      id: "extra-project",
      types: ["project"],
      resolve: () => projectResult("extra-project"),
    });
    // cwd-context（首源）命中 → 短路，extra-project 不再被调用
    const engine = createEngine({ sources: [...DEFAULT_SOURCES, extra as DataSource] });
    const out = await engine.enrich(PROMPT, {
      cwd: "/tmp",
      readCwdContext: async () => ({ cwd: "/tmp/proj", dirSummary: "目录概览" }),
    });
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toContain("来源：cwd-context");

    // cwd-context 不可用（provider 返回 null）→ 追加源接管，不因首源 not-found 丢指代
    const engine2 = createEngine({ sources: [...DEFAULT_SOURCES, extra as DataSource] });
    const out2 = await engine2.enrich(PROMPT, { cwd: "/tmp", readCwdContext: async () => null });
    expect(out2.resolvedRefs.length).toBe(1);
    expect(out2.context).toContain("来源：extra-project");
  });
});
