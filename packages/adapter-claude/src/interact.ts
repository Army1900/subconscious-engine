/**
 * Claude Code hooks 的 InteractPort：录制型全 unsupported（DESIGN §7.3、§8.2）。
 *
 * hook 是子进程 JSON 协议，没有对话式 UI：confirm/select/acquire 一律返回
 * "unsupported"（core 走降级：跳过数据源 / 丢弃该指代，绝不阻塞用户）。
 *
 * 降级注入需要知道「引擎试图问什么」：本端口在返回 unsupported 前把请求原样
 * 录制下来（候选列表 / 获取提示 / 授权确认文案），供组装层把候选列表注入给
 * 大模型去问用户——等同现状，不劣化，也不冒充已解析。
 */
import type { AcquisitionSpec, InteractPort } from "@subconscious/core";

/** 一次被降级的交互请求（原样录制，供降级注入还原） */
export type InteractionRecord =
  | { kind: "confirm"; prompt: string }
  | { kind: "select"; title: string; labels: readonly string[] }
  | { kind: "acquire"; spec: AcquisitionSpec };

export interface RecordingInteractPort extends InteractPort {
  /** 已录制交互的只读快照（按发生顺序） */
  readonly records: readonly InteractionRecord[];
}

export function createRecordingUnsupportedInteract(): RecordingInteractPort {
  const records: InteractionRecord[] = [];
  return {
    get records(): readonly InteractionRecord[] {
      return Object.freeze([...records]);
    },
    async confirm(prompt) {
      records.push({ kind: "confirm", prompt });
      return "unsupported";
    },
    async select(title, options) {
      records.push({ kind: "select", title, labels: [...options] });
      return "unsupported";
    },
    async acquire(spec) {
      records.push({ kind: "acquire", spec });
      return "unsupported";
    },
  };
}
