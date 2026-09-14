/**
 * session-jsonl 安全与解析测试（监督要求：路径逃逸/符号链接/错误 JSONL/超限/编码）。
 * 全部使用临时目录，不接触真实 ~/.pi。
 */
import { describe, expect, it } from "vitest";
import { writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  MAX_CHANGES_PER_SESSION,
  parseSessionJsonl,
  readSessionChanges,
  resolveContainedPath,
} from "../src/session-jsonl.js";
import { cleanup, makeOutsideSymlink, makeTempDirs, writeRawSessionFile } from "./helpers.js";

function req(maxBytes = 64000): { signal: AbortSignal; maxBytes: number } {
  return { signal: new AbortController().signal, maxBytes };
}

function messageLine(body: unknown): string {
  return JSON.stringify({ type: "message", id: "e", parentId: null, timestamp: "2026-09-10T10:00:00.000Z", message: body });
}

describe("parseSessionJsonl", () => {
  it("展开 pi 0.85 edit 的 edits[] 数组形状为多条修改记录", () => {
    const text = [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-10T09:00:00.000Z", cwd: "/p" }),
      messageLine({ role: "user", content: "改一下", timestamp: 1 }),
      messageLine({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }, { oldText: "p", newText: "q" }] } }], timestamp: 2 }),
      messageLine({ role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 }),
    ].join("\n");
    const parsed = parseSessionJsonl(text);
    expect(parsed.headerId).toBe("s1");
    expect(parsed.badLines).toBe(0);
    expect(parsed.changes).toHaveLength(2);
    expect(parsed.changes[0]).toMatchObject({ tool: "edit", path: "src/a.ts", oldText: "x", newText: "y", at: "2026-09-10T10:00:00.000Z" });
    expect(parsed.changes[1]).toMatchObject({ oldText: "p", newText: "q" });
  });

  it("兼容旧扁平 oldText/newText 形状与 write content 形状", () => {
    const text = [
      messageLine({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "old.ts", oldText: "a", newText: "b" } }], timestamp: 1 }),
      messageLine({ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "write", arguments: { path: "new.ts", content: "hello" } }], timestamp: 2 }),
    ].join("\n");
    const parsed = parseSessionJsonl(text);
    expect(parsed.changes).toHaveLength(2);
    expect(parsed.changes[0]).toMatchObject({ tool: "edit", oldText: "a", newText: "b" });
    expect(parsed.changes[1]).toMatchObject({ tool: "write", content: "hello" });
  });

  it("失败 toolResult 将关联修改记录标记 isError（D9）", () => {
    const text = [
      messageLine({ role: "assistant", content: [{ type: "toolCall", id: "ok1", name: "write", arguments: { path: "good.ts", content: "keep" } }], timestamp: 1 }),
      messageLine({ role: "assistant", content: [{ type: "toolCall", id: "bad1", name: "write", arguments: { path: "bad.ts", content: "drop" } }], timestamp: 2 }),
      messageLine({ role: "toolResult", toolCallId: "ok1", toolName: "write", content: [], isError: false, timestamp: 3 }),
      messageLine({ role: "toolResult", toolCallId: "bad1", toolName: "write", content: [{ type: "text", text: "boom" }], isError: true, timestamp: 4 }),
    ].join("\n");
    const parsed = parseSessionJsonl(text);
    const good = parsed.changes.find((c) => c.path === "good.ts");
    const bad = parsed.changes.find((c) => c.path === "bad.ts");
    expect(good?.isError).toBeUndefined();
    expect(bad?.isError).toBe(true);
  });

  it("坏行跳过并计数，不丢整个会话也不抛错", () => {
    const text = [
      "{ 这不是 JSON",
      messageLine({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.ts", content: "x" } }], timestamp: 1 }),
      "also not json }}}",
      JSON.stringify("bare string"),
    ].join("\n");
    const parsed = parseSessionJsonl(text);
    expect(parsed.badLines).toBe(3);
    expect(parsed.changes).toHaveLength(1);
  });

  it("忽略非 edit/write 工具与 text/thinking 内容块", () => {
    const text = [
      messageLine({ role: "assistant", content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } }, { type: "toolCall", id: "b2", name: "read", arguments: { path: "x" } }], timestamp: 1 }),
    ].join("\n");
    expect(parseSessionJsonl(text).changes).toHaveLength(0);
  });

  it("单文件修改记录条数存在第二道上限", () => {
    expect(MAX_CHANGES_PER_SESSION).toBeGreaterThan(0);
    const lines: string[] = [];
    for (let i = 0; i < MAX_CHANGES_PER_SESSION + 5; i += 1) {
      lines.push(messageLine({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "write", arguments: { path: `f${i}.ts`, content: "x" } }], timestamp: i }));
    }
    const parsed = parseSessionJsonl(lines.join("\n"));
    expect(parsed.changes).toHaveLength(MAX_CHANGES_PER_SESSION);
  });
});

