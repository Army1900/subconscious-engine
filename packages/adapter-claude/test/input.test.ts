import { describe, expect, it } from "vitest";
import { parseUserPromptSubmitInput } from "../src/input.js";

/** 官方 UserPromptSubmit stdin 形状（docs.claude.com hooks reference，2026-09-14 核实） */
const officialExample = JSON.stringify({
  session_id: "00893aaf-19fa-41d2-8238-13269b9b3ca0",
  transcript_path: "/Users/me/.claude/projects/subconscious-engine/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  cwd: "/Users/me/WorkSpace/Projects/subconscious-engine",
  permission_mode: "default",
  hook_event_name: "UserPromptSubmit",
  prompt: "把这个函数改成和上次一样的错误处理",
});

describe("parseUserPromptSubmitInput", () => {
  it("解析官方示例的全部关键字段", () => {
    const input = parseUserPromptSubmitInput(officialExample);
    expect(input).not.toBeNull();
    expect(input?.hookEventName).toBe("UserPromptSubmit");
    expect(input?.sessionId).toBe("00893aaf-19fa-41d2-8238-13269b9b3ca0");
    expect(input?.transcriptPath).toBe(
      "/Users/me/.claude/projects/subconscious-engine/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
    );
    expect(input?.cwd).toBe("/Users/me/WorkSpace/Projects/subconscious-engine");
    expect(input?.prompt).toBe("把这个函数改成和上次一样的错误处理");
  });

  it("忽略未知字段；缺失 session_id/transcript_path 时诚实置空（降级为无会话数据源）", () => {
    const input = parseUserPromptSubmitInput(
      JSON.stringify({ cwd: "/tmp/x", hook_event_name: "UserPromptSubmit", prompt: "hi", extra: 1 }),
    );
    expect(input).not.toBeNull();
    expect(input?.sessionId).toBe("");
    expect(input?.transcriptPath).toBe("");
  });

  it("非 JSON 输入 → null（fail-open，不抛出）", () => {
    expect(parseUserPromptSubmitInput("not json at all")).toBeNull();
    expect(parseUserPromptSubmitInput("")).toBeNull();
  });

  it("JSON 但非对象 → null", () => {
    expect(parseUserPromptSubmitInput("[1,2,3]")).toBeNull();
    expect(parseUserPromptSubmitInput('"UserPromptSubmit"')).toBeNull();
    expect(parseUserPromptSubmitInput("null")).toBeNull();
  });

  it("非 UserPromptSubmit 事件 → null（本适配器只挂 UserPromptSubmit 插入点）", () => {
    const other = JSON.stringify({
      session_id: "abc",
      transcript_path: "/t/abc.jsonl",
      cwd: "/tmp/x",
      hook_event_name: "PreToolUse",
      prompt: "x",
    });
    expect(parseUserPromptSubmitInput(other)).toBeNull();
  });

  it("cwd 缺失 / 空 / 非字符串 → null（cwd 只取 hook 输入，不猜测回退）", () => {
    const base = { session_id: "a", transcript_path: "/t/a.jsonl", hook_event_name: "UserPromptSubmit", prompt: "p" };
    expect(parseUserPromptSubmitInput(JSON.stringify({ ...base, cwd: "" }))).toBeNull();
    expect(parseUserPromptSubmitInput(JSON.stringify({ ...base, cwd: 42 }))).toBeNull();
    expect(parseUserPromptSubmitInput(JSON.stringify(base))).toBeNull();
  });

  it("prompt 缺失 / 非字符串 → null；空字符串 prompt 合法（交引擎判无指代）", () => {
    const base = { session_id: "a", transcript_path: "/t/a.jsonl", cwd: "/tmp", hook_event_name: "UserPromptSubmit" };
    expect(parseUserPromptSubmitInput(JSON.stringify(base))).toBeNull();
    expect(parseUserPromptSubmitInput(JSON.stringify({ ...base, prompt: 7 }))).toBeNull();
    expect(parseUserPromptSubmitInput(JSON.stringify({ ...base, prompt: "" }))).not.toBeNull();
  });
});
