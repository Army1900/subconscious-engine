import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EngineConfigError } from "../src/errors.js";
import {
  exportMemory,
  FileMemoryStore,
  importMemory,
  InMemoryMemoryStore,
  MAX_DISAMBIGUATION_RECORDS,
  MAX_PHRASES,
  PRIOR_WINDOW_DAYS,
} from "../src/memory.js";
import type { DisambiguationPrior, PersonalPhrase } from "../src/types.js";

const DAY = 86_400_000;
/** 固定"现在"：2026-09-15T12:00:00.000Z（与测试注入的 store 时钟一致） */
const NOW = Date.UTC(2026, 8, 15, 12);
const fixedNow = (): number => NOW;

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function prior(sessionId: string, daysAgo: number, projectKey = "/work/proj"): DisambiguationPrior {
  return { projectKey, sessionId, title: `会话 ${sessionId}`, at: isoDaysAgo(daysAgo) };
}

const PHRASE: PersonalPhrase = { phrase: "咱们那个摊子", expectedType: "project" };

async function pathFor(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "subconscious-memory-")), name);
}

describe("FileMemoryStore（持久化）", () => {
  it("跨实例恢复先验与词条；写入文件为 version:1 schema 且无残留临时文件", async () => {
    const file = await pathFor("memory.json");
    const first = new FileMemoryStore(file, fixedNow);
    await first.recordDisambiguation(prior("s2", 1));
    await first.addPersonalPhrase(PHRASE);

    const restored = new FileMemoryStore(file, fixedNow);
    await expect(restored.listDisambiguation()).resolves.toEqual([prior("s2", 1)]);
    await expect(restored.listPhrases()).resolves.toEqual([PHRASE]);

    const raw = await readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual({ version: 1, disambiguation: [prior("s2", 1)], phrases: [PHRASE] });
    expect(raw).toContain("\"version\": 1"); // 人可编辑的两空格缩进
    const leftovers = (await readdir(join(file, ".."))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]); // 原子写：不留临时文件
  });

  it("损坏文件 fail-open 为空记忆（行为等同今天），且后续写入可恢复", async () => {
    const file = await pathFor("memory.json");
    await writeFile(file, "not json {{{", "utf8");
    const store = new FileMemoryStore(file, fixedNow);
    await expect(store.listDisambiguation()).resolves.toEqual([]);
    await expect(store.listPhrases()).resolves.toEqual([]);

    await store.addPersonalPhrase({ phrase: "照旧", expectedType: "history-content" });
    await expect(store.listPhrases()).resolves.toEqual([{ phrase: "照旧", expectedType: "history-content" }]);
  });

  it("version 不是 1 或数组形状非法 → 空记忆（不注入半可信条目）", async () => {
    const file = await pathFor("memory.json");
    await writeFile(file, JSON.stringify({ version: 2, disambiguation: [], phrases: [] }), "utf8");
    const store = new FileMemoryStore(file, fixedNow);
    await expect(store.listDisambiguation()).resolves.toEqual([]);
    await expect(store.listPhrases()).resolves.toEqual([]);
  });

  it("写入时裁剪窗口外先验并封顶记录条数", async () => {
    const file = await pathFor("memory.json");
    const store = new FileMemoryStore(file, fixedNow);
    // 窗口外（15 天前）与窗口内（1 天前）各一条：写入即裁剪窗口外
    await store.recordDisambiguation(prior("old", PRIOR_WINDOW_DAYS + 1));
    await store.recordDisambiguation(prior("fresh", 1));
    await expect(store.listDisambiguation()).resolves.toEqual([prior("fresh", 1)]);

    // 封顶：写入 14 天内的大量记录（时间戳互异，序号越大越新），只保留最新 MAX 条
    const bulk = new FileMemoryStore(await pathFor("memory.json"), fixedNow);
    for (let i = 0; i < MAX_DISAMBIGUATION_RECORDS + 5; i += 1) {
      await bulk.recordDisambiguation(prior(`s${i}`, (MAX_DISAMBIGUATION_RECORDS + 4 - i) / 200)); // 均在窗口内且互异
    }
    const kept = await bulk.listDisambiguation();
    expect(kept.length).toBe(MAX_DISAMBIGUATION_RECORDS);
    // 保留的是最新的：s0..s4（最早的选择）被挤出
    expect(kept.map((p) => p.sessionId)).not.toContain("s0");
    expect(kept.map((p) => p.sessionId)).toContain(`s${MAX_DISAMBIGUATION_RECORDS + 4}`);
  });

  it("非法先验记录静默忽略（学习是尽力而为，不抛出）", async () => {
    const store = new FileMemoryStore(await pathFor("memory.json"), fixedNow);
    await expect(
      store.recordDisambiguation({ projectKey: "", sessionId: "s", title: "t", at: "x" } as DisambiguationPrior),
    ).resolves.toBeUndefined();
    await expect(store.listDisambiguation()).resolves.toEqual([]);
  });
});

