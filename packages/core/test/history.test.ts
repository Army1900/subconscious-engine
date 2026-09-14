import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { DEFAULT_SOURCES, sessionContentSource } from "../src/sources/index.js";
import type { ResolveContext } from "../src/types.js";
import { deferred, flushMicrotasks, recordingEnv } from "./helpers.js";

/**
 * 验收矩阵「历史」行：
 * - 消歧选定 ID 后才读其内容；重复标签仍使用稳定 ID；乱序/无效日期确定性排序。
 * - 绑定失败（取消/不可用）不读取内容、不注入确定结论。
 */

const PROMPT = "把这个函数改成和上次一样的错误处理";

describe("历史事件 → 历史内容绑定顺序", () => {
  it("readSessionContent 在消歧选定之后才被调用，且使用选定的稳定 id/path", async () => {
    const selectGate = deferred<void>();
    const readCalls: string[] = [];
    const { env, calls } = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => [
        { id: "s1", title: "第一个", at: "2026-09-10T10:00:00.000Z", path: "/pi/sessions/s1.jsonl" },
        { id: "s2", title: "第二个", at: "2026-09-09T10:00:00.000Z", path: "/pi/sessions/s2.jsonl" },
      ],
      readSessionContent: async (session) => {
        readCalls.push(session.id);
        expect(session.path).toBe("/pi/sessions/s2.jsonl"); // 按绑定会话的 path 定位，不凭 id 拼路径
        return {
          sessionId: session.id,
          changes: [{ at: "2026-09-09T10:00:00.000Z", tool: "edit", path: "a.ts", oldText: "x", newText: "y" }],
        };
      },
    });
    const interact = {
      confirm: async () => "no" as const,
      select: async (_title: string, _options: readonly string[]) => {
        await selectGate.promise; // 挂起选择器：期间不得读取会话内容
        return "第二个（2026-09-09T10:00:00.000Z）";
      },
      acquire: async () => null,
    };
    const engine = createEngine({ sources: DEFAULT_SOURCES, interact });
    const pending = engine.enrich(PROMPT, env);
    await flushMicrotasks();

    // 选择器未决：会话内容绝不能被读取
    expect(calls).toEqual(["listRecentSessions"]);

    selectGate.resolve();
    const out = await pending;
    expect(readCalls).toEqual(["s2"]);
    expect(out.context).toContain("s2");
    expect(out.context).toContain("a.ts");
  });

  it("重复标签去重后仍映射稳定 ID", async () => {
    const readIds: string[] = [];
    const { env } = recordingEnv({
      cwd: "/tmp",
      // 同标题同时刻的两个会话：标签必然重复
      listRecentSessions: async () => [
        { id: "stable-1", title: "同名的会话", at: "2026-09-10T10:00:00.000Z" },
        { id: "stable-2", title: "同名的会话", at: "2026-09-10T10:00:00.000Z" },
      ],
      readSessionContent: async (session) => {
        readIds.push(session.id);
        return {
          sessionId: session.id,
          changes: [{ at: "2026-09-10T10:00:00.000Z", tool: "edit", path: "dup.ts", oldText: "1", newText: "2" }],
        };
      },
    });
    const interact = {
      confirm: async () => "no" as const,
      // 用户选的是去重后的第二个标签 → 必须绑定 stable-2（稳定 ID），而非按标签文本回猜
      select: async (_title: string, options: readonly string[]) => {
        expect(options.length).toBe(2);
        expect(options[0]).not.toBe(options[1]);
        return options[1] as string;
      },
      acquire: async () => null,
    };
    const engine = createEngine({ sources: DEFAULT_SOURCES, interact });
    const out = await engine.enrich(PROMPT, env);
    expect(readIds).toEqual(["stable-2"]);
    expect(out.context).toContain("stable-2");
  });

  it("乱序与无效日期输入的确定性排序（新在前，无效在后）", async () => {
    const seen: string[] = [];
    const { env } = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => [
        { id: "invalid-date", title: "坏时间", at: "not-a-date" },
        { id: "old", title: "旧的", at: "2026-09-01T10:00:00.000Z" },
        { id: "newest", title: "最新的", at: "2026-09-12T10:00:00.000Z" },
        { id: "middle", title: "中间的", at: "2026-09-07T10:00:00.000Z" },
      ],
      readSessionContent: async (session) => {
        seen.push(session.id);
        return { sessionId: session.id, changes: [] };
      },
    });
    const interact = {
      confirm: async () => "no" as const,
      select: async (_t: string, options: readonly string[]) => {
        seen.push(`options:${options.join("|")}`);
        return null; // 取消选择
      },
      acquire: async () => null,
    };
    const engine = createEngine({ sources: DEFAULT_SOURCES, interact });
    const out = await engine.enrich(PROMPT, env);
    // 候选顺序确定性：最新的 → 中间的 → 旧的 → 坏时间
    expect(seen).toEqual([
      "options:最新的（2026-09-12T10:00:00.000Z）|中间的（2026-09-07T10:00:00.000Z）|旧的（2026-09-01T10:00:00.000Z）|坏时间（not-a-date）",
    ]);
    // 取消 → 无绑定 → 不读取内容、不注入
    expect(out.context).toBeUndefined();
    expect(out.resolvedRefs).toEqual([]);
    expect(out.dropReasons).toMatchObject({ "ref-2": "user-cancelled", "ref-3": "no-binding" });
  });

  it("单会话直接解析为稳定 id（无需弹选择器）", async () => {
    const { env, calls } = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => [{ id: "only", title: "唯一", at: "2026-09-10T10:00:00.000Z" }],
      readSessionContent: async (session) => ({
        sessionId: session.id,
        changes: [{ at: "2026-09-10T10:00:00.000Z", tool: "edit", path: "x.ts", oldText: "1", newText: "2" }],
      }),
    });
    const interact = {
      confirm: async () => "no" as const,
      select: async () => {
        throw new Error("单会话不应弹选择器");
      },
      acquire: async () => null,
    };
    const engine = createEngine({ sources: DEFAULT_SOURCES, interact });
    const out = await engine.enrich(PROMPT, env);
    expect(calls).toEqual(["listRecentSessions", "readSessionContent:only"]);
    expect(out.context).toContain("only");
  });

  it("session-content 源在无绑定 ctx 下防御性返回 not-found（双保险，D4.2）", async () => {
    const ref = {
      id: "r",
      span: [0, 2] as const,
      text: "一样",
      expectedType: "history-content" as const,
      confidence: 0.9,
    };
    let providerCalled = false;
    const env: Parameters<typeof sessionContentSource.resolve>[1] = {
      cwd: "/tmp",
      readSessionContent: async () => {
        providerCalled = true;
        return { sessionId: "x", changes: [] };
      },
    };
    const ctx: ResolveContext = {
      signal: new AbortController().signal,
      remainingMs: () => 1000,
      limits: {
        timeoutMs: 3000,
        interactTimeoutMs: 30000,
        minConfidence: 0.5,
        maxContextChars: 4000,
        maxSourceBytes: 64000,
        maxListItems: 10,
        maxCandidates: 8,
        maxDiffEntries: 20,
        maxDiffSnippetChars: 400,
        maxDiffChars: 1600,
        maxRefDisplayChars: 1200,
      },
    };
    const res = await sessionContentSource.resolve(ref, env, ctx);
    expect(res).toEqual({ status: "not-found" });
    expect(providerCalled).toBe(false);
  });
});

