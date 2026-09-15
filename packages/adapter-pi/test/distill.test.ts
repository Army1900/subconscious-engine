/**
 * 惯例蒸馏单元测试（M5c-2）：提示词组装 / 输出校验（形状/超5截断/敏感粗筛）/
 * 素材组装（用户话语 + 修改记录）/ 去抖 / 开关 / fail-open / 写回。
 * 蒸馏执行器全部注入假实现（离线，绝不真调宿主 CLI；真实 spawn 路径见
 * distill-child.proc.test.ts 的假可执行文件注入）。
 */
import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "@subconscious/core";
import type { Logger, LogEntry, SessionChange } from "@subconscious/core";
import {
  buildConventionEntries,
  composeDistillPrompt,
  createDistillDebouncer,
  DEFAULT_DISTILL_TIMEOUT_MS,
  DISTILL_BIN_ENV_VAR,
  extractDistillCandidates,
  headlessPiArgs,
  isDistillEnabled,
  looksSensitive,
  MAX_DISTILL_CONVENTIONS,
  renderSessionMaterial,
  resolveDistillTimeoutMs,
  runDistillation,
} from "../src/distill.js";
import { parseUserTurns } from "../src/session-jsonl.js";

const T = Date.parse("2026-09-15T10:00:00Z");
const BASE = { projectKey: "/work/proj", sessionId: "ses_1", sessionTitle: "错误处理改造", now: new Date(T) };

describe("开关与超时", () => {
  it("默认开启；SUBCONSCIOUS_DISTILL=0 关闭；其余值含空串均开启", () => {
    expect(isDistillEnabled({})).toBe(true);
    expect(isDistillEnabled({ SUBCONSCIOUS_DISTILL: "0" })).toBe(false);
    expect(isDistillEnabled({ SUBCONSCIOUS_DISTILL: "" })).toBe(true);
  });

  it("超时：缺省 60s；正整数生效并封顶；非法回退缺省", () => {
    expect(resolveDistillTimeoutMs({})).toBe(DEFAULT_DISTILL_TIMEOUT_MS);
    expect(resolveDistillTimeoutMs({ SUBCONSCIOUS_DISTILL_TIMEOUT_MS: "12345" })).toBe(12345);
    expect(resolveDistillTimeoutMs({ SUBCONSCIOUS_DISTILL_TIMEOUT_MS: "999999" })).toBe(300000);
    expect(resolveDistillTimeoutMs({ SUBCONSCIOUS_DISTILL_TIMEOUT_MS: "abc" })).toBe(DEFAULT_DISTILL_TIMEOUT_MS);
  });

  it("headless pi 参数：README 已验证形态（--no-extensions 结构性杜绝再触发本扩展）", () => {
    const args = headlessPiArgs("提示词");
    expect(args).toEqual(["--offline", "--no-session", "--no-extensions", "--no-skills", "--no-tools", "-p", "提示词"]);
  });

  it("DISTILL_BIN 变量名导出（假可执行文件注入面）", () => {
    expect(DISTILL_BIN_ENV_VAR).toBe("SUBCONSCIOUS_DISTILL_BIN");
  });
});