describe("addPersonalPhrase（显式注册 API）", () => {
  it("规范化短语并按短语文本 upsert（同短语重注册替换类型）", async () => {
    const store = new InMemoryMemoryStore();
    await store.addPersonalPhrase({ phrase: "  咱们那个摊子  ", expectedType: "project" });
    await store.addPersonalPhrase({ phrase: "咱们那个摊子", expectedType: "file", hint: "主力仓库" });
    await expect(store.listPhrases()).resolves.toEqual([
      { phrase: "咱们那个摊子", expectedType: "file", hint: "主力仓库" },
    ]);
  });

  it("非法词条受控失败（EngineConfigError invalid-memory）", async () => {
    const store = new InMemoryMemoryStore();
    await expect(store.addPersonalPhrase({ phrase: "   ", expectedType: "project" })).rejects.toThrow(EngineConfigError);
    await expect(store.addPersonalPhrase({ phrase: "x".repeat(65), expectedType: "project" })).rejects.toThrow(
      EngineConfigError,
    );
    await expect(
      store.addPersonalPhrase({ phrase: "ok", expectedType: "not-a-type" as PersonalPhrase["expectedType"] }),
    ).rejects.toThrow(EngineConfigError);
    await expect(store.addPersonalPhrase({ phrase: "ok", expectedType: "project", hint: "h".repeat(201) })).rejects.toThrow(
      EngineConfigError,
    );
  });

  it("词条数封顶：超出 MAX_PHRASES 的新增受控失败，已存在短语仍可更新", async () => {
    const store = new InMemoryMemoryStore();
    for (let i = 0; i < MAX_PHRASES; i += 1) {
      await store.addPersonalPhrase({ phrase: `短语${i}`, expectedType: "text" });
    }
    await expect(store.addPersonalPhrase({ phrase: "新短语", expectedType: "text" })).rejects.toThrow(EngineConfigError);
    // upsert 不增加条数
    await store.addPersonalPhrase({ phrase: "短语0", expectedType: "project" });
    await expect((await store.listPhrases()).length).toBe(MAX_PHRASES);
  });
});

describe("exportMemory / importMemory（可移植纯函数）", () => {
  const data = {
    version: 1 as const,
    disambiguation: [prior("s2", 1)],
    phrases: [PHRASE],
  };

  it("round-trip：导出字符串再导入得到等值数据", () => {
    const text = exportMemory(data);
    expect(importMemory(text)).toEqual(data);
  });

  it("导入非法输入返回 null（不抛出、不产出半份数据）", () => {
    expect(importMemory("not json")).toBeNull();
    expect(importMemory("{}")).toBeNull(); // 缺 version/数组
    expect(importMemory(JSON.stringify({ version: 2, disambiguation: [], phrases: [] }))).toBeNull();
    expect(importMemory(JSON.stringify({ version: 1, disambiguation: [{}], phrases: [] }))).toBeNull();
    expect(
      importMemory(JSON.stringify({ version: 1, disambiguation: [], phrases: [{ phrase: "x", expectedType: "bad" }] })),
    ).toBeNull();
    // 超界数据拒绝导入
    expect(
      importMemory(
        JSON.stringify({ version: 1, disambiguation: [], phrases: Array.from({ length: MAX_PHRASES + 1 }, () => PHRASE) }),
      ),
    ).toBeNull();
  });

  it("导出非法数据受控失败（显式 API，编程错误应暴露）", () => {
    expect(() => exportMemory({ version: 1, disambiguation: [{ nope: true } as unknown as DisambiguationPrior], phrases: [] })).toThrow(
      EngineConfigError,
    );
  });

  it("导入的文件可被 FileMemoryStore 直接采用（复制文件即迁移）", async () => {
    const text = exportMemory(data);
    const file = await pathFor("memory.json");
    await writeFile(file, text, "utf8");
    const store = new FileMemoryStore(file, fixedNow);
    await expect(store.listPhrases()).resolves.toEqual([PHRASE]);
    await expect(store.listDisambiguation()).resolves.toEqual([prior("s2", 1)]);
  });
});
