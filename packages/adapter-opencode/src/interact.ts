/**
 * OpenCode plugin 的 InteractPort：录制型全 unsupported（DESIGN §7.4、§8.2）。
 *
 * 协议事实（@opencode-ai/sdk@1.18.30 Tui/App 客户端 + 官方 plugins 文档，
 * 2026-09-14 核实）：OpenCode TUI 客户端有 showToast / appendPrompt / 各内置
 * 对话框（sessions/models/themes），但没有插件可调用的 confirm / select /
 * input / 文件选取对话框 API；permission.ask hook 只服务工具授权，不是通用
 * 确认通道。因此交互能力介于 pi（原生）与 Claude Code（纯协议）之间：无对话
 * 式交互端口，但有被动通知通道（notify.ts 的 toast）。
 *
 * confirm/select/acquire 一律返回 "unsupported"（core 走降级：跳过数据源 /
 * 丢弃该指代，绝不阻塞用户）。降级注入需要知道「引擎试图问什么」：本端口在
 * 返回 unsupported 前原样录制请求，供组装层把候选/提示注入给大模型去问用户
 * ——等同现状，不劣化，也不冒充已解析。
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
