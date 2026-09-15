/**
 * 惯例蒸馏单元测试（M5c-2）：提示词组装 / 输出校验（形状/超5截断/敏感粗筛）/
 * 去抖 / 开关 / fail-open / 写回。蒸馏执行器全部注入假实现（离线，绝不真调
 * 宿主 CLI；真实 spawn 路径见 session-end.proc.test.ts 的假可执行文件注入）。
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "@subconscious/core";
import type { LogEntry, Logger } from "@subconscious/core";
import {
  buildConventionEntries,
  composeDistillPrompt,
  createDistillDebouncer,
  DEFAULT_DISTILL_TIMEOUT_MS,
  DISTILL_CHILD_GUARD_ENV_VAR,
  extractDistillCandidates,
  isDistillChildGuard,
  isDistillEnabled,
  looksSensitive,
  MAX_DISTILL_CONVENTIONS,
  readTailText,
  renderTranscriptMaterial,
  resolveDistillTimeoutMs,
  runDistillation,
} from "../src/distill.js";
import { parseSessionEndInput } from "../src/input.js";

const T = Date.parse("2026-09-15T10:00:00Z");
const BASE = { projectKey: "/work/proj", sessionId: "ses_1", sessionTitle: "错误处理改造", now: new Date(T) };

function memoryFile(name: string): string {
  return path.join(tmpdir(), `sc-claude-distill-unit-${process.pid}-${name}.json`);
}

describe("开关与超时", () => {
  it("默认开启；SUBCONSCIOUS_DISTILL=0 关闭；其余值含空串均开启", () => {
    expect(isDistillEnabled({})).toBe(true);
    expect(isDistillEnabled({ SUBCONSCIOUS_DISTILL: "0" })).toBe(false);
    expect(isDistillEnabled({ SUBCONSCIOUS_DISTILL: "" })).toBe(true);
    expect(isDistillEnabled({ SUBCONSCIOUS_DISTILL: "1" })).toBe(true);
  });

  it("超时：缺省 50s；正整数生效并封顶；非法回退缺省", () => {
    expect(resolveDistillTimeoutMs({})).toBe(DEFAULT_DISTILL_TIMEOUT_MS);
    expect(resolveDistillTimeoutMs({ SUBCONSCIOUS_DISTILL_TIMEOUT_MS: "12345" })).toBe(12345);
    expect(resolveDistillTimeoutMs({ SUBCONSCIOUS_DISTILL_TIMEOUT_MS: "999999" })).toBe(300000);
    expect(resolveDistillTimeoutMs({ SUBCONSCIOUS_DISTILL_TIMEOUT_MS: "-5" })).toBe(DEFAULT_DISTILL_TIMEOUT_MS);
    expect(resolveDistillTimeoutMs({ SUBCONSCIOUS_DISTILL_TIMEOUT_MS: "abc" })).toBe(DEFAULT_DISTILL_TIMEOUT_MS);
  });

  it("防递归哨兵：SUBCONSCIOUS_DISTILL_CHILD=1 命中", () => {
    expect(isDistillChildGuard({})).toBe(false);
    expect(isDistillChildGuard({ [DISTILL_CHILD_GUARD_ENV_VAR]: "1" })).toBe(true);
  });
});

describe("SessionEnd 输入解析", () => {
  const payload = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ session_id: "ses_1", transcript_path: "/t/ses_1.jsonl", cwd: "/work/proj", permission_mode: "default", hook_event_name: "SessionEnd", reason: "clear", ...over });

  it("合法载荷：消费官方通用字段 + 事件特有 reason", () => {
    const parsed = parseSessionEndInput(payload());
    expect(parsed).toEqual({
      hookEventName: "SessionEnd",
      sessionId: "ses_1",
      transcriptPath: "/t/ses_1.jsonl",
      cwd: "/work/proj",
      reason: "clear",
    });
  });

  it("缺 cwd / 非本事件 / 非法 JSON → null；session_id 与 transcript_path 缺失诚实置空", () => {
    expect(parseSessionEndInput(payload({ cwd: "" }))).toBeNull();
    expect(parseSessionEndInput(payload({ hook_event_name: "UserPromptSubmit" }))).toBeNull();
    expect(parseSessionEndInput("not json")).toBeNull();
    const missing = parseSessionEndInput(payload({ session_id: undefined, transcript_path: undefined }));
    expect(missing).not.toBeNull();
    expect(missing?.sessionId).toBe("");
    expect(missing?.transcriptPath).toBe("");
  });
});

describe("提示词组装", () => {
  it("含项目、现有惯例（空为（无））与素材；规则 5 声明上限 5", () => {
    const prompt = composeDistillPrompt({ projectKey: "/work/proj", existingExpressions: [], material: "素材 A" });
    expect(prompt).toContain("项目：/work/proj");
    expect(prompt).toContain("现有惯例：（无）");
    expect(prompt).toContain("素材 A");
    expect(prompt).toContain(`最多 ${MAX_DISTILL_CONVENTIONS} 条`);
    const withExisting = composeDistillPrompt({ projectKey: "/work/proj", existingExpressions: ["错误处理"], material: "x" });
    expect(withExisting).toContain("现有惯例：「错误处理」");
  });
});

describe("输出校验（不信模型输出）", () => {
  it("合法数组 → 候选（trim 后）；代码围栏与前后夹带文本可解", () => {
    expect(extractDistillCandidates('[{"expression":"错误处理","content":"统一 try/catch"}]')).toEqual([
      { expression: "错误处理", content: "统一 try/catch" },
    ]);
    expect(extractDistillCandidates("```json\n[{\"expression\":\"a\",\"content\":\"b\"}]\n```")).toEqual([
      { expression: "a", content: "b" },
    ]);
    expect(extractDistillCandidates('说明文字\n[{"expression":" a ","content":" b "}]')).toEqual([
      { expression: "a", content: "b" },
    ]);
  });

  it("非法 JSON → null；非数组 → null；空字段/非记录条目逐条丢弃", () => {
    expect(extractDistillCandidates("说人话")).toBeNull();
    expect(extractDistillCandidates('{"expression":"x"}')).toBeNull();
    expect(extractDistillCandidates('[{"expression":"","content":"b"},{"expression":"a","content":""},{"x":1},{"expression":"a","content":"b"}]')).toEqual([
      { expression: "a", content: "b" },
    ]);
  });

  it("超 5 条截断为前 5", () => {
    const raw = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ expression: `e${i}`, content: `c${i}` })));
    expect(extractDistillCandidates(raw)).toHaveLength(MAX_DISTILL_CONVENTIONS);
  });

  it("敏感粗筛：私钥/凭据前缀/长随机串命中，普通中文文本不命中", () => {
    expect(looksSensitive("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(looksSensitive("token sk-abcdefghijklmnopqrst")).toBe(true);
    expect(looksSensitive("ghp_abcdefghijklmnopqrst")).toBe(true);
    expect(looksSensitive("aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkL")).toBe(true);
    expect(looksSensitive("统一 try/catch 包裹并 log 错误")).toBe(false);
    expect(looksSensitive("src/engine.ts")).toBe(false);
  });

  it("条目构建：补齐 id/时间/溯源；expression 超 16 字丢弃", () => {
    const entries = buildConventionEntries(
      [
        { expression: "错误处理", content: "统一 try/catch 包裹并 log 错误" },
        { expression: "这是一个特别特别特别长的惯例名字超过上限", content: "x" },
      ],
      BASE,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.projectKey).toBe("/work/proj");
    expect(entries[0]?.basedOnSessionId).toBe("ses_1");
    expect(entries[0]?.basedOnSessionTitle).toBe("错误处理改造");
    expect(entries[0]?.hitCount).toBe(0);
    expect(entries[0]?.generatedAt).toBe("2026-09-15T10:00:00.000Z");
  });
});

describe("transcript 素材（尾部有界原文，不解析内部字段）", () => {
  it("小文件整读；大文件读尾部并对齐换行（丢弃半行）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sc-claude-tail-"));
    const small = path.join(dir, "small.jsonl");
    await writeFile(small, "line1\nline2\n", "utf8");
    expect(await readTailText(small, 1000)).toBe("line1\nline2\n");

    const big = path.join(dir, "big.jsonl");
    const lines = Array.from({ length: 20 }, (_, i) => `{"n":${i},"pad":"${"x".repeat(20)}}"`);
    await writeFile(big, lines.join("\n") + "\n", "utf8");
    const tail = await readTailText(big, 60);
    expect(tail).not.toBeNull();
    expect(tail?.startsWith("{\"n\":")).toBe(true); // 从整行开始（半行被对齐丢弃）
    expect(tail?.trimEnd().endsWith(lines[lines.length - 1] as string)).toBe(true); // 尾部整行齐全
  });

  it("文件不存在 / 编码非法 → null", async () => {
    expect(await readTailText(memoryFile("missing"), 100)).toBeNull();
    const dir = await mkdtemp(path.join(tmpdir(), "sc-claude-tail2-"));
    const bad = path.join(dir, "bad.jsonl");
    await writeFile(bad, new Uint8Array([0xff, 0xfe, 0x0a, 0x41]));
    expect(await readTailText(bad, 100)).toBeNull();
  });

  it("素材组装：原文拼接 + 近似性说明头 + 字符上限", () => {
    const material = renderTranscriptMaterial('{"role":"user","content":"按老规矩"}');
    expect(material).toContain("未解析内部字段");
    expect(material).toContain('{"role":"user","content":"按老规矩"}');
    const capped = renderTranscriptMaterial("x".repeat(20000));
    expect(capped.length).toBeLessThanOrEqual(12000);
  });
});

describe("去抖", () => {
  it("同会话只蒸馏一次（Infinity 冷却）；不同会话互不影响", () => {
    const debouncer = createDistillDebouncer();
    const t0 = Date.parse("2026-09-15T10:00:00Z");
    expect(debouncer.shouldDistill("ses_1", t0)).toBe(true);
    expect(debouncer.shouldDistill("ses_1", t0 + 1000)).toBe(false);
    expect(debouncer.shouldDistill("ses_2", t0 + 1000)).toBe(true);
  });

  it("容量上限：超出淘汰最早记录", () => {
    const debouncer = createDistillDebouncer(Number.POSITIVE_INFINITY, 2);
    const t0 = 1_000_000;
    expect(debouncer.shouldDistill("a", t0)).toBe(true);
    expect(debouncer.shouldDistill("b", t0)).toBe(true);
    expect(debouncer.shouldDistill("c", t0)).toBe(true); // 淘汰 a
    expect(debouncer.shouldDistill("a", t0)).toBe(true); // a 重新可蒸馏
  });
});

describe("蒸馏主流程（fail-open + 写回）", () => {
  it("合法输出 → 写回 store；提示词包含素材与现有惯例", async () => {
    const store = new InMemoryMemoryStore(undefined, () => T);
    const prompts: string[] = [];
    const written = await runDistillation(
      { projectKey: "/work/proj", sessionId: "ses_1", sessionTitle: "T", material: "用户多次要求 try/catch" },
      {
        store,
        executor: async (prompt) => {
          prompts.push(prompt);
          return '[{"expression":"错误处理","content":"统一 try/catch 并 log 错误，不吞异常"}]';
        },
        now: () => T,
      },
    );
    expect(written).toBe(1);
    expect(prompts[0]).toContain("用户多次要求 try/catch");
    const conventions = await store.listConventions("/work/proj");
    expect(conventions).toHaveLength(1);
    expect(conventions[0]?.expression).toBe("错误处理");
  });

  it("与现有条目逐字节相同的输出丢弃（不洗时间）；不同内容后写胜", async () => {
    const store = new InMemoryMemoryStore(undefined, () => T);
    const first = await runDistillation(
      { projectKey: "/work/proj", sessionId: "ses_1", sessionTitle: "T", material: "素材" },
      { store, executor: async () => '[{"expression":"错误处理","content":"v1"}]', now: () => T },
    );
    expect(first).toBe(1);
    const same = await runDistillation(
      { projectKey: "/work/proj", sessionId: "ses_2", sessionTitle: "T2", material: "素材2" },
      { store, executor: async () => '[{"expression":"错误处理","content":"v1"}]', now: () => T + 1000 },
    );
    expect(same).toBe(0); // 相同输出：适配器丢弃 + core upsert no-op
    const changed = await runDistillation(
      { projectKey: "/work/proj", sessionId: "ses_2", sessionTitle: "T2", material: "素材2" },
      { store, executor: async () => '[{"expression":"错误处理","content":"v2"}]', now: () => T + 2000 },
    );
    expect(changed).toBe(1);
    const conventions = await store.listConventions("/work/proj");
    expect(conventions).toHaveLength(1);
    expect(conventions[0]?.content).toBe("v2");
    expect(conventions[0]?.basedOnSessionId).toBe("ses_2"); // 后写胜：溯源一并更新
  });

  it("敏感条目丢弃并记 warn；其余条目照常写回", async () => {
    const logs: LogEntry[] = [];
    const logger: Logger = (entry) => logs.push(entry);
    const store = new InMemoryMemoryStore();
    const written = await runDistillation(
      { projectKey: "/work/proj", sessionId: "ses_1", sessionTitle: "T", material: "素材" },
      {
        store,
        logger,
        executor: async () =>
          '[{"expression":"密钥","content":"用 sk-abcdefghijklmnopqrst 这个token"},{"expression":"提交信息","content":"conventional commits 中文类型前缀"}]',
      },
    );
    expect(written).toBe(1);
    expect(logs.some((l) => l.level === "warn" && l.event === "distill-skipped" && (l.detail ?? "").includes("密钥"))).toBe(true);
    const conventions = await store.listConventions("/work/proj");
    expect(conventions[0]?.expression).toBe("提交信息");
  });

  it("执行器失败 / 输出非法 JSON / 空素材 → 0 且不抛出（fail-open）", async () => {
    const store = new InMemoryMemoryStore();
    expect(
      await runDistillation({ projectKey: "/p", sessionId: "s", sessionTitle: "", material: "素材" }, {
        store,
        executor: () => Promise.reject(new Error("claude 不存在")),
      }),
    ).toBe(0);
    expect(
      await runDistillation({ projectKey: "/p", sessionId: "s", sessionTitle: "", material: "素材" }, {
        store,
        executor: async () => "我认为没有惯例",
      }),
    ).toBe(0);
    let called = 0;
    expect(
      await runDistillation({ projectKey: "/p", sessionId: "s", sessionTitle: "", material: "  " }, {
        store,
        executor: async () => {
          called += 1;
          return "[]";
        },
      }),
    ).toBe(0);
    expect(called).toBe(0); // 空素材不发起蒸馏
    expect(await store.listConventions("/p")).toHaveLength(0);
  });
});
