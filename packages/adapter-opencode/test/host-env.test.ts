import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadRequest, SessionRef } from "@subconscious/core";
import type { GitExec, GitExecResult, SessionClient } from "../src/host-env.js";
import { MAX_SESSION_ENTRIES, SESSION_TITLE_MAX_CHARS, createOpenCodeHostEnv } from "../src/host-env.js";

/** 官方 Session/diff 响应的可控假实现（离线；带调用计数） */
function fakeSessionClient(responses: {
  list?: unknown;
  get?: unknown;
  diff?: unknown;
  listError?: Error;
  getError?: Error;
  diffError?: Error;
}): SessionClient & { calls: { list: number; get: number; diff: number } } {
  const calls = { list: 0, get: 0, diff: 0 };
  return {
    calls,
    async list() {
      calls.list += 1;
      if (responses.listError !== undefined) throw responses.listError;
      return { data: responses.list };
    },
    async get() {
      calls.get += 1;
      if (responses.getError !== undefined) throw responses.getError;
      return { data: responses.get };
    },
    async diff() {
      calls.diff += 1;
      if (responses.diffError !== undefined) throw responses.diffError;
      return { data: responses.diff };
    },
  };
}

const REQ: ReadRequest = { signal: new AbortController().signal, maxBytes: 64000 };

function sessionEntry(id: string, title: string, updated: number): unknown {
  return { id, directory: "/repo", title, time: { created: updated - 1000, updated } };
}

const dirs: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-env-"));
  dirs.push(dir);
  await writeFile(path.join(dir, "a.ts"), "export {};\n");
  await writeFile(path.join(dir, "b.md"), "# b\n");
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => readdir(dir).then(() => dir).catch(() => null)));
  dirs.length = 0;
});

const execOk: GitExec = async (): Promise<GitExecResult> => ({ code: 0, stdout: "M a.ts\n" });

describe("createOpenCodeHostEnv（快照形状）", () => {
  it("cwd 取 directory；activeEditor/readClipboardText 结构性缺失（无官方 API）", () => {
    const env = createOpenCodeHostEnv({ cwd: "/repo" }, {});
    expect(env.cwd).toBe("/repo");
    expect(env.activeEditor).toBeUndefined();
    expect(env.readClipboardText).toBeUndefined();
    expect(typeof env.listRecentSessions).toBe("function");
    expect(typeof env.readSessionContent).toBe("function");
    expect(typeof env.readCwdContext).toBe("function");
  });
});

describe("listRecentSessions（session.list 官方 API）", () => {
  it("Session[] → SessionSummary[]（id/标题/at=ISO(time.updated)）", async () => {
    const client = fakeSessionClient({
      list: [sessionEntry("ses_a", "会话 A", Date.parse("2026-09-13T10:00:00Z"))],
    });
    const env = createOpenCodeHostEnv({ cwd: "/repo" }, { session: client });
    const sessions = await env.listRecentSessions?.(REQ);
    expect(sessions).toEqual([
      { id: "ses_a", title: "会话 A", at: "2026-09-13T10:00:00.000Z" },
    ]);
    expect(client.calls.list).toBe(1);
  });

  it("排除当前会话；跳过缺 id/标题的非法项；标题截断", async () => {
    const longTitle = "标".repeat(SESSION_TITLE_MAX_CHARS + 10);
    const client = fakeSessionClient({
      list: [
        sessionEntry("ses_current", "当前", 1000),
        sessionEntry("ses_b", longTitle, 2000),
        { directory: "/repo", time: { updated: 3000 } }, // 无 id
        { id: "ses_c", time: { updated: 3000 } }, // 无 title
        "not-an-object",
      ],
    });
    const env = createOpenCodeHostEnv({ cwd: "/repo", currentSessionId: "ses_current" }, { session: client });
    const sessions = await env.listRecentSessions?.(REQ);
    expect(sessions).toHaveLength(1);
    expect(sessions?.[0]?.id).toBe("ses_b");
    expect(sessions?.[0]?.title.length).toBe(SESSION_TITLE_MAX_CHARS);
  });

  it(`条数上限 ${MAX_SESSION_ENTRIES}（防御性护栏）`, async () => {
    const many = Array.from({ length: MAX_SESSION_ENTRIES + 10 }, (_, i) =>
      sessionEntry(`ses_${i}`, `会话 ${i}`, 1000 + i),
    );
    const client = fakeSessionClient({ list: many });
    const env = createOpenCodeHostEnv({ cwd: "/repo" }, { session: client });
    const sessions = await env.listRecentSessions?.(REQ);
    expect(sessions).toHaveLength(MAX_SESSION_ENTRIES);
  });

  it("中止信号 → null 且不发起调用；客户端抛错/响应非数组/客户端缺失 → null", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const client = fakeSessionClient({ list: [] });
    const env = createOpenCodeHostEnv({ cwd: "/repo" }, { session: client });
    expect(await env.listRecentSessions?.({ ...REQ, signal: aborted.signal })).toBeNull();
    expect(client.calls.list).toBe(0);

    const failing = createOpenCodeHostEnv({ cwd: "/repo" }, { session: fakeSessionClient({ listError: new Error("server down") }) });
    expect(await failing.listRecentSessions?.(REQ)).toBeNull();

    const malformed = createOpenCodeHostEnv({ cwd: "/repo" }, { session: fakeSessionClient({ list: { nope: true } }) });
    expect(await malformed.listRecentSessions?.(REQ)).toBeNull();

    const noClient = createOpenCodeHostEnv({ cwd: "/repo" }, {});
    expect(await noClient.listRecentSessions?.(REQ)).toBeNull();
  });
});

