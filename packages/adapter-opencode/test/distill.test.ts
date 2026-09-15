/**
 * 惯例蒸馏测试（M5c-2）：输出校验 / 去抖（冷却窗口）/ 临时会话注册表（防自触发）/
 * 素材读取（session.get + diff）/ 蒸馏执行面（临时会话 create→prompt→delete）/
 * session.idle 触发全链路 / plugin 接线。全部离线：SDK 客户端用 heyapi 形状假实现，
 * 绝不真调宿主（真实 OpenCode 宿主端到端未做——监督约束禁改全局宿主配置）。
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importMemory, InMemoryMemoryStore } from "@subconscious/core";
import {
  buildConventionEntries,
  composeDistillPrompt,
  createDistillDebouncer,
  DEFAULT_DISTILL_TIMEOUT_MS,
  DISTILL_COOLDOWN_MS,
  DISTILL_TEMP_SESSION_TITLE,
  distillViaTempSession,
  extractDistillCandidates,
  isDistillEnabled,
  isDistillTempSession,
  looksSensitive,
  markDistillTempSession,
  MAX_DISTILL_CONVENTIONS,
  MAX_TEMP_SESSIONS,
  readSessionMaterial,
  resolveDistillTimeoutMs,
  runDistillation,
  sessionIdOfIdleEvent,
  toDistillSessionClient,
  triggerIdleDistillation,
} from "../src/index.js";
import type { DistillSessionClient, SessionClient } from "../src/index.js";
import { SubconsciousPlugin } from "../src/plugin.js";

const T = Date.parse("2026-09-15T10:00:00Z");
const BASE = { projectKey: "/work/proj", sessionId: "ses_1", sessionTitle: "错误处理改造", now: new Date(T) };

describe("开关 / 超时 / 事件窄化", () => {
  it("默认开启；SUBCONSCIOUS_DISTILL=0 关闭", () => {
    expect(isDistillEnabled({})).toBe(true);
    expect(isDistillEnabled({ SUBCONSCIOUS_DISTILL: "0" })).toBe(false);
  });

  it("超时缺省 60s、封顶 300s、非法回退", () => {
    expect(resolveDistillTimeoutMs({})).toBe(DEFAULT_DISTILL_TIMEOUT_MS);
    expect(resolveDistillTimeoutMs({ SUBCONSCIOUS_DISTILL_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(resolveDistillTimeoutMs({ SUBCONSCIOUS_DISTILL_TIMEOUT_MS: "999999" })).toBe(300000);
    expect(resolveDistillTimeoutMs({ SUBCONSCIOUS_DISTILL_TIMEOUT_MS: "x" })).toBe(DEFAULT_DISTILL_TIMEOUT_MS);
  });

  it("sessionIdOfIdleEvent：只认 session.idle 且 sessionID 为非空字符串", () => {
    expect(sessionIdOfIdleEvent({ type: "session.idle", properties: { sessionID: "s1" } })).toBe("s1");
    expect(sessionIdOfIdleEvent({ type: "session.status", properties: { sessionID: "s1" } })).toBeNull();
    expect(sessionIdOfIdleEvent({ type: "session.idle", properties: {} })).toBeNull();
    expect(sessionIdOfIdleEvent({ type: "session.idle", properties: { sessionID: "" } })).toBeNull();
    expect(sessionIdOfIdleEvent({ type: "session.idle" })).toBeNull();
  });
});

describe("输出校验与条目构建", () => {
  it("解析：合法/围栏/夹带；非法与非数组 → null；空字段丢弃；超 5 截断", () => {
    expect(extractDistillCandidates('[{"expression":"a","content":"b"}]')).toEqual([{ expression: "a", content: "b" }]);
    expect(extractDistillCandidates("```json\n[{\"expression\":\"a\",\"content\":\"b\"}]\n```")).toEqual([
      { expression: "a", content: "b" },
    ]);
    expect(extractDistillCandidates("说明 [ {\"expression\":\"a\",\"content\":\"b\"} ]")).toEqual([
      { expression: "a", content: "b" },
    ]);
    expect(extractDistillCandidates("无内容")).toBeNull();
    expect(extractDistillCandidates("[]")).toEqual([]);
    expect(
      extractDistillCandidates(JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ expression: `e${i}`, content: `c${i}` })))),
    ).toHaveLength(MAX_DISTILL_CONVENTIONS);
  });

  it("敏感粗筛与条目构建（超限丢弃、溯源补齐）", () => {
    expect(looksSensitive("ghp_abcdefghijklmnopqrst")).toBe(true);
    expect(looksSensitive("提交信息用 conventional commits")).toBe(false);
    const entries = buildConventionEntries(
      [
        { expression: "提交信息", content: "feat/fix 前缀" },
        { expression: "名字超过十六个字符的惯例一定会被丢弃的", content: "x" },
      ],
      BASE,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.basedOnSessionTitle).toBe("错误处理改造");
  });

  it("提示词含项目、现有惯例与素材", () => {
    const prompt = composeDistillPrompt({ projectKey: "/work/proj", existingExpressions: ["目录组织"], material: "素材 M" });
    expect(prompt).toContain("项目：/work/proj");
    expect(prompt).toContain("现有惯例：「目录组织」");
    expect(prompt).toContain("素材 M");
  });
});

describe("去抖（冷却窗口）与临时会话注册表", () => {
  it("冷却窗口内跳过；窗口过后可再蒸馏（session.idle 每轮触发的适配）", () => {
    const debouncer = createDistillDebouncer(DISTILL_COOLDOWN_MS);
    const t0 = T;
    expect(debouncer.shouldDistill("ses_1", t0)).toBe(true);
    expect(debouncer.shouldDistill("ses_1", t0 + 1000)).toBe(false);
    expect(debouncer.shouldDistill("ses_1", t0 + DISTILL_COOLDOWN_MS + 1)).toBe(true);
  });

  it("临时会话注册表：登记即命中；容量上限淘汰最早", () => {
    expect(isDistillTempSession("tmp_1")).toBe(false);
    markDistillTempSession("tmp_1");
    expect(isDistillTempSession("tmp_1")).toBe(true);
    for (let i = 0; i < MAX_TEMP_SESSIONS; i += 1) markDistillTempSession(`bulk_${i}`);
    expect(isDistillTempSession("tmp_1")).toBe(false); // 被容量淘汰
  });
});

describe("素材读取（session.get + session.diff）", () => {
  function fakeMaterialSession(title: string, diffs: unknown[]): SessionClient & { getIds: string[] } {
    const getIds: string[] = [];
    return {
      getIds,
      async list() {
        return { data: [] };
      },
      async get(id) {
        getIds.push(id);
        return { data: { id, title, directory: "/work/proj", time: { created: 1, updated: T } } };
      },
      async diff() {
        return { data: diffs };
      },
    };
  }

  it("标题 + FileDiff 摘录，条数上限 60；get 失败 → null", async () => {
    const diffs = Array.from({ length: 70 }, (_, i) => ({
      file: `src/file${i}.ts`,
      before: "const a = 1;",
      after: "const a = 2;",
      additions: 1,
      deletions: 1,
    }));
    const material = await readSessionMaterial(fakeMaterialSession("改造会话", diffs), "ses_1");
    expect(material).not.toBeNull();
    expect(material?.sessionTitle).toBe("改造会话");
    expect(material?.material).toContain("会话标题：改造会话");
    expect(material?.material).toContain("[edit] src/file0.ts（+1/-1）");
    expect(material?.material).not.toContain("src/file60.ts"); // 条数上限
    const broken: SessionClient = {
      async list() {
        return { data: [] };
      },
      async get() {
        throw new Error("不可用");
      },
      async diff() {
        return { data: [] };
      },
    };
    expect(await readSessionMaterial(broken, "ses_1")).toBeNull();
  });
});

describe("蒸馏执行面（临时会话 + client.session.prompt）", () => {
  interface DistillCalls {
    create: Array<{ title?: string; directory?: string }>;
    prompt: Array<{ system: string; tools?: Record<string, boolean>; id: string }>;
    deleted: string[];
  }

  function fakeDistillClient(reply: string): DistillSessionClient & { calls: DistillCalls } {
    const calls: DistillCalls = { create: [], prompt: [], deleted: [] };
    let seq = 0;
    return {
      calls,
      async create(options) {
        calls.create.push({ title: options?.body?.title, directory: options?.query?.directory });
        seq += 1;
        return { data: { id: `tmp_ses_${seq}` } };
      },
      async prompt(options) {
        calls.prompt.push({ system: options.body.system ?? "", tools: options.body.tools, id: options.path.id });
        return { data: { info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: reply }] } };
      },
      async delete(options) {
        calls.deleted.push(options.path.id);
        return { data: {} };
      },
    };
  }

  it("create（标题+directory）→ prompt（system=提示词、tools 空）→ 临时会话登记 → 删除", async () => {
    const client = fakeDistillClient('[{"expression":"错误处理","content":"统一 try/catch"}]');
    const text = await distillViaTempSession("提示词内容", client, "/work/proj", 5000);
    expect(text).toContain("错误处理");
    expect(client.calls.create[0]?.title).toBe(DISTILL_TEMP_SESSION_TITLE);
    expect(client.calls.create[0]?.directory).toBe("/work/proj");
    expect(client.calls.prompt[0]?.system).toBe("提示词内容");
    expect(client.calls.prompt[0]?.tools).toEqual({}); // 结构性禁用工具
    expect(client.calls.deleted).toEqual(["tmp_ses_1"]);
    expect(isDistillTempSession("tmp_ses_1")).toBe(true); // 防自触发登记（删除后保留用于事件跳过）
  });

  it("prompt 失败也删除临时会话（finally）；响应缺 text part / 携带 error → reject", async () => {
    const calls: DistillCalls = { create: [], prompt: [], deleted: [] };
    const failing: DistillSessionClient = {
      async create() {
        return { data: { id: "tmp_x" } };
      },
      async prompt() {
        throw new Error("宿主故障");
      },
      async delete(options) {
        calls.deleted.push(options.path.id);
        return { data: {} };
      },
    };
    await expect(distillViaTempSession("p", failing, "/d", 5000)).rejects.toThrow("宿主故障");
    expect(calls.deleted).toEqual(["tmp_x"]);
    const errored: DistillSessionClient = {
      async create() {
        return { data: { id: "tmp_e" } };
      },
      async prompt() {
        return { data: { info: { error: { message: "provider down" } }, parts: [{ type: "text", text: "x" }] } };
      },
      async delete() {
        return { data: {} };
      },
    };
    await expect(distillViaTempSession("p", errored, "/d", 5000)).rejects.toThrow("蒸馏回复不可用");
  });

  it("toDistillSessionClient：三方法齐全才可用", () => {
    expect(toDistillSessionClient(undefined)).toBeUndefined();
    expect(toDistillSessionClient({ create: async () => ({ data: {} }) })).toBeUndefined();
    const full = {
      create: async () => ({ data: { id: "x" } }),
      prompt: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
    };
    expect(toDistillSessionClient(full)).toBeDefined();
  });
});

describe("session.idle 触发全链路（fire-and-forget + 写回）", () => {
  it("triggerIdleDistillation：素材 → 假执行器 → 写回 memory.json（开关/临时会话/去抖路径）", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sc-oc-distill-"));
    const memoryFile = path.join(root, "memory.json");
    const env = { SUBCONSCIOUS_MEMORY_FILE: memoryFile };
    const materialSession: SessionClient = {
      async list() {
        return { data: [] };
      },
      async get() {
        return { data: { id: "ses_oc", title: "改造会话", time: { created: 1, updated: T } } };
      },
      async diff() {
        return { data: [{ file: "src/a.ts", before: "a", after: "b", additions: 1, deletions: 1 }] };
      },
    };
    const prompts: string[] = [];
    const started = await triggerIdleDistillation(
      {
        sessionID: "ses_oc",
        directory: "/work/proj",
        session: materialSession,
      },
      {
        env,
        executor: async (prompt) => {
          prompts.push(prompt);
          return '[{"expression":"错误处理","content":"统一 try/catch 并 log"}]';
        },
      },
    );
    expect(started).toBe(true);
    expect(prompts[0]).toContain("[edit] src/a.ts");
    const memory = importMemory(await readFile(memoryFile, "utf8"));
    expect(memory?.conventions).toHaveLength(1);
    expect(memory?.conventions[0]?.projectKey).toBe("/work/proj");
    expect(memory?.conventions[0]?.basedOnSessionId).toBe("ses_oc");

    // 开关关闭 / 临时会话 / 冷却窗口内重复 → 不触发
    expect(
      await triggerIdleDistillation({ sessionID: "ses_oc2", directory: "/work/proj", session: materialSession }, {
        env: { ...env, SUBCONSCIOUS_DISTILL: "0" },
        executor: async () => "[]",
      }),
    ).toBe(false);
    markDistillTempSession("ses_oc3");
    expect(
      await triggerIdleDistillation({ sessionID: "ses_oc3", directory: "/work/proj", session: materialSession }, {
        env,
        executor: async () => "[]",
      }),
    ).toBe(false);
    expect(
      await triggerIdleDistillation({ sessionID: "ses_oc", directory: "/work/proj", session: materialSession }, {
        env,
        executor: async () => {
          throw new Error("不应到达（冷却窗口）");
        },
      }),
    ).toBe(false);
  });

  it("蒸馏 client 缺失（三方法不齐）→ 跳过并记 warn", async () => {
    const logs: string[] = [];
    const started = await triggerIdleDistillation(
      { sessionID: "s", directory: "/d" },
      {
        env: {},
        logger: (entry) => logs.push(JSON.stringify(entry)),
      },
    );
    expect(started).toBe(false);
    expect(logs.some((line) => line.includes("蒸馏 client 不可用"))).toBe(true);
  });

  it("runDistillation（注入 store）：相同输出丢弃、敏感丢弃、fail-open", async () => {
    const store = new InMemoryMemoryStore(undefined, () => T);
    const run = (sessionId: string, raw: string): Promise<number> =>
      runDistillation({ projectKey: "/p", sessionId, sessionTitle: "", material: "素材" }, {
        store,
        env: {},
        executor: async () => raw,
        now: () => T,
      });
    expect(await run("s1", '[{"expression":"命名风格","content":"v1"}]')).toBe(1);
    expect(await run("s2", '[{"expression":"命名风格","content":"v1"}]')).toBe(0);
    expect(await run("s2", '[{"expression":"密钥","content":"sk-abcdefghijklmnopqrst"},{"expression":"命名风格","content":"v2"}]')).toBe(1);
    expect(await run("s3", "非 JSON")).toBe(0);
    const conventions = await store.listConventions("/p");
    expect(conventions.map((c) => `${c.expression}=${c.content}`).sort()).toEqual(["命名风格=v2"]);
  });
});

describe("SubconsciousPlugin 接线（event hook + 临时会话防自触发）", () => {
  type PluginHooks = Awaited<ReturnType<typeof SubconsciousPlugin>>;
  type ChatMessageHook = NonNullable<PluginHooks["chat.message"]>;

  /** 满足官方 Hooks["chat.message"] 输出形状的完整假输出（同 plugin.test.ts 纪律） */
  function officialOutput(text: string): Parameters<ChatMessageHook>[1] {
    return {
      message: {
        id: "msg_1",
        sessionID: "ses_msg",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "p", modelID: "m" },
      },
      parts: [{ id: "part_1", sessionID: "ses_msg", messageID: "msg_1", type: "text", text }],
    };
  }

  function fakeFullClient(reply: string): {
    list: () => Promise<{ data: unknown[] }>;
    get: (options: { path: { id: string } }) => Promise<{ data?: unknown }>;
    diff: () => Promise<{ data: unknown[] }>;
    create: (options?: { body?: { title?: string }; query?: { directory?: string } }) => Promise<{ data?: unknown }>;
    prompt: (options: { body: { parts: object[]; system?: string; tools?: Record<string, boolean> }; path: { id: string } }) => Promise<{ data?: unknown }>;
    delete: (options: { path: { id: string } }) => Promise<{ data?: unknown }>;
  } {
    return {
      async list() {
        return { data: [] };
      },
      async get(options) {
        return { data: { id: options.path.id, title: "接线会话", time: { created: 1, updated: T } } };
      },
      async diff() {
        return { data: [{ file: "src/a.ts", before: "a", after: "b", additions: 1, deletions: 1 }] };
      },
      async create() {
        return { data: { id: "tmp_wire" } };
      },
      async prompt() {
        return { data: { info: {}, parts: [{ type: "text", text: reply }] } };
      },
      async delete() {
        return { data: {} };
      },
    };
  }

  it("event: session.idle → 后台蒸馏写回（轮询等待）；临时会话的 idle 不触发", { timeout: 15000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sc-oc-wire-"));
    const memoryFile = path.join(root, "memory.json");
    // SubconsciousPlugin 无 env 注入通道：测试内临时改写记忆路径钉（setup 已钉过，
    // 此处换到本用例自己的临时文件，避免与其他用例共享）
    const previous = process.env.SUBCONSCIOUS_MEMORY_FILE;
    process.env.SUBCONSCIOUS_MEMORY_FILE = memoryFile;
    try {
      const client = fakeFullClient('[{"expression":"错误处理","content":"统一 try/catch"}]');
      const hooks: PluginHooks = await SubconsciousPlugin({
        directory: "/work/proj",
        client: { session: client },
      } as unknown as Parameters<typeof SubconsciousPlugin>[0]);
      expect(typeof hooks.event).toBe("function");
      await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_wire" } } });
      const deadline = Date.now() + 10000;
      let memory: ReturnType<typeof importMemory> = null;
      while (Date.now() < deadline) {
        memory = importMemory(await readFile(memoryFile, "utf8").catch(() => ""));
        if (memory !== null && memory.conventions.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(memory?.conventions).toHaveLength(1);
      expect(memory?.conventions[0]?.projectKey).toBe("/work/proj");

      // 临时会话的 idle：不触发（无新写入，且不抛出）
      markDistillTempSession("tmp_wire");
      await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "tmp_wire" } } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const after = importMemory(await readFile(memoryFile, "utf8"));
      expect(after?.conventions).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.SUBCONSCIOUS_MEMORY_FILE;
      else process.env.SUBCONSCIOUS_MEMORY_FILE = previous;
    }
  });

  it("chat.message：蒸馏临时会话的消息跳过注入（防素材污染/自触发）", async () => {
    const client = fakeFullClient("[]");
    const hooks: PluginHooks = await SubconsciousPlugin({
      directory: "/work/proj",
      client: { session: client },
    } as unknown as Parameters<typeof SubconsciousPlugin>[0]);
    markDistillTempSession("ses_temp_msg");
    const output = officialOutput("分析这个项目的结构");
    await hooks["chat.message"]?.({ sessionID: "ses_temp_msg" }, output);
    const text = (output.parts[0] as { text?: string }).text ?? "";
    expect(text).toBe("分析这个项目的结构"); // 原样：临时会话不注入
  });
});
