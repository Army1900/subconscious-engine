/**
 * demo 冒烟测试：不 mock adapter handler——直接跑 runDemo() 的同一条真实路径
 * （真实 createBeforeAgentStartHandler + 真实 SessionManager fixture，目录在 os.tmpdir）。
 *
 * 断言任务要求的三个可观察事实：
 * 1. history-event + history-content 成功注入：来源标注与绑定会话 diff 进入 custom message；
 * 2. 无 active editor 时 file 指代诚实 dropped（details 记录，不冒充已解析）；
 * 3. 注入消息经 pi 真实落盘行为持久化（session JSONL 尾部出现 custom_message 行）。
 *
 * 与 adapter-pi 测试的边界：那边用 mock exec/ui 驱动真实 handler；这里连 ctx 的
 * sessionManager 都是真实 SessionManager 实例、exec 是真实子进程实现、交互端口
 * 按真实无 UI 宿主（hasUI=false）配置。不触碰 ~/.pi。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runDemo } from "../src/run.js";
import type { DemoDetails } from "../src/run.js";
import { cleanupDemo } from "../src/fixture.js";

interface PersistedTail {
  type: string;
  customType?: string;
  content?: string;
}

describe("demo run（真实 adapter handler + 真实 SessionManager fixture）", () => {
  it("history-event/history-content 注入、file dropped、custom_message 落盘、临时目录清理", async () => {
    // cleanup:false 保留落盘文件供本测试独立读取验证；读毕自行清理并断言目录已删
    const outcome = await runDemo({ cleanup: false });

    // handler 返回了注入消息，形状符合 pi custom message 契约
    const message = outcome.result?.message;
    expect(message).toBeDefined();
    expect(message?.customType).toBe("subconscious");
    expect(message?.display).toBe(true);
    const content = message?.content ?? "";
    expect(content).toContain("[潜意识引擎·已解析]");
    expect(content).toContain("来源：recent-sessions"); // history-event 指代已解析
    expect(content).toContain("来源：session-content"); // history-content 指代已解析
    expect(content).toContain("try {} catch (e) { log(e); }"); // 绑定会话的真实 diff 内容
    expect(content).not.toContain("来源：active-editor"); // 无编辑器 → 文件指代未解析
    expect(content).not.toContain("src/broken.ts"); // 失败记录不进正文
    expect(content).not.toContain(outcome.prompt); // 不改写/不复述用户原话

    // details 透明性：两个历史指代解析、一个文件指代 dropped（not-found，D6 不猜测）
    const details: DemoDetails = outcome.details;
    expect(details.resolvedRefs).toHaveLength(2);
    expect(details.droppedRefs).toHaveLength(1);
    const droppedId = details.droppedRefs[0];
    expect(droppedId).toBeDefined();
    expect(details.dropReasons?.[droppedId as string]).toBe("not-found");

    // pi 真实落盘：session JSONL 尾部是注入的 custom_message 行，内容逐字一致
    const text = await readFile(outcome.fixture.file, "utf8");
    const lines = text.trimEnd().split("\n");
    const tail = JSON.parse(lines[lines.length - 1] as string) as PersistedTail;
    expect(tail.type).toBe("custom_message");
    expect(tail.customType).toBe("subconscious");
    expect(tail.content).toBe(content);

    // fixture 路径位于 os.tmpdir 下的本次临时根目录内（不触碰 ~/.pi）
    expect(outcome.fixture.file.startsWith(outcome.dirs.root)).toBe(true);
    expect(outcome.cleanupDone).toBe(false);

    // 清理后目录不复存在
    await cleanupDemo(outcome.dirs);
    expect(existsSync(outcome.dirs.root)).toBe(false);

    // demo 自检全部通过（runDemo 内部对同一组事实的自证）
    expect(outcome.checks.length).toBeGreaterThanOrEqual(3);
    expect(outcome.checks.every((check) => check.pass)).toBe(true);
  });
});