describe("readSessionContent（session.get + session.diff 官方 API）", () => {
  const bound: SessionRef = { id: "ses_prev", title: "上一次会话" };

  function fakeGet(updated: number): unknown {
    return { id: "ses_prev", directory: "/repo", title: "上一次会话", time: { created: updated - 1, updated } };
  }

  it("FileDiff[] → SessionChange[]（edit；before/after；at=ISO(time.updated)），sessionId 绑定", async () => {
    const at = Date.parse("2026-09-13T12:00:00Z");
    const client = fakeSessionClient({
      get: fakeGet(at),
      diff: [{ file: "src/a.ts", before: "old", after: "new", additions: 1, deletions: 1 }],
    });
    const env = createOpenCodeHostEnv({ cwd: "/repo" }, { session: client });
    const record = await env.readSessionContent?.(bound, REQ);
    expect(record).toEqual({
      sessionId: "ses_prev",
      changes: [{ at: "2026-09-13T12:00:00.000Z", tool: "edit", path: "src/a.ts", oldText: "old", newText: "new" }],
    });
  });

  it("跳过 file 非法/为空的 diff；超长 before/after 按 maxBytes 截断", async () => {
    const client = fakeSessionClient({
      get: fakeGet(1000),
      diff: [
        { file: "", before: "x", after: "y", additions: 0, deletions: 0 },
        { file: 42, before: "x", after: "y" },
        { file: "big.ts", before: "x".repeat(500), after: "y".repeat(500), additions: 1, deletions: 1 },
      ],
    });
    const env = createOpenCodeHostEnv({ cwd: "/repo" }, { session: client });
    const record = await env.readSessionContent?.(bound, { ...REQ, maxBytes: 100 });
    expect(record?.changes).toHaveLength(1);
    expect(record?.changes[0]?.path).toBe("big.ts");
    expect(record?.changes[0]?.oldText?.length).toBeLessThanOrEqual(100);
    expect(record?.changes[0]?.newText?.length).toBeLessThanOrEqual(100);
  });

  it("中止 → null（不调用）；get 抛错 → null（diff 不再调用）；diff 抛错/非数组 → null；客户端缺失 → null", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const client = fakeSessionClient({ get: fakeGet(1), diff: [] });
    const env = createOpenCodeHostEnv({ cwd: "/repo" }, { session: client });
    expect(await env.readSessionContent?.(bound, { ...REQ, signal: aborted.signal })).toBeNull();
    expect(client.calls.get).toBe(0);

    const getFail = fakeSessionClient({ getError: new Error("boom") });
    const envGetFail = createOpenCodeHostEnv({ cwd: "/repo" }, { session: getFail });
    expect(await envGetFail.readSessionContent?.(bound, REQ)).toBeNull();
    expect(getFail.calls.diff).toBe(0);

    const diffFail = createOpenCodeHostEnv(
      { cwd: "/repo" },
      { session: fakeSessionClient({ get: fakeGet(1), diffError: new Error("boom") }) },
    );
    expect(await diffFail.readSessionContent?.(bound, REQ)).toBeNull();

    const malformed = createOpenCodeHostEnv(
      { cwd: "/repo" },
      { session: fakeSessionClient({ get: fakeGet(1), diff: "nope" }) },
    );
    expect(await malformed.readSessionContent?.(bound, REQ)).toBeNull();

    const noClient = createOpenCodeHostEnv({ cwd: "/repo" }, {});
    expect(await noClient.readSessionContent?.(bound, REQ)).toBeNull();
  });

  it("get 响应缺 time.updated → changes 的 at 为空串（core 按无效时间排后，诚实不猜）", async () => {
    const client = fakeSessionClient({
      get: { id: "ses_prev", directory: "/repo", title: "t" },
      diff: [{ file: "a.ts", before: "o", after: "n", additions: 1, deletions: 1 }],
    });
    const env = createOpenCodeHostEnv({ cwd: "/repo" }, { session: client });
    const record = await env.readSessionContent?.(bound, REQ);
    expect(record?.changes[0]?.at).toBe("");
  });
});

describe("readCwdContext（本地有界读取，同 adapter-claude 纪律）", () => {
  it("真实临时目录 → dirSummary 含文件名；git exec 成功 → gitStatus", async () => {
    const dir = await tempProject();
    const env = createOpenCodeHostEnv({ cwd: dir }, { exec: execOk });
    const snapshot = await env.readCwdContext?.(REQ);
    expect(snapshot?.cwd).toBe(dir);
    expect(snapshot?.gitStatus).toBe("M a.ts");
    expect(snapshot?.dirSummary).toContain("a.ts");
    expect(snapshot?.dirSummary).toContain("b.md");
  });

  it("exec 抛错/非零退出 → gitStatus 缺失但快照仍返回；目录摘要有序且带目录斜杠", async () => {
    const dir = await tempProject();
    await import("node:fs/promises").then((fs) => fs.mkdir(path.join(dir, "sub")));
    const failing: GitExec = async () => {
      throw new Error("git not found");
    };
    const env = createOpenCodeHostEnv({ cwd: dir }, { exec: failing });
    const snapshot = await env.readCwdContext?.(REQ);
    expect(snapshot?.gitStatus).toBeUndefined();
    expect(snapshot?.dirSummary).toContain("sub/");
  });

  it("中止 → null", async () => {
    const dir = await tempProject();
    const aborted = new AbortController();
    aborted.abort();
    const env = createOpenCodeHostEnv({ cwd: dir }, { exec: execOk });
    expect(await env.readCwdContext?.({ ...REQ, signal: aborted.signal })).toBeNull();
  });
});
