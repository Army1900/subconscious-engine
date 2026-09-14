import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { FakeInteract, stubSource } from "./helpers.js";

/**
 * 监督整改 4：resolved / candidate / acquired 的 value.type 必须与当前 ref.expectedType 一致。
 * 数据源与交互端口可能来自 JS（不可信），否则 file 指代可被注入 person 等错误类型的值。
 */

const detector = {
  detect: (p: string) =>
    p.includes("这个文件")
      ? [{ id: "r", span: [2, 6] as const, text: "这个文件", expectedType: "file" as const, confidence: 0.9 }]
      : [],
};

describe("值类型一致性（expectedType 对齐）", () => {
  it("file 指代收到 resolved person 值 → 受控丢弃，绝不注入", async () => {
    const evil = stubSource({
      id: "evil",
      types: ["file"],
      resolve: () => ({
        status: "resolved",
        value: { type: "person", name: "张三" },
        display: "张三（伪装成文件路径）",
      }),
    });
    const engine = createEngine({ detector, sources: [evil] });
    const out = await engine.enrich("看看这个文件", { cwd: "/tmp" });

    expect(out.resolvedRefs).toEqual([]);
    expect(out.context).toBeUndefined();
    expect(out.dropReasons?.["ref-1"]).toBe("not-found"); // 非法解析按受控 not-found
  });

  it("ambiguous 候选含类型不一致者 → 被过滤，选择器只见类型一致的候选", async () => {
    const mixed = stubSource({
      id: "mixed",
      types: ["file"],
      resolve: () => ({
        status: "ambiguous",
        candidates: [
          { id: "f1", label: "文件甲", value: { type: "file", path: "/tmp/a.ts" } },
          { id: "p1", label: "某人", value: { type: "person", name: "李四" } },
        ],
      }),
    });
    const interact = new FakeInteract();
    interact.selectResult = "文件甲";
    const engine = createEngine({ detector, sources: [mixed], interact });
    const out = await engine.enrich("看看这个文件", { cwd: "/tmp" });

    // FakeInteract 日志格式 select:{title}:{options}；title 尾部自带中文冒号
    expect(interact.log[0]).toBe("select:请选择「这个文件」所指：:文件甲"); // 只剩类型一致的候选
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toContain("文件甲"); // 选中候选（display 用 label）
    expect(out.context).not.toContain("李四"); // 异类型候选未进入任何输出
  });

  it("acquisition spec.expectedType 与指代不一致 → 解析非法，不发起任何确认", async () => {
    const mismatch = stubSource({
      id: "acq-mismatch",
      types: ["file"],
      resolve: () => ({
        status: "need-acquisition",
        acquisition: { kind: "pick-file", prompt: "选个文件", expectedType: "person" },
      }),
    });
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    const engine = createEngine({ detector, sources: [mismatch], interact });
    const out = await engine.enrich("看看这个文件", { cwd: "/tmp" });

    expect(interact.log).toEqual([]); // 不发起确认/获取
    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons?.["ref-1"]).toBe("not-found");
  });

  it("acquire 端口返回类型不一致的值（不可信 JS 端口）→ 丢弃，不注入", async () => {
    const src = stubSource({
      id: "acq",
      types: ["file"],
      permission: "L3-acquire",
      resolve: () => ({
        status: "need-acquisition",
        acquisition: { kind: "pick-file", prompt: "选个文件", expectedType: "file" },
      }),
    });
    const interact = new FakeInteract();
    interact.confirmResult = "yes";
    interact.acquireResult = { type: "person", name: "王五" }; // 端口谎报：file 获取回 person
    const engine = createEngine({ detector, sources: [src], interact });
    const out = await engine.enrich("看看这个文件", { cwd: "/tmp" });

    expect(out.resolvedRefs).toEqual([]);
    expect(out.context).toBeUndefined();
    expect(out.dropReasons?.["ref-1"]).toBe("error");
  });

  it("类型一致的正常路径不受影响（file 指代 → file 值注入）", async () => {
    const ok = stubSource({
      id: "ok",
      types: ["file"],
      resolve: () => ({
        status: "resolved",
        value: { type: "file", path: "/tmp/real.ts", line: 3 },
        display: "/tmp/real.ts:3",
      }),
    });
    const engine = createEngine({ detector, sources: [ok] });
    const out = await engine.enrich("看看这个文件", { cwd: "/tmp" });
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toContain("/tmp/real.ts");
  });
});
