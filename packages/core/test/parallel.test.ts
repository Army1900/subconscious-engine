import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { DEFAULT_SOURCES } from "../src/sources/index.js";
import { FakeInteract, deferred, flushMicrotasks, recordingEnv, stubSource } from "./helpers.js";

/**
 * 验收矩阵「并发」行（可控 barrier 测试）：
 * - 独立指代并行解析（A 开始后未完成时 B 也已开始）。
 * - 历史内容等待所属事件完成绑定后才读取。
 * - 同一引擎同时 enrich 两个请求不串数据。
 */

function barrier(parties: number): { wait(): Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async wait(): Promise<void> {
      arrived += 1;
      if (arrived >= parties) {
        release();
        return;
      }
      await gate; // 若实现串行执行，这里将永久等待导致测试超时失败
    },
  };
}

describe("独立指代并行解析", () => {
  it("两个 L0 源互相等待对方开跑（barrier）后才完成", async () => {
    const gate = barrier(2);
    const started: string[] = [];
    const slowA = stubSource({
      id: "src-a",
      types: ["project"],
      resolve: async () => {
        started.push("a:start");
        await gate.wait();
        started.push("a:end");
        return { status: "resolved", value: { type: "project", cwd: "/a", summary: "A" }, display: "A 的项目摘要" };
      },
    });
    const slowB = stubSource({
      id: "src-b",
      types: ["file"],
      resolve: async () => {
        started.push("b:start");
        await gate.wait();
        started.push("b:end");
        return { status: "resolved", value: { type: "file", path: "/b.ts" }, display: "/b.ts" };
      },
    });
    const engine = createEngine({ sources: [slowA, slowB] });
    const out = await engine.enrich("看看这个项目里这个文件", { cwd: "/tmp" });

    // 两个源都在对方结束前开始 → 并行
    expect(started.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
    expect(out.resolvedRefs.length).toBe(2);
    expect(out.context).toContain("A 的项目摘要");
    expect(out.context).toContain("/b.ts");
  });

  it("history-content 在 history-event 绑定完成前不读取（依赖有序）", async () => {
    const listGate = deferred<void>();
    const order: string[] = [];
    const { env } = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => {
        order.push("list:start");
        await listGate.promise;
        order.push("list:end");
        return [{ id: "s-bound", title: "绑定会话", at: "2026-09-10T10:00:00.000Z" }];
      },
      readSessionContent: async (session) => {
        order.push(`read:${session.id}`);
        return { sessionId: session.id, changes: [] };
      },
    });
    const engine = createEngine({ sources: DEFAULT_SOURCES, interact: new FakeInteract() });
    const pending = engine.enrich("把这个函数改成和上次一样的错误处理", env);
    await flushMicrotasks();

    // wave 1 未完成（会话列表挂起）→ 内容读取绝不能开始
    expect(order).toEqual(["list:start"]);

    listGate.resolve();
    const out = await pending;
    expect(order).toEqual(["list:start", "list:end", "read:s-bound"]);
    expect(out.context).toBeDefined();
  });
});

describe("同一引擎并发 enrich 不串数据", () => {
  it("两个请求各自的 env 与绑定互不污染", async () => {
    const interact = new FakeInteract();
    interact.selectResult = "会话A（2026-09-10T10:00:00.000Z）";

    const holdA = deferred<void>();
    const holdB = deferred<void>();
    const envA = recordingEnv({
      cwd: "/A",
      listRecentSessions: async () => {
        await holdA.promise;
        return [
          { id: "A1", title: "会话A", at: "2026-09-10T10:00:00.000Z" },
          { id: "A2", title: "会话A2", at: "2026-09-09T10:00:00.000Z" },
        ];
      },
      readSessionContent: async (session) => {
        holdB.resolve();
        return {
          sessionId: session.id,
          changes: [{ at: "2026-09-10T10:00:00.000Z", tool: "edit", path: "a.ts", oldText: "1", newText: "2" }],
        };
      },
    });
    const envB = recordingEnv({
      cwd: "/B",
      listRecentSessions: async () => [{ id: "B1", title: "会话B", at: "2026-09-11T10:00:00.000Z" }],
      readSessionContent: async (session) => {
        await holdB.promise; // B 的内容读取在 A 完成选择之后才继续
        return {
          sessionId: session.id,
          changes: [{ at: "2026-09-11T10:00:00.000Z", tool: "edit", path: "b.ts", oldText: "1", newText: "2" }],
        };
      },
    });

    const engine = createEngine({ sources: DEFAULT_SOURCES, interact });
    const prompt = "把这个函数改成和上次一样的错误处理";

    const pB = engine.enrich(prompt, envB.env); // B：单会话自动绑定
    const pA = engine.enrich(prompt, envA.env); // A：两候选 → 用户选 A1
    await flushMicrotasks();

    holdA.resolve(); // 释放 A 的会话列表
    const [outB, outA] = await Promise.all([pB, pA]);

    // 各自绑定各自的稳定 id，互不串
    expect(outA.context).toContain("A1");
    expect(outA.context).not.toContain("B1");
    expect(outB.context).toContain("B1");
    expect(outB.context).not.toContain("A1");
    expect(envA.calls).toContain("readSessionContent:A1");
    expect(envB.calls).toContain("readSessionContent:B1");
  });
});
