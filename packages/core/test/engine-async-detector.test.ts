import { describe, expect, it, onTestFinished } from "vitest";
import { createEngine } from "../src/engine.js";
import { isAsyncDetector, RuleDetector } from "../src/detector.js";
import { createEmbeddingDetector } from "../src/embedding.js";
import { ManualTimer } from "../src/timer.js";
import { DEFAULT_SOURCES } from "../src/sources/index.js";
import { deferred, flushMicrotasks, recordingEnv, stubSource } from "./helpers.js";
import type { AsyncDetector, DanglingRef, DataType, Detector, DetectorContext, LogEntry } from "../src/types.js";

/**
 * M3 引擎异步检测器接入（docs/ACCEPTANCE.md「M3 embedding」行的回退面）。
 *
 * 锁定的行为：
 * - isAsyncDetector 结构探测（规则检测器 = false，AsyncDetector/embedding 检测器 = true）；
 * - 异步检测路径的结果与取消信号贯通 enrich 全流程；
 * - detectAsync 抛错/悬挂 → 引擎回退其同步 detect()，永不阻塞 prompt 发出；
 * - 检测与解析共享同一机器预算（单时钟，D3）：检测耗时不给解析翻新预算；
 * - 无指代快速路径与时钟清理纪律不回归。
 */

class AsyncFakeDetector implements AsyncDetector {
  readonly asyncCalls: string[] = [];
  readonly syncCalls: string[] = [];
  lastCtx: DetectorContext | undefined;

  constructor(
    private readonly asyncResult: () => Promise<readonly DanglingRef[]>,
    private readonly syncResult: (prompt: string) => readonly DanglingRef[],
  ) {}

  detect(prompt: string): readonly DanglingRef[] {
    this.syncCalls.push(prompt);
    return this.syncResult(prompt);
  }

  async detectAsync(prompt: string, ctx?: DetectorContext): Promise<readonly DanglingRef[]> {
    this.asyncCalls.push(prompt);
    this.lastCtx = ctx;
    return this.asyncResult();
  }
}

function ref(prompt: string, text: string, type: DataType, confidence = 0.9): DanglingRef {
  const start = prompt.indexOf(text);
  if (start < 0) throw new Error(`fixture 文本 "${text}" 不在 prompt 中`);
  return { id: "x", span: [start, start + text.length], text, expectedType: type, confidence };
}

const neverSource = stubSource({
  id: "never",
  types: ["project"],
  resolve: () => new Promise(() => {}) as Promise<{ status: "not-found" }>,
});

describe("isAsyncDetector 结构探测", () => {
  it("规则检测器为 false；AsyncDetector 与 embedding 检测器为 true", () => {
    expect(isAsyncDetector(new RuleDetector())).toBe(false);
    const plain: Detector = { detect: () => [] };
    expect(isAsyncDetector(plain)).toBe(false);
    expect(isAsyncDetector(createEmbeddingDetector(null))).toBe(true);
  });
});

