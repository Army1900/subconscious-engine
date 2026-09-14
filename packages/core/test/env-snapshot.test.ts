import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { DEFAULT_SOURCES } from "../src/sources/index.js";
import { FakeInteract, recordingEnv } from "./helpers.js";

/**
 * 验收矩阵「环境」与「当前文件」行：
 * - enrich 每次快照可更新；不跨请求串历史选择（同一 engine 实例两次调用）。
 * - 无编辑器和有效最近读写记录时不得凭 cwd 指认文件（D6：不猜测当前文件）。
 */

describe("env 每调用传入，不跨请求串数据", () => {
  it("两次调用不同 env，注入内容随 env 更新", async () => {
    const engine = createEngine({ sources: DEFAULT_SOURCES });
    const envA = recordingEnv({
      cwd: "/tmp/projA",
      readCwdContext: async () => ({ cwd: "/tmp/projA", dirSummary: "projA-files" }),
    });
    const envB = recordingEnv({
      cwd: "/tmp/projB",
      readCwdContext: async () => ({ cwd: "/tmp/projB", dirSummary: "projB-files" }),
    });

    const outA = await engine.enrich("分析这个项目", envA.env);
    const outB = await engine.enrich("分析这个项目", envB.env);

    expect(outA.context).toContain("projA-files");
    expect(outA.context).not.toContain("projB-files");
    expect(outB.context).toContain("projB-files");
    expect(outB.context).not.toContain("projA-files");
  });

  it("第一次调用的历史选择不会串到第二次", async () => {
    const interact = new FakeInteract();
    const engine = createEngine({ sources: DEFAULT_SOURCES, interact });

    // 第一次：两候选，用户选 A
    interact.selectResult = "改错误处理（2026-09-10T10:00:00.000Z）";
    const envA = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => [
        { id: "sA", title: "改错误处理", at: "2026-09-10T10:00:00.000Z" },
        { id: "sB", title: "另一个", at: "2026-09-09T10:00:00.000Z" },
      ],
      readSessionContent: async (session) => ({
        sessionId: session.id,
        changes: [{ at: "2026-09-10T10:00:00.000Z", tool: "edit", path: "a.ts", oldText: "x", newText: "y" }],
      }),
    });
    const outA = await engine.enrich("把这个函数改成和上次一样的错误处理", envA.env);
    expect(outA.context).toContain("sA");
    expect(envA.calls).toContain("readSessionContent:sA");

    // 第二次：全新 env、单会话 → 必须自动绑定新会话，而非沿用 sA
    const envB = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => [{ id: "sC", title: "第三会话", at: "2026-09-08T10:00:00.000Z" }],
      readSessionContent: async (session) => ({
        sessionId: session.id,
        changes: [{ at: "2026-09-08T10:00:00.000Z", tool: "edit", path: "c.ts", oldText: "p", newText: "q" }],
      }),
    });
    interact.selectResult = null; // 若误弹候选选择器，测试将以 null 取消而暴露
    const outB = await engine.enrich("把这个函数改成和上次一样的错误处理", envB.env);
    expect(outB.context).toContain("sC");
    expect(envB.calls).toContain("readSessionContent:sC");
    expect(envB.calls).not.toContain("readSessionContent:sA");
  });
});

describe("当前文件：无编辑器不猜（D6）", () => {
  it("activeEditor 缺失 → not-found，绝不凭 cwd 指认文件", async () => {
    const { env, calls } = recordingEnv({
      cwd: "/tmp/proj",
      readCwdContext: async () => ({ cwd: "/tmp/proj", dirSummary: "only-dir" }),
    });
    const engine = createEngine({ sources: DEFAULT_SOURCES });
    const out = await engine.enrich("这个文件还有问题", env);

    expect(out.resolvedRefs).toEqual([]);
    expect(out.context).toBeUndefined();
    expect(out.droppedRefs.length).toBe(1);
    expect(out.dropReasons?.[out.droppedRefs[0] ?? ""]).toBe("not-found");
    // 类型隔离：file 指代不得触发 project/cwd 读取
    expect(calls).toEqual([]);
  });

  it("activeEditor 非法（空路径/错行号）同样 not-found", async () => {
    const engine = createEngine({ sources: DEFAULT_SOURCES });
    const out = await engine.enrich("这个文件还有问题", {
      cwd: "/tmp",
      activeEditor: { path: "  " },
    });
    expect(out.resolvedRefs).toEqual([]);
    expect(out.droppedRefs.length).toBe(1);
  });

  it("activeEditor 有效 → file/code-symbol 解析到该路径", async () => {
    const engine = createEngine({ sources: DEFAULT_SOURCES });
    const out1 = await engine.enrich("这个文件还有问题", {
      cwd: "/tmp",
      activeEditor: { path: "/tmp/proj/src/api.ts", line: 42 },
    });
    expect(out1.context).toContain("/tmp/proj/src/api.ts:42");
    expect(out1.context).toContain("active-editor");

    const out2 = await engine.enrich("修一下这个函数", {
      cwd: "/tmp",
      activeEditor: { path: "/tmp/proj/src/api.ts", line: 7, selection: "function handler()" },
    });
    expect(out2.context).toContain("/tmp/proj/src/api.ts:7");
    expect(out2.context).toContain("function handler()");
  });
});
