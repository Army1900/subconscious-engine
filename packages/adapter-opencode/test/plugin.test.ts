import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_LIMITS } from "@subconscious/core";
import type { SubconsciousEngine } from "@subconscious/core";
import {
  DEFAULT_TOTAL_TIMEOUT_MS,
  MAX_TOTAL_TIMEOUT_MS,
  PENDING_HEADER,
  RESOLVED_HEADER,
  SubconsciousPlugin,
  composeInjectionContext,
  handleChatMessage,
  resolvePluginTimeoutMs,
  toSessionClient,
} from "../src/plugin.js";
import type { ChatMessageOutputLike, SdkSessionClient } from "../src/plugin.js";
import type { ChatPartLike } from "../src/inject.js";

/** 官方 chat.message hook 的参数类型（经 typeof 查询推导，无需直接 import SDK 类型） */
type ChatMessageHook = NonNullable<Awaited<ReturnType<typeof SubconsciousPlugin>>["chat.message"]>;

/** 官方 heyapi 形状的 SDK session 客户端假实现（离线；带调用记录） */
function fakeSdkSession(
  sessions: unknown[],
  diffs: readonly unknown[] = [],
): SdkSessionClient & {
  calls: { list: number; get: number; diff: number; listQuery?: { directory?: string }; gotId?: string; diffId?: string };
} {
  const calls = { list: 0, get: 0, diff: 0 };
  const record = { ...calls, listQuery: undefined, gotId: undefined, diffId: undefined } as {
    list: number; get: number; diff: number; listQuery?: { directory?: string }; gotId?: string; diffId?: string;
  };
  return {
    calls: record,
    async list(options) {
      record.list += 1;
      record.listQuery = options?.query;
      return { data: sessions };
    },
    async get(options) {
      record.get += 1;
      record.gotId = options.path.id;
      return { data: sessions.find((item) => (item as { id?: string } | null)?.id === options.path.id) ?? null };
    },
    async diff(options) {
      record.diff += 1;
      record.diffId = options.path.id;
      return { data: [...diffs] };
    },
  };
}

function sessionEntry(id: string, title: string, updated: number): unknown {
  return { id, directory: "/repo", title, time: { created: updated - 1000, updated } };
}

function textPart(text: string, extra: Partial<ChatPartLike> = {}): ChatPartLike {
  return { type: "text", text, ...extra };
}

/** 满足官方 Hooks["chat.message"] 输出形状的完整假输出（Part 需带 id/sessionID/messageID） */
function officialOutput(text: string): Parameters<ChatMessageHook>[1] {
  return {
    message: {
      id: "msg_1",
      sessionID: "ses_now",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    },
    parts: [{ id: "part_1", sessionID: "ses_now", messageID: "msg_1", type: "text", text }],
  };
}

const dirs: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-plugin-"));
  dirs.push(dir);
  await writeFile(path.join(dir, "a.ts"), "export {};\n");
  return dir;
}

