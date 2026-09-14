import { describe, expect, it } from "vitest";
import { assemble } from "../src/assembler.js";
import { createEngine } from "../src/engine.js";
import { DEFAULT_SOURCES } from "../src/sources/index.js";
import { recordingEnv } from "./helpers.js";
import type { ResolvedItem } from "../src/assembler.js";
import { DEFAULT_ENGINE_LIMITS } from "../src/types.js";

/**
 * 验收矩阵「注入」行：
 * - 只注入 resolved；标来源、可见（注入头）；原话不改写；内容大小有界。
 * - 附件走独立通道，base64 绝不进 context 文本。
 */

function item(partial: { text: string; display: string; sourceId: string }): ResolvedItem {
  return {
    ref: { id: `ref-${partial.sourceId}`, span: [0, partial.text.length], text: partial.text, expectedType: "text", confidence: 1 },
    value: { type: "text", text: partial.display },
    display: partial.display,
    sourceId: partial.sourceId,
  };
}

describe("注入格式与透明性", () => {
  it("注入头固定；每项带指代原文、解析展示与来源标注", () => {
    const out = assemble(
      [item({ text: "这个文件", display: "/tmp/a.ts:42（当前编辑器）", sourceId: "active-editor" })],
      [{ refId: "ref-x", reason: "not-found" }],
      { limits: DEFAULT_ENGINE_LIMITS },
    );
    expect(out.context).toContain("[潜意识引擎·已解析]");
    expect(out.context).toContain('- "这个文件" → /tmp/a.ts:42（当前编辑器）（来源：active-editor）');
    expect(out.resolvedRefs).toEqual([{ refId: "ref-active-editor", display: "/tmp/a.ts:42（当前编辑器）" }]);
    expect(out.droppedRefs).toEqual(["ref-x"]);
    expect(out.dropReasons).toEqual({ "ref-x": "not-found" });
  });

  it("多行 display 缩进续行；未解析指代不出现在 context", () => {
    const out = assemble(
      [item({ text: "上次", display: "绑定会话 s1：\n1. edit a.ts\n  - old\n  + new", sourceId: "session-content" })],
      [{ refId: "ref-2", reason: "no-binding" }],
      { limits: DEFAULT_ENGINE_LIMITS },
    );
    expect(out.context).toContain("绑定会话 s1：\n    1. edit a.ts");
    expect(out.context).not.toContain("no-binding"); // 放弃原因不进注入文本
  });

  it("无 resolved 项 → context undefined（no-op 透传）", () => {
    const out = assemble([], [{ refId: "r", reason: "not-found" }], { limits: DEFAULT_ENGINE_LIMITS });
    expect(out.context).toBeUndefined();
    expect(out.attachments).toBeUndefined();
  });
});

describe("注入大小界限", () => {
  it("超限截断并显式标注", () => {
    const big = "x".repeat(500);
    const items = Array.from({ length: 20 }, (_, i): ResolvedItem => item({ text: `t${i}`, display: big, sourceId: `s${i}` }));
    const out = assemble(items, [], { limits: { ...DEFAULT_ENGINE_LIMITS, maxContextChars: 800 } });
    expect((out.context ?? "").length).toBeLessThanOrEqual(800);
    expect(out.context).toContain("[已截断");
  });

  it("单条 diff 有界（session-content 上限）", async () => {
    const hugeDiff = `line\n`.repeat(5000);
    const { env } = recordingEnv({
      cwd: "/tmp",
      listRecentSessions: async () => [{ id: "s1", title: "大会话", at: "2026-09-10T10:00:00.000Z" }],
      readSessionContent: async () => ({
        sessionId: "s1",
        changes: [
          { at: "2026-09-10T10:00:00.000Z", tool: "edit", path: "big.ts", oldText: hugeDiff, newText: hugeDiff },
        ],
      }),
    });
    const engine = createEngine({ sources: DEFAULT_SOURCES });
    const out = await engine.enrich("把这个函数改成和上次一样的错误处理", env);
    expect(out.context).toBeDefined();
    expect(out.context?.length).toBeLessThanOrEqual(DEFAULT_ENGINE_LIMITS.maxContextChars);
    expect(out.context).toContain("已截断");
  });
});

describe("附件通道结构分离", () => {
  it("图片值只进 attachments，base64 不进 context（结构上不可能）", () => {
    const imageItem: ResolvedItem = {
      ref: { id: "ref-1", span: [0, 3], text: "那张图", expectedType: "image", confidence: 0.9 },
      value: { type: "image", path: "/tmp/f.jpg", mediaType: "image/jpeg", base64: "SEVMTE9fQkFTRTY0" },
      display: "/tmp/f.jpg",
      sourceId: "photo",
    };
    const out = assemble([imageItem], [], { limits: DEFAULT_ENGINE_LIMITS });
    expect(out.attachments).toEqual([{ mediaType: "image/jpeg", base64: "SEVMTE9fQkFTRTY0" }]);
    expect(out.context).toBeDefined();
    expect(out.context).not.toContain("SEVMTE9fQkFTRTY0");
  });

  it("非 image/* MIME 的附件被拒绝", () => {
    const badItem: ResolvedItem = {
      ref: { id: "ref-1", span: [0, 3], text: "那张图", expectedType: "image", confidence: 0.9 },
      value: { type: "image", path: "/tmp/f.txt", mediaType: "text/plain", base64: "eHg=" },
      display: "/tmp/f.txt",
      sourceId: "photo",
    };
    const out = assemble([badItem], [], { limits: DEFAULT_ENGINE_LIMITS });
    expect(out.attachments).toBeUndefined();
  });
});

describe("原话不改写", () => {
  it("EnrichOutput 不含改写后的 prompt；context 为独立附加文本", async () => {
    const { env } = recordingEnv({
      cwd: "/tmp",
      activeEditor: { path: "/tmp/a.ts", line: 42 },
    });
    const engine = createEngine({ sources: DEFAULT_SOURCES });
    const prompt = "这个文件还有问题";
    const out = await engine.enrich(prompt, env);
    expect(out.context).toBeDefined();
    // 输出字段封闭：没有 rewrittenPrompt/prompt 之类字段
    expect(Object.keys(out).sort()).toEqual(["context", "dropReasons", "droppedRefs", "resolvedRefs", "timedOut"].sort());
    // 引用的指代文本是原文切片，不是改写
    expect(out.context).toContain('"这个文件"');
  });
});