describe("提示词与输出校验", () => {
  it("提示词含项目、现有惯例与素材", () => {
    const prompt = composeDistillPrompt({ projectKey: "/work/proj", existingExpressions: ["命名风格"], material: "素材 A" });
    expect(prompt).toContain("项目：/work/proj");
    expect(prompt).toContain("现有惯例：「命名风格」");
    expect(prompt).toContain("素材 A");
    expect(prompt).toContain(`最多 ${MAX_DISTILL_CONVENTIONS} 条`);
  });

  it("输出解析：合法/围栏/夹带文本可解；非法 JSON 与非数组 → null；空字段逐条丢弃；超 5 截断", () => {
    expect(extractDistillCandidates('[{"expression":"a","content":"b"}]')).toEqual([{ expression: "a", content: "b" }]);
    expect(extractDistillCandidates("```json\n[{\"expression\":\"a\",\"content\":\"b\"}]\n```")).toEqual([
      { expression: "a", content: "b" },
    ]);
    expect(extractDistillCandidates("前缀 [ {\"expression\":\"a\",\"content\":\"b\"} ] 后缀")).toEqual([
      { expression: "a", content: "b" },
    ]);
    expect(extractDistillCandidates("没有数组")).toBeNull();
    expect(extractDistillCandidates("[]")).toEqual([]);
    expect(extractDistillCandidates('{"a":1}')).toBeNull();
    expect(
      extractDistillCandidates('[{"expression":"","content":"b"},{"expression":"a","content":"b"}]'),
    ).toEqual([{ expression: "a", content: "b" }]);
    expect(
      extractDistillCandidates(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ expression: `e${i}`, content: `c${i}` })))),
    ).toHaveLength(MAX_DISTILL_CONVENTIONS);
  });

  it("敏感粗筛命中与不命中", () => {
    expect(looksSensitive("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(looksSensitive("xoxb-1234567890abcdef")).toBe(true);
    expect(looksSensitive("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksSensitive("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(true);
    expect(looksSensitive("统一用 vitest，测试放 test/ 目录")).toBe(false);
  });

  it("条目构建补齐溯源字段；超限 expression 丢弃", () => {
    const entries = buildConventionEntries(
      [
        { expression: "测试约定", content: "测试全部离线，mock 注入子进程" },
        { expression: "超过十六个字符的惯例名称会被丢弃掉吗", content: "x" },
      ],
      BASE,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.basedOnSessionTitle).toBe("错误处理改造");
    expect(entries[0]?.lastHitAt).toBe("2026-09-15T10:00:00.000Z");
  });
});

describe("会话素材（parseUserTurns + renderSessionMaterial）", () => {
  it("parseUserTurns：字符串与块数组两种官方形态；坏行/非文本块/空文本跳过", () => {
    const text = [
      '{"type":"message","message":{"role":"user","content":"按老规矩处理"}}',
      '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"统一"},{"type":"image","data":"x"}]}}',
      "坏行 {",
      '{"type":"message","message":{"role":"assistant","content":"不是用户"}}',
      '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"  "}]}}',
      '{"type":"session","id":"ses_1"}',
    ].join("\n");
    expect(parseUserTurns(text)).toEqual(["按老规矩处理", "统一"]);
  });

  it("renderSessionMaterial：标题 + 用户话语 + 非错误修改；isError 跳过；条数/字符上限", () => {
    const changes: SessionChange[] = [
      { tool: "edit", at: "2026-09-15T09:00:00Z", path: "src/a.ts", oldText: "old", newText: "new" },
      { tool: "write", at: "2026-09-15T09:01:00Z", path: "src/b.ts", content: "新文件" },
      { tool: "edit", at: "2026-09-15T09:02:00Z", path: "src/c.ts", oldText: "x", newText: "y", isError: true },
    ];
    const material = renderSessionMaterial({ sessionTitle: "错误处理改造", userTurns: ["照旧"], changes });
    expect(material).toContain("会话标题：错误处理改造");
    expect(material).toContain("- 照旧");
    expect(material).toContain("[edit] src/a.ts");
    expect(material).toContain("[write] src/b.ts");
    expect(material).not.toContain("src/c.ts"); // 失败修改不进素材（D9 同源）
    const capped = renderSessionMaterial({
      sessionTitle: "t",
      userTurns: Array.from({ length: 100 }, (_, i) => `turn${i}`),
      changes: [],
    });
    expect(capped).not.toContain("turn50"); // 条数上限 40
  });
});

describe("去抖", () => {
  it("同会话只蒸馏一次；不同会话互不影响；容量上限淘汰最早", () => {
    const debouncer = createDistillDebouncer();
    const t0 = 1_000_000;
    expect(debouncer.shouldDistill("ses_1", t0)).toBe(true);
    expect(debouncer.shouldDistill("ses_1", t0 + 5000)).toBe(false);
    expect(debouncer.shouldDistill("ses_2", t0)).toBe(true);
    const capped = createDistillDebouncer(Number.POSITIVE_INFINITY, 1);
    expect(capped.shouldDistill("a", t0)).toBe(true);
    expect(capped.shouldDistill("b", t0)).toBe(true);
    expect(capped.shouldDistill("a", t0 + 1)).toBe(true); // a 已被淘汰
  });
});

describe("蒸馏主流程（fail-open + 写回）", () => {
  it("合法输出 → 写回；执行器收到含素材的提示词", async () => {
    const store = new InMemoryMemoryStore(undefined, () => T);
    const prompts: string[] = [];
    const written = await runDistillation(
      { projectKey: "/work/proj", sessionId: "ses_1", sessionTitle: "T", material: "用户话语：统一 try/catch" },
      {
        store,
        executor: async (prompt) => {
          prompts.push(prompt);
          return '[{"expression":"错误处理","content":"统一 try/catch 并 log"}]';
        },
        now: () => T,
      },
    );
    expect(written).toBe(1);
    expect(prompts[0]).toContain("统一 try/catch");
    expect(await store.listConventions("/work/proj")).toHaveLength(1);
  });

  it("与现有条目逐字节相同丢弃；内容变化后写胜（溯源更新）", async () => {
    const store = new InMemoryMemoryStore(undefined, () => T);
    const run = (sessionId: string, content: string): Promise<number> =>
      runDistillation(
        { projectKey: "/work/proj", sessionId, sessionTitle: "T", material: "素材" },
        { store, executor: async () => JSON.stringify([{ expression: "错误处理", content }]), now: () => T },
      );
    expect(await run("ses_1", "v1")).toBe(1);
    expect(await run("ses_2", "v1")).toBe(0);
    expect(await run("ses_2", "v2")).toBe(1);
    const conventions = await store.listConventions("/work/proj");
    expect(conventions).toHaveLength(1);
    expect(conventions[0]?.content).toBe("v2");
    expect(conventions[0]?.basedOnSessionId).toBe("ses_2");
  });

  it("敏感条目丢弃记 warn；执行器失败 / 非法输出 / 空素材 → 0 不抛出", async () => {
    const logs: LogEntry[] = [];
    const logger: Logger = (entry) => logs.push(entry);
    const store = new InMemoryMemoryStore(undefined, () => T);
    expect(
      await runDistillation({ projectKey: "/p", sessionId: "s", sessionTitle: "", material: "素材" }, {
        store,
        logger,
        executor: async () => '[{"expression":"令牌","content":"AKIAIOSFODNN7EXAMPLE"},{"expression":"提交信息","content":"feat/fix 前缀"}]',
      }),
    ).toBe(1);
    expect(logs.some((l) => l.event === "distill-skipped" && (l.detail ?? "").includes("令牌"))).toBe(true);
    expect(
      await runDistillation({ projectKey: "/p", sessionId: "s", sessionTitle: "", material: "素材" }, {
        store,
        executor: () => Promise.reject(new Error("pi 不存在")),
      }),
    ).toBe(0);
    expect(
      await runDistillation({ projectKey: "/p", sessionId: "s", sessionTitle: "", material: "素材" }, {
        store,
        executor: async () => "空谈",
      }),
    ).toBe(0);
    let called = 0;
    expect(
      await runDistillation({ projectKey: "/p", sessionId: "s", sessionTitle: "", material: "" }, {
        store,
        executor: async () => {
          called += 1;
          return "[]";
        },
      }),
    ).toBe(0);
    expect(called).toBe(0);
  });
});
