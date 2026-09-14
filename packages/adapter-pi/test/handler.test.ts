/**
 * before_agent_start handler 端到端测试（走真实 adapter 组装/handler 代码路径）：
 * - no-op：无指代 → undefined，零 provider/零交互；
 * - 注入：customType/display/content 形状；details 携带透明性数据；原话不改写；
 * - 异常透传：引擎工厂抛错 → undefined，prompt 不受影响（fail-open）；
 * - 超时：默认 3s 机器预算内有界返回；小预算变体快速返回；
 * - M2 定界锁：attachments 出现时丢弃并记 warn；自带 images 不被消费。
 * 证据类型：真实 handler + 真实 SessionManager fixture（临时目录），exec/ui 为 mock。
 */
import { describe, expect, it } from "vitest";
import { createEngine, DEFAULT_ENGINE_LIMITS } from "@subconscious/core";
import type { EngineOptions, EnrichOutput, Logger } from "@subconscious/core";
import { createBeforeAgentStartHandler, toEventResult } from "../src/handler.js";
import type { AdapterDeps, HandlerOptions } from "../src/handler.js";
import type { ListSessionsFn, PiHandlerContext, PiBeforeAgentStartEvent } from "../src/index.js";
import { cleanup, fakeExec, FakeUi, makeEvent, makeFakeCtx, makeTempDirs, writeFixtureSession } from "./helpers.js";
import type { FakeExec, TempDirs } from "./helpers.js";

interface Setup {
  dirs: TempDirs;
  ui: FakeUi;
  exec: FakeExec;
  listCalls: number;
  engineOptions: EngineOptions[];
  handler: (event?: PiBeforeAgentStartEvent) => ReturnType<ReturnType<typeof createBeforeAgentStartHandler>>;
  ctx: PiHandlerContext;
  rerun: (options: HandlerOptions) => void;
}

/**
 * 组装接近真实扩展的 harness：真实 core 引擎 + 真实 SessionManager.list（对临时目录），
 * exec/ui 为 mock；engineOptions 记录传给 createEngine 的配置。
 */
async function setup(extra: { handler?: HandlerOptions; listSessions?: ListSessionsFn } = {}): Promise<Setup> {
  const dirs = await makeTempDirs();
  const ui = new FakeUi();
  const exec = fakeExec([{ stdout: " M src/api.ts\n", stderr: "", code: 0, killed: false }]);
  const engineOptions: EngineOptions[] = [];
  let listCalls = 0;
  const listSessions: ListSessionsFn =
    extra.listSessions ??
    (async (cwd, sessionDir) => {
      listCalls += 1;
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      return SessionManager.list(cwd, sessionDir);
    });
  const deps: AdapterDeps = {
    exec: exec.exec,
    listSessions,
    createEngineFn: (options: EngineOptions) => {
      engineOptions.push(options);
      return createEngine(options);
    },
  };
  const ctx = makeFakeCtx({ cwd: dirs.projectDir, sessionDir: dirs.sessionDir, ui });
  let options: HandlerOptions = { ...extra.handler, deps };
  return {
    dirs,
    ui,
    exec,
    get listCalls() {
      return listCalls;
    },
    engineOptions,
    ctx,
    handler: (event?: PiBeforeAgentStartEvent) => createBeforeAgentStartHandler(options)(event ?? makeEvent(""), ctx),
    rerun: (next: HandlerOptions) => {
      options = { ...next, deps };
    },
  };
}

async function writeHistoryFixture(dirs: TempDirs): Promise<{ id: string; file: string }> {
  return writeFixtureSession({
    projectDir: dirs.projectDir,
    sessionDir: dirs.sessionDir,
    firstMessage: "给 retryWrapper 加错误处理",
    changes: [
      { tool: "edit", path: "src/retry.ts", oldText: "try {}", newText: "try {} catch (e) { log(e); }" },
      { tool: "write", path: "src/logger.ts", content: "export const log = console.error;" },
      { tool: "edit", path: "src/broken.ts", oldText: "a", newText: "b", failed: true },
    ],
  });
}

const SCENARIO_PROMPT = "参考上次的修改，把这个文件改成一样的错误处理";

describe("handler：no-op 路径（零 provider/零交互）", () => {
  it("无指代话语 → undefined；listSessions/exec/ui 全零调用", async () => {
    const s = await setup();
    try {
      const result = await s.handler(makeEvent("写一个快速排序并附上复杂度说明"));
      expect(result).toBeUndefined();
      expect(s.listCalls).toBe(0);
      expect(s.exec.calls).toHaveLength(0);
      expect(s.ui.calls).toHaveLength(0);
    } finally {
      await cleanup(s.dirs.root);
    }
  });

  it("有指代但全未解析（空会话目录、无编辑器）→ 仍 undefined", async () => {
    const s = await setup();
    try {
      const result = await s.handler(makeEvent(SCENARIO_PROMPT));
      expect(result).toBeUndefined(); // 全部 not-found → 无 context → 透传
    } finally {
      await cleanup(s.dirs.root);
    }
  });
});

