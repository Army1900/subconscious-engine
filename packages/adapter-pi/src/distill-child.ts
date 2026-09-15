#!/usr/bin/env node
/**
 * 惯例蒸馏子进程（M5c-2）：由扩展进程在 session_shutdown 时 detached spawn，
 * 在 pi 退出后存活，完成「headless pi 总结 → 校验 → addConvention 写回」。
 *
 * 入参：argv[2] = 蒸馏请求 JSON 文件路径（0600，由扩展写入）：
 *   { memoryFilePath, projectKey, sessionId, sessionTitle, material }
 * 请求文件读完即删（素材可能含会话内容，不残留临时目录）。
 *
 * 纪律：
 * - 退出码恒 0（孤儿进程，无宿主等待；非零也无人在意，恒 0 便于排查）；
 * - 日志只写 stderr 单行 JSON；
 * - headless pi 可执行文件经 SUBCONSCIOUS_DISTILL_BIN 覆盖（缺省 "pi"）；
 * - 全程 fail-open：任何失败 = 单行 warn 后退出，绝不重试、绝不挂起。
 */
import { readFile, rm } from "node:fs/promises";
import { FileMemoryStore } from "@subconscious/core";
import type { LogEntry } from "@subconscious/core";
import { runDistillation } from "./distill.js";

interface DistillChildRequest {
  memoryFilePath: string;
  projectKey: string;
  sessionId: string;
  sessionTitle: string;
  material: string;
}

function stderrLog(entry: LogEntry): void {
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // stderr 写失败：吞掉
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function main(): Promise<void> {
  const argsFile = process.argv[2];
  if (argsFile === undefined || argsFile === "") return;
  let raw: string;
  try {
    raw = await readFile(argsFile, "utf8");
  } catch {
    stderrLog({ level: "warn", event: "distill-child-request-unreadable", detail: argsFile });
    return;
  }
  await rm(argsFile, { force: true }).catch(() => undefined); // 读完即删（隐私）
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    stderrLog({ level: "warn", event: "distill-child-request-invalid", detail: "请求 JSON 解析失败" });
    return;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.memoryFilePath !== "string" ||
    typeof parsed.projectKey !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.sessionTitle !== "string" ||
    typeof parsed.material !== "string"
  ) {
    stderrLog({ level: "warn", event: "distill-child-request-invalid", detail: "请求字段缺失或类型不符" });
    return;
  }
  const request: DistillChildRequest = {
    memoryFilePath: parsed.memoryFilePath,
    projectKey: parsed.projectKey,
    sessionId: parsed.sessionId,
    sessionTitle: parsed.sessionTitle,
    material: parsed.material,
  };
  if (request.memoryFilePath === "" || request.projectKey === "" || request.sessionId === "") return;
  await runDistillation(
    {
      projectKey: request.projectKey,
      sessionId: request.sessionId,
      sessionTitle: request.sessionTitle,
      material: request.material,
    },
    { logger: stderrLog, store: new FileMemoryStore(request.memoryFilePath) },
  );
}

process.on("unhandledRejection", (reason: unknown) => {
  stderrLog({ level: "error", event: "distill-child-unhandled", detail: String(reason) });
  process.exit(0);
});

void main().catch((err: unknown) => {
  stderrLog({ level: "error", event: "distill-child-failed", detail: err instanceof Error ? err.message : String(err) });
  process.exit(0);
});