describe("handleChatMessage（chat.message 接线，同 claude 降级矩阵）", () => {
  it("无指代 → false，不触碰宿主 API（无指代不得读取数据源）", async () => {
    const sdk = fakeSdkSession([sessionEntry("ses_prev", "上一次", 2000)]);
    const output: ChatMessageOutputLike = { parts: [textPart("列出所有 TODO")] };
    const ok = await handleChatMessage(
      { sessionID: "ses_now", cwd: "/repo", client: { session: sdk } },
      output,
    );
    expect(ok).toBe(false);
    expect(sdk.calls.list).toBe(0);
    expect(output.parts[0]).toEqual(textPart("列出所有 TODO"));
  });

  it("cwd 缺失 → no-op（不回退 process.cwd，不猜）", async () => {
    const sdk = fakeSdkSession([]);
    const output: ChatMessageOutputLike = { parts: [textPart("分析这个项目的结构")] };
    await expect(handleChatMessage({ sessionID: "s", cwd: "", client: { session: sdk } }, output)).resolves.toBe(false);
    expect(sdk.calls.list).toBe(0);
  });

  it("project 指代 → 已解析块注入真实 cwd 快照；原文逐字节前缀保持", async () => {
    const dir = await tempProject();
    const output: ChatMessageOutputLike = { parts: [textPart("分析这个项目的结构")] };
    const ok = await handleChatMessage({ sessionID: "ses_now", cwd: dir, client: { session: fakeSdkSession([]) } }, output);
    expect(ok).toBe(true);
    const text = (output.parts[0] as { text?: string }).text ?? "";
    expect(text.startsWith("分析这个项目的结构")).toBe(true);
    expect(text).toContain(RESOLVED_HEADER);
    expect(text).toContain("a.ts");
  });

  it("历史指代 → session.list/get/diff 绑定所选会话；排除当前会话；diff 进入注入", async () => {
    const dir = await tempProject();
    const sdk = fakeSdkSession(
      [sessionEntry("ses_now", "当前", 9000), sessionEntry("ses_prev", "上一次会话", 2000)],
      [{ file: "src/a.ts", before: "old", after: "new", additions: 1, deletions: 1 }],
    );
    const output: ChatMessageOutputLike = { parts: [textPart("把这个函数改成和上次一样的错误处理")] };
    const ok = await handleChatMessage({ sessionID: "ses_now", cwd: dir, client: { session: sdk } }, output);
    expect(ok).toBe(true);
    expect(sdk.calls.list).toBe(1);
    expect(sdk.calls.listQuery?.directory).toBe(dir);
    expect(sdk.calls.diff).toBeGreaterThanOrEqual(1);
    expect(sdk.calls.diffId).toBe("ses_prev");
    const text = (output.parts[0] as { text?: string }).text ?? "";
    expect(text).toContain(RESOLVED_HEADER);
    expect(text).toContain("src/a.ts");
    expect(text).not.toContain("当前");
  });

  it("多候选（select unsupported）→ 待确认块列出候选，不注入确定结论", async () => {
    const dir = await tempProject();
    const sdk = fakeSdkSession([
      sessionEntry("ses_a", "候选甲", 2000),
      sessionEntry("ses_b", "候选乙", 1000),
    ]);
    const output: ChatMessageOutputLike = { parts: [textPart("参考上次的修改")] };
    const ok = await handleChatMessage({ sessionID: "ses_now", cwd: dir, client: { session: sdk } }, output);
    expect(ok).toBe(true);
    const text = (output.parts[0] as { text?: string }).text ?? "";
    expect(text).toContain(PENDING_HEADER);
    expect(text).toContain("候选甲");
    expect(text).toContain("候选乙");
    expect(text).not.toContain(RESOLVED_HEADER);
  });

  it("无 text 通道（空 parts / 全 synthetic / 全非文本）→ false 且不改动", async () => {
    const sdk = fakeSdkSession([sessionEntry("ses_prev", "上一次", 2000)]);
    const cases: ChatPartLike[][] = [
      [],
      [textPart("合成", { synthetic: true })],
      [{ type: "step-start" }],
    ];
    for (const parts of cases) {
      const output: ChatMessageOutputLike = { parts };
      await expect(handleChatMessage({ sessionID: "s", cwd: "/repo", client: { session: sdk } }, output)).resolves.toBe(false);
      expect(output.parts).toEqual(parts);
    }
  });

  it("enrich 悬挂 → 总超时放弃注入（fail-open，不阻塞宿主消息流）", async () => {
    const dir = await tempProject();
    const hanging: SubconsciousEngine = { enrich: () => new Promise<never>(() => {}) };
    const output: ChatMessageOutputLike = { parts: [textPart("分析这个项目的结构")] };
    const startedAt = Date.now();
    await expect(
      handleChatMessage(
        { sessionID: "s", cwd: dir, client: { session: fakeSdkSession([]) } },
        output,
        { totalTimeoutMs: 50, deps: { createEngineFn: () => hanging } },
      ),
    ).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect((output.parts[0] as { text?: string }).text).toBe("分析这个项目的结构");
  });

  it("引擎工厂抛错 → false（fail-open）", async () => {
    const output: ChatMessageOutputLike = { parts: [textPart("分析这个项目的结构")] };
    await expect(
      handleChatMessage(
        { sessionID: "s", cwd: "/repo", client: { session: fakeSdkSession([]) } },
        output,
        { deps: { createEngineFn: (): SubconsciousEngine => { throw new Error("boom"); } } },
      ),
    ).resolves.toBe(false);
    expect(output.parts[0]).toEqual(textPart("分析这个项目的结构"));
  });
});