describe("handler：注入路径（真实 fixture，无 activeEditor）", () => {
  it("历史指代解析进 custom message：display=true、来源标注、原话不改写、文件指代诚实 dropped", async () => {
    const s = await setup();
    try {
      const fixture = await writeHistoryFixture(s.dirs);
      const result = await s.handler(makeEvent(SCENARIO_PROMPT));
      expect(result).toBeDefined();
      const message = result?.message;
      expect(message?.customType).toBe("subconscious");
      expect(message?.display).toBe(true);
      expect(typeof message?.content).toBe("string");
      const content = message?.content ?? "";
      expect(content).toContain("[潜意识引擎·已解析]");
      expect(content).toContain("来源：recent-sessions");
      expect(content).toContain("来源：session-content");
      expect(content).toContain("try {} catch (e) { log(e); }"); // 绑定会话的修改记录
      expect(content).not.toContain("src/broken.ts"); // 失败记录不注入正文
      expect(content).not.toContain(SCENARIO_PROMPT.replace("参考上次的修改，", "")); // 不改写/不复述用户原话
      // pi 落盘行为：自定义消息追加在用户消息之后，用户 prompt 原样（此处验证 handler 未替换 prompt）
      expect(result && "systemPrompt" in result ? result.systemPrompt : undefined).toBeUndefined();
      expect(fixture.id).not.toBe("");
      expect(s.ui.calls).toHaveLength(0); // 单会话 → 无需消歧 → 零交互
    } finally {
      await cleanup(s.dirs.root);
    }
  });

  it("宿主编辑器夹具（activeEditor）→ 文件+历史零反问上下文", async () => {
    const s = await setup({ handler: { activeEditor: { path: "/w/fixtures/src/api.ts", line: 42 } } });
    try {
      await writeHistoryFixture(s.dirs);
      const result = await s.handler(makeEvent(SCENARIO_PROMPT));
      const content = result?.message?.content ?? "";
      expect(content).toContain("[潜意识引擎·已解析]");
      expect(content).toContain("/w/fixtures/src/api.ts"); // 文件指代已解析
      expect(content).toContain("来源：active-editor");
      expect(content).toContain("来源：session-content"); // 历史内容同样在
      expect(result?.message?.display).toBe(true);
      expect(s.ui.calls).toHaveLength(0); // 零反问
    } finally {
      await cleanup(s.dirs.root);
    }
  });

  it("多会话 → 候选选择器（ui.select），选中后读取该会话内容", async () => {
    const s = await setup();
    try {
      await writeFixtureSession({
        projectDir: s.dirs.projectDir,
        sessionDir: s.dirs.sessionDir,
        firstMessage: "第一次：处理登录",
        changes: [{ tool: "edit", path: "src/login.ts", oldText: "l", newText: "l2" }],
      });
      const second = await writeFixtureSession({
        projectDir: s.dirs.projectDir,
        sessionDir: s.dirs.sessionDir,
        firstMessage: "第二次：处理重试",
        changes: [{ tool: "edit", path: "src/retry.ts", oldText: "r", newText: "r2" }],
      });
      // 提示须同时命中 history-event（"上次"）与 history-content（"一样的错误处理"），
      // 否则不读会话 diff，多会话选择器与内容注入就验证不到。
      const prompt = "按上次的方式改成一样的错误处理";
      s.ui.selectResult = undefined; // 先取消：不注入候选结论
      const cancelled = await s.handler(makeEvent(prompt));
      expect(cancelled).toBeUndefined(); // 绑定未建立 → history-content 不注入（D4）
      // 选择器标签由 core 生成（标题+时间后缀）；从真实记录的选择调用里取第二个会话的
      // 完整标签作为用户选择，保证 picked 与候选 label 一一对应。
      const selectCall = s.ui.calls.find((call) => call.method === "select");
      const labels = (selectCall?.messageOrOptions ?? "").split("|");
      expect(labels.some((label) => label.includes("第一次：处理登录"))).toBe(true); // 两会话均入候选
      const secondLabel = labels.find((label) => label.includes("第二次：处理重试"));
      expect(secondLabel).toBeDefined(); // 真实 list 降序：最新在前=第二次
      s.ui.selectResult = secondLabel;
      const chosen = await s.handler(makeEvent(prompt));
      const content = chosen?.message?.content ?? "";
      expect(content).toContain("src/retry.ts");
      expect(content).not.toContain("src/login.ts");
      expect(second.file).not.toBe("");
    } finally {
      await cleanup(s.dirs.root);
    }
  });
});

