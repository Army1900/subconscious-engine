/**
 * HostEnv provider 测试。证据类型：**真实 SessionManager fixture**——
 * 会话由真实 SessionManager.create/appendMessage 写入临时目录，列表走真实
 * SessionManager.list；exec/ui 为 mock。全程不接触真实 ~/.pi。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { createPiHostEnv } from "../src/host-env.js";
import { fakeExec, makeFakeCtx, makeTempDirs, cleanup, writeFixtureSession } from "./helpers.js";

function req(maxBytes = 64000): { signal: AbortSignal; maxBytes: number } {
  return { signal: new AbortController().signal, maxBytes };
}

describe("listRecentSessions（真实 SessionManager.list 路径）", () => {
  it("返回真实会话的稳定 id（会话头 UUID）与真实文件路径", async () => {
    const dirs = await makeTempDirs();
    try {
      const fixture = await writeFixtureSession({
        projectDir: dirs.projectDir,
        sessionDir: dirs.sessionDir,
        firstMessage: "给 retryWrapper 加错误处理",
        changes: [{ tool: "edit", path: "src/retry.ts", oldText: "try {}", newText: "try {} catch {}" }],
      });
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx); // 不注入 listSessions → 真实 SessionManager.list
      const summaries = await env.listRecentSessions?.(req()) ?? null;
      expect(summaries).not.toBeNull();
      expect(summaries).toHaveLength(1);
      const summary = summaries?.[0];
      expect(summary?.id).toBe(fixture.id);
      expect(summary?.path).toBe(fixture.file);
      expect(summary?.title).toContain("retryWrapper");
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("按 cwd 过滤：其他项目的会话不出现（真实 list 语义）", async () => {
    const dirs = await makeTempDirs();
    try {
      await writeFixtureSession({
        projectDir: dirs.projectDir,
        sessionDir: dirs.sessionDir,
        firstMessage: "本项目会话",
        changes: [{ tool: "write", path: "a.ts", content: "x" }],
      });
      const otherProject = path.join(dirs.root, "other-project");
      await writeFixtureSession({
        projectDir: otherProject,
        sessionDir: dirs.sessionDir,
        firstMessage: "别的项目会话",
        changes: [{ tool: "write", path: "b.ts", content: "y" }],
      });
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx);
      const summaries = await env.listRecentSessions?.(req()) ?? null;
      expect(summaries).toHaveLength(1);
      expect(summaries?.[0]?.title).toContain("本项目会话");
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("重复名称的两个会话：id 仍各自稳定（标签去重由 core uniquifyLabels 处理）", async () => {
    const dirs = await makeTempDirs();
    try {
      const first = await writeFixtureSession({
        projectDir: dirs.projectDir,
        sessionDir: dirs.sessionDir,
        firstMessage: "第一段对话",
        name: "重构错误处理",
        changes: [{ tool: "edit", path: "src/one.ts", oldText: "a", newText: "b" }],
      });
      const second = await writeFixtureSession({
        projectDir: dirs.projectDir,
        sessionDir: dirs.sessionDir,
        firstMessage: "第二段对话",
        name: "重构错误处理",
        changes: [{ tool: "edit", path: "src/two.ts", oldText: "c", newText: "d" }],
      });
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx);
      const summaries = await env.listRecentSessions?.(req()) ?? null;
      expect(summaries).toHaveLength(2);
      const ids = new Set(summaries?.map((s) => s.id));
      expect(ids.has(first.id)).toBe(true);
      expect(ids.has(second.id)).toBe(true);
      expect(ids.size).toBe(2); // 重复标签不掩盖稳定 id
      expect(summaries?.every((s) => s.title === "重构错误处理")).toBe(true);
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("无稳定 id 或无真实 path 的候选被剔除；provider 侧有条数护栏", async () => {
    const dirs = await makeTempDirs();
    try {
      const valid: SessionInfo[] = [];
      for (let i = 0; i < 60; i += 1) {
        valid.push({
          path: `${dirs.sessionDir}/f${i}.jsonl`,
          id: `s-${i}`,
          cwd: dirs.projectDir,
          created: new Date(2026, 8, 1, 0, i),
          modified: new Date(2026, 8, 2, 0, i),
          messageCount: 1,
          firstMessage: `会话 ${i}`,
          allMessagesText: "",
        });
      }
      const broken: unknown = { path: "", id: "no-path", cwd: dirs.projectDir, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" };
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx, {
        listSessions: async () => [...valid, broken as SessionInfo],
      });
      const summaries = await env.listRecentSessions?.(req()) ?? null;
      expect(summaries).toHaveLength(50); // MAX_SESSION_ENTRIES 护栏，无 path 候选已被剔除
      expect(summaries?.[0]?.id).toBe("s-59"); // 降序：最新在前
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("信号中止 → null，底层不继续占位", async () => {
    const dirs = await makeTempDirs();
    try {
      const controller = new AbortController();
      controller.abort();
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx, {
        listSessions: async () => {
          throw new Error("should not be called");
        },
      });
      await expect(env.listRecentSessions?.({ signal: controller.signal, maxBytes: 1000 })).resolves.toBeNull();
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("listSessions 抛错 → null（不外泄 rejection）", async () => {
    const dirs = await makeTempDirs();
    try {
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx, {
        listSessions: async () => {
          throw new Error("disk exploded");
        },
      });
      await expect(env.listRecentSessions?.(req())).resolves.toBeNull();
    } finally {
      await cleanup(dirs.root);
    }
  });
});

describe("readSessionContent（真实 fixture 内容解析）", () => {
  it("edit/write/失败记录全部正确映射；与 SessionManager.open 的真实条目一致", async () => {
    const dirs = await makeTempDirs();
    try {
      const fixture = await writeFixtureSession({
        projectDir: dirs.projectDir,
        sessionDir: dirs.sessionDir,
        firstMessage: "上次修改",
        changes: [
          { tool: "edit", path: "src/api.ts", oldText: "try {}", newText: "try {} catch {}" },
          { tool: "write", path: "src/retry.ts", content: "export const retry = () => {};" },
          { tool: "edit", path: "src/broken.ts", oldText: "a", newText: "b", failed: true },
        ],
      });
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx);
      const record = await env.readSessionContent?.({ id: fixture.id, path: fixture.file }, req());
      expect(record).not.toBeNull();
      expect(record?.sessionId).toBe(fixture.id);
      const paths = record?.changes.map((c) => c.path);
      expect(paths).toEqual(["src/api.ts", "src/retry.ts", "src/broken.ts"]);
      expect(record?.changes.find((c) => c.path === "src/broken.ts")?.isError).toBe(true);
      expect(record?.changes.find((c) => c.path === "src/api.ts")?.isError).toBeUndefined();

      // 交叉验证（类型证明的等价接口）：真实 SessionManager.open 读取同一文件，
      // 其条目中的 edit/write toolCall 与我们的解析一一对应。
      const reopened = SessionManager.open(fixture.file, dirs.sessionDir);
      const toolCalls = reopened
        .getEntries()
        .flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content) ? entry.message.content : []))
        .filter((block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall")
        .map((block) => block.name);
      expect(toolCalls).toEqual(["edit", "write", "edit"]);
      expect(record?.changes).toHaveLength(toolCalls.length);
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("逃逸路径（符号链接指向 sessionDir 外）→ null，secret 内容不可达", async () => {
    const dirs = await makeTempDirs();
    try {
      const { makeOutsideSymlink } = await import("./helpers.js");
      const link = await makeOutsideSymlink(dirs, "escape.jsonl");
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx);
      await expect(env.readSessionContent?.({ id: "evil", path: link }, req())).resolves.toBeNull();
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("真实宿主 sessionManager 实例（SessionManager.create）也可用作 ctx", async () => {
    const dirs = await makeTempDirs();
    try {
      const real = SessionManager.create(dirs.projectDir, dirs.sessionDir);
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir, sessionManager: real });
      const env = createPiHostEnv(ctx);
      expect(env.cwd).toBe(dirs.projectDir);
      const summaries = await env.listRecentSessions?.(req()) ?? null;
      expect(summaries).toEqual([]); // 空临时目录，真实 list 返回空数组 → 空列表（非 null）
    } finally {
      await cleanup(dirs.root);
    }
  });
});

describe("readCwdContext（git status + 目录摘要，均有界）", () => {
  it("git status 成功 + 目录非空 → 两块都注入且受字符上限约束", async () => {
    const dirs = await makeTempDirs();
    try {
      const { writeFile, mkdir: mk } = await import("node:fs/promises");
      await mk(path.join(dirs.projectDir, "src"), { recursive: true });
      await writeFile(path.join(dirs.projectDir, "package.json"), "{}", "utf8");
      const exec = fakeExec([{ stdout: " M src/a.ts\n?? b.ts\n", stderr: "", code: 0, killed: false }]);
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx, { exec: exec.exec });
      const snap = await env.readCwdContext?.(req()) ?? null;
      expect(snap).not.toBeNull();
      expect(snap?.cwd).toBe(dirs.projectDir);
      expect(snap?.gitStatus).toContain("M src/a.ts");
      expect(snap?.dirSummary).toContain("src/");
      expect(snap?.dirSummary).toContain("package.json");
      expect(exec.calls).toHaveLength(1);
      expect(exec.calls[0]?.command).toBe("git");
      expect(exec.calls[0]?.options?.cwd).toBe(dirs.projectDir);
      expect(exec.calls[0]?.options?.timeout).toBeGreaterThan(0);
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("git 不可用（code≠0）→ 只有目录摘要；exec 抛错同理", async () => {
    const dirs = await makeTempDirs();
    try {
      // 空目录的 readdir 摘要为 undefined；先放一个普通文件，才能验证「git 失败但目录摘要仍可用」
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path.join(dirs.projectDir, "README.md"), "# temp project\n", "utf8");
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const failing = fakeExec([new Error("no git")]);
      const env = createPiHostEnv(ctx, { exec: failing.exec });
      const snap = await env.readCwdContext?.(req()) ?? null;
      expect(snap?.gitStatus).toBeUndefined();
      expect(snap?.dirSummary).not.toBeUndefined(); // 目录摘要仍可用
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("未提供 exec → git 块缺省，不抛错", async () => {
    const dirs = await makeTempDirs();
    try {
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx);
      const snap = await env.readCwdContext?.(req()) ?? null;
      expect(snap?.gitStatus).toBeUndefined();
    } finally {
      await cleanup(dirs.root);
    }
  });

  it("目录摘要条目数有上限（超出部分计数标注）", async () => {
    const dirs = await makeTempDirs();
    try {
      const { writeFile } = await import("node:fs/promises");
      for (let i = 0; i < 40; i += 1) {
        await writeFile(path.join(dirs.projectDir, `f${String(i).padStart(2, "0")}.ts`), "x", "utf8");
      }
      const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir });
      const env = createPiHostEnv(ctx);
      const snap = await env.readCwdContext?.(req()) ?? null;
      expect(snap?.dirSummary).toContain("另有 10 项");
      expect(snap?.dirSummary?.length).toBeLessThanOrEqual(64000);
    } finally {
      await cleanup(dirs.root);
    }
  });
});