describe("绑定完整性：provider 返回内容必须属于绑定会话", () => {
  it("引擎级：readSessionContent 返回另一会话的记录 → not-found，绝不注入（监督复现等价）", async () => {
    const { env, calls } = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => [{ id: "bound-1", title: "绑定会话", at: "2026-09-10T10:00:00.000Z" }],
      // 错误或恶意 provider：请求 bound-1 却返回 other-session 的修改记录
      readSessionContent: async (_session) => ({
        sessionId: "other-session",
        changes: [
          { at: "2026-09-10T09:00:00.000Z", tool: "edit", path: "evil.ts", oldText: "a", newText: "b" },
        ],
      }),
    });
    const engine = createEngine({ sources: DEFAULT_SOURCES });
    const out = await engine.enrich(PROMPT, env);

    expect(calls).toContain("readSessionContent:bound-1"); // 只按绑定会话请求
    expect(out.dropReasons?.["ref-3"]).toBe("not-found"); // 内容指代受控丢弃
    expect(out.context).not.toContain("evil.ts"); // 另一会话的内容绝不注入
    expect(out.context).not.toContain("other-session");
  });

  it("源级：record.sessionId !== boundSession.id → not-found（稳定绑定红线）", async () => {
    const ref = {
      id: "r",
      span: [0, 2] as const,
      text: "一样",
      expectedType: "history-content" as const,
      confidence: 0.9,
    };
    const env: Parameters<typeof sessionContentSource.resolve>[1] = {
      cwd: "/tmp",
      readSessionContent: async () => ({
        sessionId: "hijacked-session",
        changes: [{ at: "2026-09-10T10:00:00.000Z", tool: "edit", path: "x.ts", oldText: "1", newText: "2" }],
      }),
    };
    const ctx: ResolveContext = {
      signal: new AbortController().signal,
      remainingMs: () => 1000,
      boundSession: { id: "bound-session" },
      limits: {
        timeoutMs: 3000,
        interactTimeoutMs: 30000,
        minConfidence: 0.5,
        maxContextChars: 4000,
        maxSourceBytes: 64000,
        maxListItems: 10,
        maxCandidates: 8,
        maxDiffEntries: 20,
        maxDiffSnippetChars: 400,
        maxDiffChars: 1600,
        maxRefDisplayChars: 1200,
      },
    };
    const res = await sessionContentSource.resolve(ref, env, ctx);
    expect(res).toEqual({ status: "not-found" });
  });
});

