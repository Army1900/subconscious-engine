import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { FakeInteract, stubSource } from "./helpers.js";

/**
 * 验收矩阵「获取」行：显式引用 + 缺数据 + 确认才执行；取消后不再读取/持久化。
 * 交互调用顺序：confirm → acquire；M1 的 acquire 由宿主实现（pi 归 M2）。
 */

const spec = {
  kind: "pick-image" as const,
  prompt: "需要一张花的照片",
  expectedType: "image" as const,
};

function acquireSource(resolveLog: string[]) {
  return stubSource({
    id: "photo-taker",
    types: ["image"],
    permission: "L3-acquire",
    resolve: () => {
      resolveLog.push("source:resolve");
      return { status: "need-acquisition" as const, acquisition: spec };
    },
  });
}

const detector = {
  detect: (p: string) =>
    p.includes("那张图")
      ? [{ id: "r", span: [0, 3] as const, text: p.slice(0, 3), expectedType: "image" as const, confidence: 0.9 }]
      : [],
};

describe("获取动作纪律（confirm → acquire）", () => {
  it("确认后才执行获取，取回的值成为 resolved", async () => {
    const resolveLog: string[] = [];
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    interact.acquireResult = {
      type: "image",
      path: "/tmp/flower.jpg",
      mediaType: "image/jpeg",
      base64: "QUJD",
    };
    const engine = createEngine({ detector, sources: [acquireSource(resolveLog)], interact });

    const out = await engine.enrich("那张图看看", { cwd: "/tmp" });

    expect(interact.log).toEqual([`confirm:需要补充数据：${spec.prompt}，现在获取？`, `acquire:${spec.prompt}`]);
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.attachments).toEqual([{ mediaType: "image/jpeg", base64: "QUJD" }]);
    // base64 绝不进入文本通道
    expect(out.context).toBeDefined();
    expect(out.context).not.toContain("QUJD");
  });

  it("用户拒绝 → acquire 不执行，无读取", async () => {
    const resolveLog: string[] = [];
    const interact = new FakeInteract();
    interact.confirmResult = "no";
    const engine = createEngine({ detector, sources: [acquireSource(resolveLog)], interact });

    const out = await engine.enrich("那张图看看", { cwd: "/tmp" });
    expect(interact.log.length).toBe(1); // 只有 confirm
    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons?.["ref-1"]).toBe("acquisition-declined");
  });

  it("confirm 能力缺失（unsupported）→ 放弃，不执行 acquire", async () => {
    const interact = new FakeInteract();
    interact.confirmResult = "unsupported";
    const engine = createEngine({ detector, sources: [acquireSource([])], interact });
    const out = await engine.enrich("那张图看看", { cwd: "/tmp" });
    expect(interact.log.length).toBe(1);
    expect(out.dropReasons?.["ref-1"]).toBe("interaction-unsupported");
  });

  it("acquire 取消（null）→ 放弃", async () => {
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    interact.acquireResult = null;
    const engine = createEngine({ detector, sources: [acquireSource([])], interact });
    const out = await engine.enrich("那张图看看", { cwd: "/tmp" });
    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons?.["ref-1"]).toBe("acquisition-declined");
  });

  it("默认（未提供 interact）→ unsupported 降级，不抛出", async () => {
    const engine = createEngine({ detector, sources: [acquireSource([])] });
    const out = await engine.enrich("那张图看看", { cwd: "/tmp" });
    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons?.["ref-1"]).toBe("interaction-unsupported");
    expect(out.context).toBeUndefined();
  });
});