describe("resolveContainedPath（路径逃逸防线）", () => {
  it("sessionDir 内的常规文件通过", async () => {
    const dirs = await makeTempDirs();
    try {
      const file = await writeRawSessionFile(dirs.sessionDir, "a.jsonl", ["{}"]);
      // 生产返回 realpath；macOS /var 与 /private/var 别名，期望同样取 realpath
      await expect(resolveContainedPath(file, dirs.sessionDir)).resolves.toBe(await realpath(file));
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("绝对路径指向 sessionDir 外 → 拒绝", async () => {
    const dirs = await makeTempDirs();
    try {
      const outside = path.join(dirs.root, "outside.jsonl");
      await writeFile(outside, "{}", "utf8");
      await expect(resolveContainedPath(outside, dirs.sessionDir)).resolves.toBeNull();
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("相对路径 .. 逃逸 → 拒绝", async () => {
    const dirs = await makeTempDirs();
    try {
      const escaping = path.join(dirs.sessionDir, "..", "outside.jsonl");
      await writeFile(path.join(dirs.root, "outside.jsonl"), "{}", "utf8");
      await expect(resolveContainedPath(escaping, dirs.sessionDir)).resolves.toBeNull();
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("sessionDir 内符号链接指向目录外 → 拒绝（realpath 解析）", async () => {
    const dirs = await makeTempDirs();
    try {
      const link = await makeOutsideSymlink(dirs, "escape.jsonl");
      await expect(resolveContainedPath(link, dirs.sessionDir)).resolves.toBeNull();
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("sessionDir 内符号链接指向目录内文件 → 允许", async () => {
    const dirs = await makeTempDirs();
    try {
      const { symlink } = await import("node:fs/promises");
      const target = await writeRawSessionFile(dirs.sessionDir, "real.jsonl", ["{}"]);
      const link = path.join(dirs.sessionDir, "link.jsonl");
      await symlink(target, link);
      await expect(resolveContainedPath(link, dirs.sessionDir)).resolves.toBe(await realpath(target));
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("不存在的路径 → 拒绝；指向 sessionDir 本身 → 拒绝", async () => {
    const dirs = await makeTempDirs();
    try {
      await expect(resolveContainedPath(path.join(dirs.sessionDir, "nope.jsonl"), dirs.sessionDir)).resolves.toBeNull();
      await expect(resolveContainedPath(dirs.sessionDir, dirs.sessionDir)).resolves.toBeNull();
      await expect(resolveContainedPath("", dirs.sessionDir)).resolves.toBeNull();
    } finally {
      await cleanup(dirs.root);
    }
  });
});

describe("readSessionChanges（有界读取与归属校验）", () => {
  it("无 path 的 SessionRef → null（不凭 id 拼路径，D12.7）", async () => {
    const dirs = await makeTempDirs();
    try {
      await expect(readSessionChanges({ id: "s1" }, dirs.sessionDir, req())).resolves.toBeNull();
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("会话头 id 与 SessionRef.id 不一致 → null（防张冠李戴）", async () => {
    const dirs = await makeTempDirs();
    try {
      const file = await writeRawSessionFile(dirs.sessionDir, "mismatch.jsonl", [
        JSON.stringify({ type: "session", version: 3, id: "actual-id", timestamp: "2026-09-10T09:00:00.000Z", cwd: "/p" }),
        messageLine({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.ts", content: "x" } }], timestamp: 1 }),
      ]);
      await expect(readSessionChanges({ id: "claimed-id", path: file }, dirs.sessionDir, req())).resolves.toBeNull();
      await expect(readSessionChanges({ id: "actual-id", path: file }, dirs.sessionDir, req())).resolves.toMatchObject({ sessionId: "actual-id" });
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("超过 maxBytes → null（诚实不可用，不截断注入）", async () => {
    const dirs = await makeTempDirs();
    try {
      const file = await writeRawSessionFile(dirs.sessionDir, "big.jsonl", [
        JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-10T09:00:00.000Z", cwd: "/p" }),
        messageLine({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.ts", content: "x".repeat(500) } }], timestamp: 1 }),
      ]);
      await expect(readSessionChanges({ id: "s1", path: file }, dirs.sessionDir, req(64))).resolves.toBeNull();
      await expect(readSessionChanges({ id: "s1", path: file }, dirs.sessionDir, req(64000))).resolves.toBeTruthy();
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("非法 UTF-8 字节 → null", async () => {
    const dirs = await makeTempDirs();
    try {
      const file = path.join(dirs.sessionDir, "bad-encoding.jsonl");
      const payload = Buffer.concat([
        Buffer.from('{"type":"session","id":"s1","timestamp":"2026-09-10T09:00:00.000Z","cwd":"/p"}\n', "utf8"),
        Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a]), // 非法 UTF-8 序列 + NUL
      ]);
      await writeFile(file, payload);
      await expect(readSessionChanges({ id: "s1", path: file }, dirs.sessionDir, req())).resolves.toBeNull();
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("信号已中止 → null（不发起读取）", async () => {
    const dirs = await makeTempDirs();
    try {
      const controller = new AbortController();
      controller.abort();
      const file = await writeRawSessionFile(dirs.sessionDir, "a.jsonl", ["{}"]);
      await expect(
        readSessionChanges({ id: "s1", path: file }, dirs.sessionDir, { signal: controller.signal, maxBytes: 1000 }),
      ).resolves.toBeNull();
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("空文件/无修改记录 → sessionId 正确、changes 为空（core 侧诚实 not-found）", async () => {
    const dirs = await makeTempDirs();
    try {
      await mkdir(path.join(dirs.sessionDir, "sub"), { recursive: true });
      const file = await writeRawSessionFile(dirs.sessionDir, "empty.jsonl", [
        JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-10T09:00:00.000Z", cwd: "/p" }),
      ]);
      await expect(readSessionChanges({ id: "s1", path: file }, dirs.sessionDir, req())).resolves.toEqual({ sessionId: "s1", changes: [] });
    } finally {
      await cleanup(dirs.root);
    }
  });
});
