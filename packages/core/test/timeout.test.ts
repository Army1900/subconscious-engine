import { describe, expect, it, onTestFinished } from "vitest";
import { createEngine } from "../src/engine.js";
import { ManualTimer } from "../src/timer.js";
import { DEFAULT_ENGINE_LIMITS } from "../src/types.js";
import { DEFAULT_SOURCES } from "../src/sources/index.js";
import { FakeInteract, RecordingGrants, deferred, flushMicrotasks, recordingEnv, stubSource } from "./helpers.js";

/**
 * 验收矩阵「超时」行：
 * - 3s 默认有界（ManualTimer 确定性验证）；保留已完成项；
 * - 截止后禁止交互/授权副作用；迟到成功/失败不再写 grant、不再开 UI、不产生未处理 rejection。
 */

const neverSource = stubSource({
  id: "never",
  types: ["project"],
  resolve: () => new Promise(() => {}) as Promise<{ status: "not-found" }>,
});

describe("总超时：deadline + AbortSignal", () => {
  it("默认 3000ms：2999ms 未到期、3000ms 到期，永不结束的源有界返回", async () => {
    const timer = new ManualTimer();
    const engine = createEngine({ sources: [neverSource], timer });
    const pending = engine.enrich("分析这个项目", { cwd: "/tmp" });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flushMicrotasks();

    timer.advance(2999);
    await flushMicrotasks();
    expect(settled).toBe(false);

    timer.advance(1);
    const out = await pending;
    expect(settled).toBe(true);
    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons?.["ref-1"]).toBe("budget-exhausted");
    expect(out.timedOut).toBe(true);
  });

  it("截止前完成的项保留，未完成项丢弃", async () => {
    const timer = new ManualTimer();
    const { env } = recordingEnv({
      cwd: "/tmp",
      readCwdContext: async () => ({ cwd: "/tmp/proj", dirSummary: "quick" }),
    });
    // project 源挂起（never 只服务 project），file 源走 active-editor 秒回
    const sources = [neverSource, ...DEFAULT_SOURCES];
    const engine = createEngine({ sources, timer, limits: { timeoutMs: 100 } });
    const pending = engine.enrich("看看这个项目里这个文件", {
      ...env,
      activeEditor: { path: "/tmp/proj/a.ts", line: 1 },
    });
    await flushMicrotasks();
    timer.advance(100);
    const out = await pending;

    expect(out.resolvedRefs.length).toBe(1); // 文件已解析，保留
    expect(out.context).toContain("/tmp/proj/a.ts");
    expect(out.droppedRefs.length).toBe(1); // 项目指代超时丢弃
    expect(out.dropReasons?.[out.droppedRefs[0] ?? ""]).toBe("budget-exhausted");
    expect(out.timedOut).toBe(true);
  });

  it("wave 2 在预算耗尽后不再触发任何源或交互", async () => {
    const timer = new ManualTimer();
    const gate = deferred<void>();
    const interact = new FakeInteract();
    const { env, calls } = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => {
        await gate.promise; // 拖住 wave 1 直到预算耗尽
        return [{ id: "s1", title: "唯一", at: "2026-09-10T10:00:00.000Z" }];
      },
      readSessionContent: async () => {
        throw new Error("预算耗尽后不得读取会话内容");
      },
    });
    const engine = createEngine({ sources: DEFAULT_SOURCES, timer, interact, limits: { timeoutMs: 100 } });
    const pending = engine.enrich("把这个函数改成和上次一样的错误处理", env);
    await flushMicrotasks();
    timer.advance(100);
    const out = await pending;
    gate.resolve(); // 迟到的会话列表返回：被丢弃

    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons?.["ref-2"]).toBe("budget-exhausted");
    expect(out.dropReasons?.["ref-3"]).toBe("budget-exhausted");
    expect(interact.log).toEqual([]); // 截止后禁止交互
    expect(calls.filter((c) => c.startsWith("readSessionContent"))).toEqual([]);
    expect(out.timedOut).toBe(true);
  });
});

