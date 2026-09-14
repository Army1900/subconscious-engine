import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { EngineConfigError } from "../src/errors.js";
import { DataSourceRegistry } from "../src/registry.js";
import { activeEditorSource } from "../src/sources/active-editor.js";
import { stubSource } from "./helpers.js";

/**
 * 验收矩阵「来源」行：
 * - registry 重复 ID / 不兼容类型受控（构造期明确报错，不静默）。
 * - 单源故障不损失其他源（fail-open）。
 */

describe("registry：受控注册失败", () => {
  it("重复 id 抛 EngineConfigError(duplicate-source-id)", () => {
    const reg = new DataSourceRegistry();
    reg.register(activeEditorSource);
    expect(() => reg.register({ ...activeEditorSource })).toThrow(EngineConfigError);
    try {
      reg.register({ ...activeEditorSource });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EngineConfigError);
      expect((err as EngineConfigError).code).toBe("duplicate-source-id");
    }
  });

  it("未知类型抛 EngineConfigError(unknown-type)", () => {
    const reg = new DataSourceRegistry();
    const bad = stubSource({
      id: "bad",
      // 故意用运行时字符串绕过编译期类型（JS 消费者场景）
      types: ["file", "no-such-type"] as unknown as ["file"],
      resolve: () => ({ status: "not-found" }),
    });
    expect(() => reg.register(bad)).toThrow(EngineConfigError);
    try {
      reg.register(bad);
      expect.unreachable();
    } catch (err) {
      expect((err as EngineConfigError).code).toBe("unknown-type");
    }
  });

  it("缺 resolve / 空 id / 空类型表抛 EngineConfigError(invalid-source)", () => {
    const reg = new DataSourceRegistry();
    const noResolve = { id: "x", types: ["file"], permission: "L0-free" } as unknown as Parameters<typeof reg.register>[0];
    expect(() => reg.register(noResolve)).toThrow(EngineConfigError);
    const emptyId = stubSource({ id: "", types: ["file"] });
    expect(() => reg.register(emptyId)).toThrow(EngineConfigError);
    const emptyTypes = stubSource({ id: "y", types: [] });
    expect(() => reg.register(emptyTypes)).toThrow(EngineConfigError);
  });

  it("findByType 按注册顺序返回；createEngine 同样受控", () => {
    const reg = new DataSourceRegistry();
    const a = stubSource({ id: "a", types: ["file", "text"] });
    const b = stubSource({ id: "b", types: ["file"] });
    reg.register(a);
    reg.register(b);
    expect(reg.findByType("file").map((s) => s.id)).toEqual(["a", "b"]);
    expect(reg.findByType("text").map((s) => s.id)).toEqual(["a"]);
    expect(reg.findByType("image")).toEqual([]);

    expect(() => createEngine({ sources: [a, a] })).toThrow(EngineConfigError);
  });
});

describe("单源故障不损失其他源（fail-open）", () => {
  it("一个源 resolve 抛错，其余指代照常解析", async () => {
    const bad = stubSource({
      id: "bad-project",
      types: ["project"],
      resolve: () => {
        throw new Error("数据源内部崩溃");
      },
    });
    const good = activeEditorSource;
    const logs: string[] = [];
    const engine = createEngine({
      sources: [bad, good],
      logger: (entry) => logs.push(`${entry.level}:${entry.event}`),
    });
    const out = await engine.enrich("看看这个项目里这个文件", {
      cwd: "/tmp",
      activeEditor: { path: "/tmp/proj/a.ts", line: 3 },
    });
    // 这个文件 resolved；这个项目因源故障 error 丢弃
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toContain("/tmp/proj/a.ts");
    expect(out.droppedRefs.length).toBe(1);
    expect(out.dropReasons?.[out.droppedRefs[0] ?? ""]).toBe("error");
    expect(logs).toContain("warn:source-error");
    expect(logs).not.toContain("error:enrich-failed");
  });

  it("源返回非法四态形状按 not-found 处理（受控）", async () => {
    const garbage = stubSource({
      id: "garbage",
      types: ["project"],
      resolve: () => ({ status: "weird" }) as unknown as { status: "not-found" },
    });
    const engine = createEngine({ sources: [garbage] });
    const out = await engine.enrich("分析这个项目", { cwd: "/tmp" });
    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons?.["ref-1"]).toBe("not-found");
  });

  it("检测器抛错 → 整体 no-op 透传（enrich 不抛出）", async () => {
    const engine = createEngine({
      detector: {
        detect: () => {
          throw new Error("检测器崩溃");
        },
      },
      sources: [activeEditorSource],
    });
    const out = await engine.enrich("这个文件有问题", { cwd: "/tmp" });
    expect(out.context).toBeUndefined();
    expect(out.resolvedRefs).toEqual([]);
    expect(out.droppedRefs).toEqual([]);
  });

  it("env 非法（null）→ no-op，不抛出", async () => {
    const engine = createEngine({ sources: [activeEditorSource] });
    const out = await engine.enrich("这个文件有问题", null as unknown as never);
    expect(out.resolvedRefs).toEqual([]);
  });
});