describe("引擎：异步检测路径接入", () => {
  it("detectAsync 结果进入解析并注入（规则检不出的表述）", async () => {
    const prompt = "照老规矩处理";
    const fake = new AsyncFakeDetector(
      async () => [ref(prompt, "老规矩", "history-event")],
      () => [],
    );
    const { env, calls } = recordingEnv({
      cwd: "/tmp/proj",
      listRecentSessions: async () => [{ id: "s1", title: "唯一会话", at: "2026-09-10T10:00:00.000Z" }],
      readSessionContent: async () => null,
    });
    const engine = createEngine({ detector: fake, sources: DEFAULT_SOURCES });
    const out = await engine.enrich(prompt, env);

    expect(fake.asyncCalls).toEqual([prompt]);
    expect(fake.syncCalls).toEqual([]); // 异步路径成功时不走同步 detect
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toBeDefined();
    expect(calls.filter((c) => c.startsWith("readSessionContent"))).toEqual([]); // 无绑定不读取
  });

  it("引擎向 detectAsync 传递取消信号与剩余预算", async () => {
    const prompt = "照老规矩处理";
    const fake = new AsyncFakeDetector(async () => [], () => []);
    const engine = createEngine({ detector: fake, sources: DEFAULT_SOURCES });
    await engine.enrich(prompt, { cwd: "/tmp/proj" });
    expect(fake.lastCtx).toBeDefined();
    expect(typeof fake.lastCtx?.remainingMs()).toBe("number");
    expect(fake.lastCtx?.signal.aborted).toBe(true); // enrich 返回前统一 abort（D3.3）
  });

  it("detectAsync 抛错 → 回退其同步 detect()，记日志，enrich 不失败", async () => {
    const prompt = "分析这个项目";
    const fake = new AsyncFakeDetector(
      async () => {
        throw new Error("async boom");
      },
      (p) => [ref(p, "这个项目", "project")],
    );
    const logs: LogEntry[] = [];
    const { env } = recordingEnv({
      cwd: "/tmp/proj",
      readCwdContext: async () => ({ cwd: "/tmp/proj", dirSummary: "目录摘要" }),
    });
    const engine = createEngine({ detector: fake, sources: DEFAULT_SOURCES, logger: (e) => logs.push(e) });
    const out = await engine.enrich(prompt, env);

    expect(fake.syncCalls).toEqual([prompt]); // 回退到同步路径
    expect(out.resolvedRefs.length).toBe(1);
    expect(out.context).toContain("/tmp/proj");
    expect(logs.some((e) => e.event === "detector-async-error")).toBe(true);
  });

  it("detectAsync 悬挂 → 总预算有界返回，回退同步结果按预算纪律丢弃，时钟清理", async () => {
    const gate = deferred<readonly DanglingRef[]>();
    const prompt = "分析这个项目";
    const fake = new AsyncFakeDetector(
      () => gate.promise,
      (p) => [ref(p, "这个项目", "project")],
    );
    const timer = new ManualTimer();
    const engine = createEngine({ detector: fake, sources: [neverSource, ...DEFAULT_SOURCES], timer });
    const { env } = recordingEnv({ cwd: "/tmp/proj" });

    const pending = engine.enrich(prompt, env);
    await flushMicrotasks();
    timer.advance(3000); // 检测悬挂至总预算耗尽
    const out = await pending;
    gate.resolve([]); // 迟到结果：已无影响

    expect(out.timedOut).toBe(true);
    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons?.["ref-1"]).toBe("budget-exhausted");
    expect(timer.pendingCount()).toBe(0); // 时钟句柄清理
  });

  it("检测与解析共享同一机器预算：检测耗时后解析不翻新预算", async () => {
    const detectGate = deferred<readonly DanglingRef[]>();
    const prompt = "分析这个项目";
    const fake = new AsyncFakeDetector(() => detectGate.promise, () => []);
    const timer = new ManualTimer();
    const engine = createEngine({ detector: fake, sources: [neverSource, ...DEFAULT_SOURCES], timer });
    const { env } = recordingEnv({ cwd: "/tmp/proj" });

    const pending = engine.enrich(prompt, env);
    await flushMicrotasks();
    timer.advance(1000); // 检测阶段消耗 1000ms（尚未完成）
    detectGate.resolve([ref(prompt, "这个项目", "project")]);
    await flushMicrotasks();
    timer.advance(2000); // 累计 3000ms：共享预算应已耗尽（若翻新则此处仍挂起，测试超时）

    const out = await pending;
    expect(out.timedOut).toBe(true);
    expect(out.dropReasons?.["ref-1"]).toBe("budget-exhausted");
  });

  it("异步检测零指代 → no-op 快速路径：不读源、不注入、时钟清理", async () => {
    const fake = new AsyncFakeDetector(async () => [], () => []);
    const timer = new ManualTimer();
    const { env, calls } = recordingEnv({
      cwd: "/tmp/proj",
      listRecentSessions: async () => [{ id: "s1", title: "会话", at: "2026-09-10T10:00:00.000Z" }],
    });
    const engine = createEngine({ detector: fake, sources: DEFAULT_SOURCES, timer });
    const out = await engine.enrich("你好", env);
    expect(out.context).toBeUndefined();
    expect(out.resolvedRefs).toEqual([]);
    expect(calls).toEqual([]);
    expect(timer.pendingCount()).toBe(0);
  });

  it("同步检测器路径保持原状：不传 ctx、行为与 M1 一致", async () => {
    const prompt = "分析这个项目";
    const plain: Detector = { detect: (p: string) => [ref(p, "这个项目", "project")] };
    const { env } = recordingEnv({
      cwd: "/tmp/proj",
      readCwdContext: async () => ({ cwd: "/tmp/proj", dirSummary: "摘要" }),
    });
    const engine = createEngine({ detector: plain, sources: DEFAULT_SOURCES });
    const out = await engine.enrich(prompt, env);
    expect(out.resolvedRefs.length).toBe(1);
  });

  it("异步路径的迟到 rejection 不产生未处理 rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    onTestFinished(() => {
      process.off("unhandledRejection", onUnhandled);
    });

    const gate = deferred<readonly DanglingRef[]>();
    const fake = new AsyncFakeDetector(() => gate.promise, () => []);
    const timer = new ManualTimer();
    const engine = createEngine({ detector: fake, sources: DEFAULT_SOURCES, timer, limits: { timeoutMs: 100 } });
    const pending = engine.enrich("你好", { cwd: "/tmp/proj" });
    await flushMicrotasks();
    timer.advance(100);
    const out = await pending;
    gate.reject(new Error("late async failure"));
    await flushMicrotasks(20);
    await new Promise((r) => setTimeout(r, 5));

    expect(out.context).toBeUndefined();
    expect(unhandled).toEqual([]);
  });
});