describe("SubconsciousPlugin（官方 Plugin 形态入口）", () => {
  it("返回 Hooks，chat.message 可用且注入当前用户消息", async () => {
    const dir = await tempProject();
    const pluginInput = {
      client: { session: fakeSdkSession([]) },
      project: { id: "proj", worktree: dir },
      directory: dir,
      worktree: dir,
      serverUrl: new URL("http://127.0.0.1:1"),
      $: {},
      experimental_workspace: { register(): void { /* 测试桩 */ } },
    } as unknown as Parameters<typeof SubconsciousPlugin>[0];
    const hooks = await SubconsciousPlugin(pluginInput);
    expect(typeof hooks["chat.message"]).toBe("function");
    const output = officialOutput("分析这个项目的结构");
    await hooks["chat.message"]?.({ sessionID: "ses_now" }, output);
    const text = (output.parts[0] as { text?: string }).text ?? "";
    expect(text.startsWith("分析这个项目的结构")).toBe(true);
    expect(text).toContain(RESOLVED_HEADER);
  });
});

describe("辅助面", () => {
  it("toSessionClient：路径/查询参数映射到窄接口", async () => {
    const sdk = fakeSdkSession([sessionEntry("ses_x", "X", 1)]);
    const client = toSessionClient(sdk);
    expect(client).toBeDefined();
    await client?.list({ directory: "/repo" });
    expect(sdk.calls.listQuery).toEqual({ directory: "/repo" });
    await client?.get("ses_x");
    expect(sdk.calls.gotId).toBe("ses_x");
    await client?.diff("ses_x");
    expect(sdk.calls.diffId).toBe("ses_x");
  });

  it("toSessionClient：宿主 client 缺失 → undefined", () => {
    expect(toSessionClient(undefined)).toBeUndefined();
  });

  it("resolvePluginTimeoutMs：默认 5000；正整数采纳；非法回退；上限 30000", () => {
    expect(resolvePluginTimeoutMs()).toBe(DEFAULT_TOTAL_TIMEOUT_MS);
    expect(DEFAULT_TOTAL_TIMEOUT_MS).toBe(5000);
    expect(MAX_TOTAL_TIMEOUT_MS).toBe(30000);
    expect(resolvePluginTimeoutMs({ SUBCONSCIOUS_OPENCODE_TIMEOUT_MS: "42" })).toBe(42);
    expect(resolvePluginTimeoutMs({ SUBCONSCIOUS_OPENCODE_TIMEOUT_MS: "999999" })).toBe(MAX_TOTAL_TIMEOUT_MS);
    expect(resolvePluginTimeoutMs({ SUBCONSCIOUS_OPENCODE_TIMEOUT_MS: "nope" })).toBe(DEFAULT_TOTAL_TIMEOUT_MS);
    expect(resolvePluginTimeoutMs({ SUBCONSCIOUS_OPENCODE_TIMEOUT_MS: "-3" })).toBe(DEFAULT_TOTAL_TIMEOUT_MS);
  });

  it("composeInjectionContext：空输出无记录 → undefined（no-op）", () => {
    expect(composeInjectionContext({ resolvedRefs: [], droppedRefs: [] }, [], DEFAULT_ENGINE_LIMITS)).toBeUndefined();
  });
});
