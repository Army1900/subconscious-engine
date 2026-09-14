import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { InMemoryGrantStore } from "../src/grants.js";
import { stubSource, FakeInteract, RecordingGrants } from "./helpers.js";

/**
 * 验收矩阵「权限」行：
 * - 未授权 / 拒绝 / unsupported 不读取（resolve 不被调用）。
 * - 授权顺序：先 confirm/查授权，后读取；L1 授权一次后免确认；过期/撤销生效；L2 永不落盘。
 */

const PROMPT = "看看这个项目";

function projectSource(log: string[], result: "ok" | "throw" = "ok") {
  return stubSource({
    id: "secret-project",
    types: ["project"],
    permission: "L1-grant-once",
    resolve: () => {
      log.push("source:resolve");
      if (result === "throw") throw new Error("读取出错");
      return { status: "resolved", value: { type: "project", cwd: "/tmp", summary: "内容" }, display: "机密项目内容" };
    },
  });
}

describe("L1 授权一次", () => {
  it("未授权且用户拒绝 → confirm 被调、resolve 不被调、不写 grants", async () => {
    const log: string[] = [];
    const grants = new RecordingGrants();
    const interact = new FakeInteract();
    interact.confirmResult = "no";
    const engine = createEngine({ sources: [projectSource(log)], grants, interact });

    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(interact.log.length).toBe(1);
    expect(interact.log[0]).toContain("confirm");
    expect(log).toEqual([]); // resolve 从未执行
    expect(grants.log).toEqual(["has:secret-project"]); // 只查询，未写入
    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons?.["ref-1"]).toBe("permission-denied");
  });

  it("宿主无 confirm 能力（unsupported）→ 不读取、不写授权", async () => {
    const log: string[] = [];
    const grants = new RecordingGrants();
    const interact = new FakeInteract();
    interact.confirmResult = "unsupported";
    const engine = createEngine({ sources: [projectSource(log)], grants, interact });

    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(log).toEqual([]);
    expect(grants.log).toEqual(["has:secret-project"]);
    expect(out.dropReasons?.["ref-1"]).toBe("interaction-unsupported");
  });

  it("用户同意 → 顺序：has → confirm → grant → resolve，且授权持久化", async () => {
    const log: string[] = [];
    const grants = new RecordingGrants();
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    const engine = createEngine({ sources: [projectSource(log)], grants, interact });

    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });

    expect(grants.log).toEqual(["has:secret-project", "grant:secret-project"]);
    expect(interact.log.length).toBe(1);
    expect(log).toEqual(["source:resolve"]);
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toContain("机密项目内容");

    // 第二次调用：授权清单命中 → 不再 confirm，直接读取
    interact.log.length = 0;
    log.length = 0;
    grants.log.length = 0;
    const out2 = await engine.enrich(PROMPT, { cwd: "/tmp" });
    expect(interact.log).toEqual([]);
    expect(grants.log).toEqual(["has:secret-project"]);
    expect(log).toEqual(["source:resolve"]);
    expect(out2.resolvedRefs.length).toBe(1);
  });

  it("过期授权视为未授权（再次 confirm）", async () => {
    const log: string[] = [];
    let nowMs = Date.parse("2026-09-13T12:00:00.000Z");
    const store = new InMemoryGrantStore(() => nowMs);
    await store.grant({ sourceId: "secret-project" }, { expiresAt: "2026-09-13T11:00:00.000Z" }); // 1 小时前过期
    const grants = new RecordingGrants(store);
    const interact = new FakeInteract();
    interact.confirmResult = "no";
    const engine = createEngine({ sources: [projectSource(log)], grants, interact });

    const out = await engine.enrich(PROMPT, { cwd: "/tmp" });
    expect(interact.log.length).toBe(1); // 过期 → 重新询问
    expect(out.dropReasons?.["ref-1"]).toBe("permission-denied");

    // 未过期则免询问
    nowMs = Date.parse("2026-09-13T10:00:00.000Z");
    interact.log.length = 0;
    const out2 = await engine.enrich(PROMPT, { cwd: "/tmp" });
    expect(interact.log).toEqual([]);
    expect(out2.resolvedRefs.length).toBe(1);
  });

  it("撤销后恢复询问", async () => {
    const log: string[] = [];
    const store = new InMemoryGrantStore();
    await store.grant({ sourceId: "secret-project" });
    const grants = new RecordingGrants(store);
    const interact = new FakeInteract();
    interact.confirmResult = "no";
    const engine = createEngine({ sources: [projectSource(log)], grants, interact });

    await engine.enrich(PROMPT, { cwd: "/tmp" });
    expect(interact.log).toEqual([]); // 已授权：免询问

    await store.revoke({ sourceId: "secret-project" });
    const out2 = await engine.enrich(PROMPT, { cwd: "/tmp" });
    expect(interact.log.length).toBe(1); // 撤销后重新询问
    expect(out2.dropReasons?.["ref-1"]).toBe("permission-denied");
  });
});

describe("授权 scope 隔离（store 级）", () => {
  it("一个 scope 的授权不越界解锁另一个 scope", async () => {
    const store = new InMemoryGrantStore();
    await store.grant({ sourceId: "clipboard", scope: "/tmp/allowed" });
    expect(await store.has({ sourceId: "clipboard", scope: "/tmp/allowed" })).toBe(true);
    expect(await store.has({ sourceId: "clipboard", scope: "/tmp/other" })).toBe(false);
    expect(await store.has({ sourceId: "clipboard" })).toBe(false); // 无 scope 查询不匹配有 scope 记录
    expect(await store.has({ sourceId: "other-source", scope: "/tmp/allowed" })).toBe(false);
  });
});

describe("L2 每次确认", () => {
  const l2Source = (log: string[]) =>
    stubSource({
      id: "camera",
      types: ["image"],
      permission: "L2-confirm-each",
      resolve: () => {
        log.push("source:resolve");
        // 值类型必须与服务类型一致（类型一致性纪律）；附件走 attachments 通道
        return {
          status: "resolved" as const,
          value: { type: "image" as const, path: "/tmp/photo.png", mediaType: "image/png", base64: "QUJD" },
          display: "一张照片",
        };
      },
    });

  it("同意 → 读取，但绝不写授权清单", async () => {
    const log: string[] = [];
    const grants = new RecordingGrants();
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    const engine = createEngine({
      detector: {
        detect: (p) =>
          p.includes("那张图")
            ? [{ id: "r1", span: [0, 3] as const, text: p.slice(0, 3), expectedType: "image", confidence: 0.9 }]
            : [],
      },
      sources: [l2Source(log)],
      grants,
      interact,
    });

    const out = await engine.enrich("那张图看看", { cwd: "/tmp" });
    expect(log).toEqual(["source:resolve"]);
    expect(out.resolvedRefs.length).toBe(1);
    expect(grants.log).toEqual([]); // L2 永不落盘
    expect((await grants.list()).length).toBe(0);

    // 第二次仍需确认
    interact.confirmResult = "no";
    log.length = 0;
    const out2 = await engine.enrich("那张图看看", { cwd: "/tmp" });
    expect(log).toEqual([]);
    expect(out2.dropReasons?.["ref-1"]).toBe("permission-denied");
  });
});
