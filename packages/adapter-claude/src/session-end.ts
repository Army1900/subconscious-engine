/**
 * SessionEnd 主处理器（M5c-2 惯例蒸馏接线，DECISIONS D25/D26）。
 *
 * 协议事实（官方 hooks reference，2026-09-15 经官方文档镜像与社区实现核实；
 * 通用 stdin 字段在 D20 已核实）：SessionEnd 经 stdin 收通用字段
 * （session_id/transcript_path/cwd/permission_mode/hook_event_name）+ 事件特有
 * `reason`（如 clear/logout/prompt_input_exit）；无 prompt 字段。
 *
 * 契约：
 * - 本事件**不输出 stdout JSON**（SessionEnd 无 additionalContext 通道；输出留空，
 *   日志只写 stderr），退出码恒 0——与 UserPromptSubmit 路径共用 hook-main 入口；
 * - 蒸馏：SUBCONSCIOUS_DISTILL=0 关闭；transcript_path 缺失 → 跳过（warn）；
 *   素材 = transcript 尾部有界原文（不解析内部字段，近似素材）；执行 =
 *   headless `claude -p` 子进程（带防递归哨兵），全程 fail-open；
 * - 去抖：同会话重复 SessionEnd 只蒸馏一次（进程内记忆；SessionEnd hook 是一次性
 *   子进程，跨进程的重复事件按不同会话时刻处理——README 注明边界）；
 * - reason 仅记日志，不作为蒸馏门槛（clear/logout/退出都是该会话的结束信号）。
 */
import type { Logger } from "@subconscious/core";
import {
  createDistillDebouncer,
  DISTILL_MATERIAL_MAX_BYTES,
  isDistillEnabled,
  readTailText,
  renderTranscriptMaterial,
  runDistillation,
} from "./distill.js";
import type { DistillDebouncer } from "./distill.js";
import type { ClaudeSessionEndInput } from "./input.js";

export interface SessionEndHandlerOptions {
  logger?: Logger;
  /** env 快照；缺省 process.env（SUBCONSCIOUS_DISTILL / 记忆路径等测试注入用） */
  env?: NodeJS.ProcessEnv;
  /** 去抖器；缺省进程内单例（每会话至多一次） */
  debouncer?: DistillDebouncer;
}

/** 进程内去抖单例（hook 进程一次性，防御同进程内重复事件） */
const debouncer = createDistillDebouncer();

/** 会话标题：SessionEnd 载荷无官方标题通道 → 空串（core display 回退会话 id） */
function sessionTitleOf(): string {
  return "";
}

/**
 * SessionEnd 处理：有界读取 transcript 尾部 → 蒸馏（headless claude 子进程）→
 * 校验写回。永不抛出、永不输出 stdout（fail-open：任何失败只记 stderr 单行）。
 */
export async function handleSessionEnd(
  input: ClaudeSessionEndInput,
  options: SessionEndHandlerOptions = {},
): Promise<void> {
  const logger = options.logger;
  const env = options.env ?? process.env;
  try {
    if (!isDistillEnabled(env)) return;
    if (input.transcriptPath === "") {
      logger?.({ level: "warn", event: "distill-skipped", detail: "SessionEnd 载荷缺 transcript_path，跳过蒸馏" });
      return;
    }
    if (input.sessionId === "") {
      logger?.({ level: "warn", event: "distill-skipped", detail: "SessionEnd 载荷缺 session_id，跳过蒸馏（不虚构溯源）" });
      return;
    }
    if (!(options.debouncer ?? debouncer).shouldDistill(input.sessionId, Date.now())) return;
    const tail = await readTailText(input.transcriptPath, DISTILL_MATERIAL_MAX_BYTES);
    if (tail === null || tail.trim() === "") {
      logger?.({ level: "warn", event: "distill-skipped", detail: "transcript 不可读或为空，跳过蒸馏" });
      return;
    }
    logger?.({
      level: "info",
      event: "distill-started",
      detail: `会话 ${input.sessionId} 结束（reason=${input.reason}），开始蒸馏`,
    });
    await runDistillation(
      {
        projectKey: input.cwd,
        sessionId: input.sessionId,
        sessionTitle: sessionTitleOf(),
        material: renderTranscriptMaterial(tail),
      },
      { env, logger },
    );
  } catch (err) {
    // fail-open：SessionEnd 路径绝不抛出（入口兜底之外的双保险）
    logger?.({ level: "warn", event: "distill-skipped", detail: err instanceof Error ? err.message : String(err) });
  }
}
