#!/usr/bin/env node
/**
 * Claude Code hooks 可执行入口（DESIGN §7.3、docs/ACCEPTANCE「Claude」行；
 * M5c-2 起同时承接 UserPromptSubmit 与 SessionEnd 两个事件，同一 bin 双注册）。
 *
 * 协议（官方 hooks reference，https://docs.claude.com/en/docs/claude-code/hooks，
 * 2026-09-14 核实；SessionEnd 事件面 2026-09-15 核实）：
 * - 输入：stdin JSON（session_id/transcript_path/cwd/permission_mode/hook_event_name
 *   [+ UserPromptSubmit 的 prompt | SessionEnd 的 reason]）；
 * - UserPromptSubmit 输出：stdout 单行 JSON `{hookSpecificOutput:{hookEventName:
 *   "UserPromptSubmit", additionalContext}}`；不输出 decision/continue/stopReason
 *   ——永不阻塞、永不抹除用户 prompt（decision:"block" 与退出码 2 都会阻断
 *   prompt，本适配器禁用）；
 * - SessionEnd 输出：**无 stdout JSON**（SessionEnd 无上下文通道），只做 M5c-2
 *   惯例蒸馏（headless claude -p 子进程，独立超时预算，fail-open）；
 * - 日志：只写 stderr（UserPromptSubmit 的 stdout 会被并入上下文，任何非载荷
 *   输出都是污染）；
 * - 防递归哨兵：SUBCONSCIOUS_DISTILL_CHILD=1（蒸馏子进程触发的 hook）→ 全事件
 *   no-op，蒸馏子进程自身绝不再触发本适配器；
 * - fail-open：整个流程 try/catch + 总超时，任何失败输出空（原样透传），
 *   退出码恒为 0。
 *
 * 总超时默认 5s（引擎机器预算 3s + 余量），可用 SUBCONSCIOUS_HOOK_TIMEOUT_MS
 * 覆盖（正整数，上限 30s，防误配超过宿主 60s hook 上限）；该预算只约束
 * UserPromptSubmit 路径，SessionEnd 蒸馏走 SUBCONSCIOUS_DISTILL_TIMEOUT_MS。
 */
import type { LogEntry } from "@subconscious/core";
import { truncate } from "@subconscious/core";
import { isDistillChildGuard } from "./distill.js";
import { handleUserPromptSubmit } from "./hook.js";
import { parseSessionEndInput, parseUserPromptSubmitInput } from "./input.js";
import { handleSessionEnd } from "./session-end.js";
import { readAllStdin } from "./stdin.js";
import { resolveTotalTimeoutMs } from "./timeout.js";

export { DEFAULT_TOTAL_TIMEOUT_MS, MAX_TOTAL_TIMEOUT_MS, resolveTotalTimeoutMs } from "./timeout.js";

/** 日志只走 stderr（JSON 行；--debug / transcript 模式可见，stdout 零污染） */
function stderrLog(entry: LogEntry): void {
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // stderr 写失败（管道已断等）：吞掉，绝不影响退出路径
  }
}

/** 总超时 race：超时/异常都 resolve undefined（fail-open），绝不 reject */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T | undefined> {
  if (ms <= 0) {
    onTimeout();
    return Promise.resolve(undefined);
  }
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        stderrLog({
          level: "error",
          event: "handler-rejected",
          detail: err instanceof Error ? err.message : String(err),
        });
        resolve(undefined);
      },
    );
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const totalMs = resolveTotalTimeoutMs();
  const remainingMs = (): number => totalMs - (Date.now() - startedAt);

  const raw = await readAllStdin(remainingMs());
  if (isDistillChildGuard()) {
    // 防递归哨兵（M5c-2）：本进程是蒸馏子进程（headless claude -p 触发的 hook）——
    // 不注入、不再蒸馏，避免蒸馏风暴与素材污染
    stderrLog({ level: "info", event: "distill-child-guard", detail: "蒸馏子进程内 hook no-op" });
    return;
  }
  const input = parseUserPromptSubmitInput(raw);
  if (input === null) {
    // SessionEnd（M5c-2 惯例蒸馏触发）：无 stdout 输出（SessionEnd 无上下文通道），
    // 日志 stderr；蒸馏有独立超时预算（默认 50s，SUBCONSCIOUS_DISTILL_TIMEOUT_MS
    // 可覆盖），不受 UserPromptSubmit 的 5s hook 总超时约束
    const sessionEnd = parseSessionEndInput(raw);
    if (sessionEnd !== null) {
      await handleSessionEnd(sessionEnd, { logger: stderrLog });
      return; // 输出空，退出 0
    }
    if (raw.trim() === "") {
      stderrLog({ level: "info", event: "empty-input" });
    } else {
      stderrLog({ level: "warn", event: "invalid-input", detail: truncate(raw, 200) });
    }
    return; // 输出空，退出 0：prompt 原样透传
  }

  const result = await withTimeout(handleUserPromptSubmit(input, { logger: stderrLog }), remainingMs(), () =>
    stderrLog({ level: "warn", event: "total-timeout", detail: "总超时，放弃注入（fail-open）" }),
  );
  if (result === undefined) return; // no-op 或失败：输出空，退出 0

  const payload = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: result.additionalContext,
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// fail-open 最后防线：未捕获异常只记 stderr，退出码保持 0（绝不以非零码阻断 hook）
process.on("uncaughtException", (err: unknown) => {
  stderrLog({ level: "error", event: "uncaught-exception", detail: err instanceof Error ? err.message : String(err) });
  process.exitCode = 0;
});
process.on("unhandledRejection", (reason: unknown) => {
  stderrLog({ level: "error", event: "unhandled-rejection", detail: String(reason) });
  process.exitCode = 0;
});

void main().catch((err: unknown) => {
  stderrLog({ level: "error", event: "main-failed", detail: err instanceof Error ? err.message : String(err) });
  process.exitCode = 0;
});