describe("绑定失败时的诚实降级", () => {
  it("select 不可用（unsupported）→ 不读内容、不注入猜测", async () => {
    const { env, calls } = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => [
        { id: "a", title: "甲", at: "2026-09-10T10:00:00.000Z" },
        { id: "b", title: "乙", at: "2026-09-09T10:00:00.000Z" },
      ],
      readSessionContent: async () => {
        throw new Error("未消歧不得读取");
      },
    });
    const engine = createEngine({ sources: DEFAULT_SOURCES }); // 默认 interact 全 unsupported
    const out = await engine.enrich(PROMPT, env);
    expect(out.resolvedRefs).toEqual([]);
    expect(out.context).toBeUndefined();
    expect(calls).toEqual(["listRecentSessions"]);
    expect(out.dropReasons).toMatchObject({ "ref-2": "interaction-unsupported", "ref-3": "no-binding" });
  });

  it("无历史事件指代时，内容指代直接 no-binding（session-content 不被调用）", async () => {
    const { env, calls } = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => {
        throw new Error("无 history-event 指代时不应列出会话");
      },
      readSessionContent: async () => {
        throw new Error("不得读取");
      },
    });
    const engine = createEngine({ sources: DEFAULT_SOURCES });
    // "和之前一样处理" 不含独立"上次"指代（"之前"单独不成指代）→ 只有 history-content
    const out = await engine.enrich("和之前一样处理", env);
    expect(out.context).toBeUndefined();
    expect(calls).toEqual([]);
    expect(out.droppedRefs.length).toBe(1);
    expect(out.dropReasons?.["ref-1"]).toBe("no-binding");
  });
});