describe("迟到回调无新副作用", () => {
  it("迟到成功的源结果被丢弃，不进入注入", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    onTestFinished(() => {
      process.off("unhandledRejection", onUnhandled);
    });

    const timer = new ManualTimer();
    const gate = deferred<string>();
    const late = stubSource({
      id: "late",
      types: ["project"],
      resolve: async () => {
        const value = await gate.promise;
        return {
          status: "resolved",
          value: { type: "project", cwd: "/tmp", summary: value },
          display: value,
        };
      },
    });
    const engine = createEngine({ sources: [late], timer, limits: { timeoutMs: 50 } });
    const pending = engine.enrich("分析这个项目", { cwd: "/tmp" });
    await flushMicrotasks();
    timer.advance(50);
    const out = await pending;

    gate.resolve("LATE-VALUE"); // 迟到成功
    await flushMicrotasks(20);
    await new Promise((r) => setTimeout(r, 5)); // 真实时钟排空任务队列

    expect(out.context).toBeUndefined(); // 迟到值没有进入注入
    expect(unhandled).toEqual([]);
  });

  it("迟到失败的源结果不产生未处理 rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    onTestFinished(() => {
      process.off("unhandledRejection", onUnhandled);
    });

    const timer = new ManualTimer();
    const gate = deferred<void>();
    const late = stubSource({
      id: "late-reject",
      types: ["project"],
      resolve: async () => {
        await gate.promise;
        throw new Error("迟到的失败");
      },
    });
    const engine = createEngine({ sources: [late], timer, limits: { timeoutMs: 50 } });
    const pending = engine.enrich("分析这个项目", { cwd: "/tmp" });
    await flushMicrotasks();
    timer.advance(50);
    const out = await pending;

    gate.reject(new Error("迟到失败"));
    await flushMicrotasks(20);
    await new Promise((r) => setTimeout(r, 5));

    expect(out.dropReasons?.["ref-1"]).toBe("budget-exhausted");
    expect(unhandled).toEqual([]);
  });

  it("交互超时后迟到的 confirm=yes 不写 grants、不再读取", async () => {
    const timer = new ManualTimer();
    const gate = deferred<"yes" | "no" | "unsupported">();
    const grants = new RecordingGrants();
    const resolveLog: string[] = [];
    const interact = {
      confirm: async () => gate.promise,
      select: async () => null,
      acquire: async () => null,
    };
    const secret = stubSource({
      id: "secret",
      types: ["project"],
      permission: "L1-grant-once",
      resolve: () => {
        resolveLog.push("read");
        return { status: "resolved", value: { type: "project", cwd: "/x", summary: "s" }, display: "s" };
      },
    });
    const engine = createEngine({
      sources: [secret],
      grants,
      interact,
      timer,
      limits: { timeoutMs: 1000, interactTimeoutMs: 50 },
    });
    const pending = engine.enrich("分析这个项目", { cwd: "/tmp" });
    await flushMicrotasks();
    timer.advance(50); // 交互预算耗尽 → confirm 安全侧 "no"
    const out = await pending;

    gate.resolve("yes"); // 用户实际点了同意（迟到）
    await flushMicrotasks(20);

    expect(out.dropReasons?.["ref-1"]).toBe("permission-denied");
    expect(grants.log).toEqual(["has:secret"]); // 未写授权
    expect(resolveLog).toEqual([]); // 未读取
  });
});

describe("超时界限与默认值", () => {
  it("默认总超时为 3000ms（工程约定锁定）", () => {
    expect(DEFAULT_ENGINE_LIMITS.timeoutMs).toBe(3000);
    expect(DEFAULT_ENGINE_LIMITS.interactTimeoutMs).toBe(30000);
  });

  it("真实系统时钟下永不结束的源在超时内有界返回（默认 3000 不等满，用短限）", async () => {
    const engine = createEngine({ sources: [neverSource], limits: { timeoutMs: 60 } });
    const startedAt = Date.now();
    const out = await engine.enrich("分析这个项目", { cwd: "/tmp" });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(2000);
    expect(out.timedOut).toBe(true);
    expect(out.dropReasons?.["ref-1"]).toBe("budget-exhausted");
  });
});