describe("handler：fail-open 与超时", () => {
  it("引擎工厂抛错 → undefined（异常原样透传，prompt 不受影响）", async () => {
    const s = await setup();
    try {
      s.rerun({
        deps: {
          exec: s.exec.exec,
          createEngineFn: () => {
            throw new Error("engine construction exploded");
          },
        },
      });
      const result = await s.handler(makeEvent(SCENARIO_PROMPT));
      expect(result).toBeUndefined();
    } finally {
      await cleanup(s.dirs.root);
    }
  });

  it("provider 抛错被 core 吞掉 → 仍 undefined，不外泄", async () => {
    const s = await setup({
      listSessions: () => Promise.reject(new Error("session dir exploded")),
    });
    try {
      const result = await s.handler(makeEvent(SCENARIO_PROMPT));
      expect(result).toBeUndefined();
    } finally {
      await cleanup(s.dirs.root);
    }
  });

  it("默认 3s 机器预算：永不结束的 provider 也必有界返回", async () => {
    const s = await setup({
      listSessions: () => new Promise(() => undefined), // 永不 resolve、忽略 signal
    });
    try {
      const startedAt = Date.now();
      const result = await s.handler(makeEvent(SCENARIO_PROMPT));
      const elapsed = Date.now() - startedAt;
      expect(result).toBeUndefined();
      expect(elapsed).toBeGreaterThanOrEqual(2900);
      expect(elapsed).toBeLessThan(6000); // 3s 预算 + 装配余量
      const limits = s.engineOptions[0]?.limits;
      expect(limits).toBeUndefined(); // 未显式传 limits → core 默认（DEFAULT_ENGINE_LIMITS.timeoutMs === 3000）
      expect(DEFAULT_ENGINE_LIMITS.timeoutMs).toBe(3000);
    } finally {
      await cleanup(s.dirs.root);
    }
  }, 15000);

  it("自定义小预算（timeoutMs=150）快速有界返回", async () => {
    const s = await setup({
      handler: { limits: { timeoutMs: 150 } },
      listSessions: () => new Promise(() => undefined),
    });
    try {
      const startedAt = Date.now();
      const result = await s.handler(makeEvent(SCENARIO_PROMPT));
      const elapsed = Date.now() - startedAt;
      expect(result).toBeUndefined();
      expect(elapsed).toBeLessThan(3000);
      expect(s.engineOptions[0]?.limits).toEqual({ timeoutMs: 150 });
    } finally {
      await cleanup(s.dirs.root);
    }
  });
});

describe("handler：M2 定界锁（不虚构完成）", () => {
  it("attachments 出现 → 丢弃并记 warn（attachments-unsupported-m1），content 无 base64", () => {
    // M1 acquire 显式 unsupported，真实引擎路径不会产出 attachments；此处直接单元测试
    // toEventResult，锁定「即便上游出现附件也只注入纯文本并记 warn」的防线行为。
    const logs: string[] = [];
    const logger: Logger = (entry) => {
      logs.push(`${entry.level}:${entry.event}`);
    };
    const output: EnrichOutput = {
      context: "[潜意识引擎·已解析]\n- \"那张图\" → /tmp/flower.png（来源：fixture）",
      attachments: [{ mediaType: "image/png", base64: "QUJDRA==" }],
      resolvedRefs: [{ refId: "r1", display: "flower" }],
      droppedRefs: [],
    };
    const result = toEventResult(output, logger);
    expect(result?.message?.content).toContain("那张图");
    expect(result?.message?.content).not.toContain("QUJDRA=="); // 附件绝不进文本
    expect(logs).toContain("warn:attachments-unsupported-m1");
    expect(result && result.message && "details" in result.message).toBe(true);
  });

  it("自带 images 的 prompt：M1 不合并进注入消息（留 M2「已有附件不丢」验收），handler 不触碰 images", async () => {
    const s = await setup();
    try {
      await writeHistoryFixture(s.dirs);
      // before_agent_start 的 result 只描述追加的 custom message；event.images 由 pi 自行
      // 随用户消息发送。M1 适配器不读取、不修改、不合并 images —— 本用例锁定该边界：
      // 返回值不携带任何图片内容，注入 content 为纯文本。
      const result = await s.handler(makeEvent(SCENARIO_PROMPT));
      expect(typeof result?.message?.content).toBe("string");
      expect(result?.message?.content).not.toMatch(/data:image|base64/i);
    } finally {
      await cleanup(s.dirs.root);
    }
  });
});
