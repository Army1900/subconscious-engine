import type {
  DanglingRef,
  DropReason,
  EngineLimits,
  EnrichOutput,
  ImageLike,
  Logger,
  ResolvedValue,
} from "./types.js";
import { truncate } from "./text.js";

/** 已解析项（解析器输出） */
export interface ResolvedItem {
  readonly ref: DanglingRef;
  readonly value: ResolvedValue;
  readonly display: string;
  readonly sourceId: string;
}

/** 已放弃项（解析器输出） */
export interface DroppedItem {
  readonly refId: string;
  readonly reason: DropReason;
}

export interface AssembleOptions {
  readonly limits: EngineLimits;
  readonly logger?: Logger;
}

function isImageValue(value: ResolvedValue): value is Extract<ResolvedValue, { type: "image" }> {
  return value.type === "image";
}

function formatItem(item: ResolvedItem): string {
  // display 的后续行缩进对齐，来源标注固定缀于行尾（D8.1：注入物带来源标注）
  const indented = item.display.split("\n").join("\n    ");
  return `- "${item.ref.text}" → ${indented}（来源：${item.sourceId}）`;
}

/**
 * 组装器（DESIGN §4.5、D8）：
 * - 注入头固定 `[潜意识引擎·已解析]`；只注入已解析项；未解析指代不进 context。
 * - 原话不改写：context 是附加文本，不包含也不替换用户 prompt。
 * - 图片值只进 attachments 通道，结构上不可能进入 context 文本（D8.4）。
 * - 总量上限 maxContextChars，超限截断并显式标注。
 */
export function assemble(
  resolved: readonly ResolvedItem[],
  dropped: readonly DroppedItem[],
  options: AssembleOptions,
): EnrichOutput {
  const { limits } = options;
  const resolvedRefs = resolved.map((item) => ({ refId: item.ref.id, display: truncate(item.display, limits.maxRefDisplayChars) }));
  const droppedRefs = dropped.map((d) => d.refId);
  const dropReasons: Record<string, DropReason> = {};
  for (const d of dropped) dropReasons[d.refId] = d.reason;

  const output: EnrichOutput = { resolvedRefs, droppedRefs, dropReasons };
  if (resolved.length === 0) return output; // no-op 透传：无 context

  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  const header = "[潜意识引擎·已解析]";
  used += header.length + 1;
  for (const item of resolved) {
    const line = formatItem(item);
    const cost = line.length + 1;
    if (used + cost > limits.maxContextChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += cost;
  }
  let context = header;
  for (const line of lines) context += `\n${line}`;
  if (omitted > 0) context += `\n[已截断：${omitted} 项因注入上限未注入]`;
  if (context.length > limits.maxContextChars) {
    context = truncate(context, limits.maxContextChars);
  }
  output.context = context;

  const attachments: ImageLike[] = [];
  for (const item of resolved) {
    if (!isImageValue(item.value)) continue;
    if (typeof item.value.mediaType !== "string" || !item.value.mediaType.startsWith("image/")) {
      options.logger?.({
        level: "warn",
        event: "attachment-rejected",
        refId: item.ref.id,
        sourceId: item.sourceId,
        detail: `非法 mediaType: ${String(item.value.mediaType)}`,
      });
      continue; // 非图片 MIME 不进附件通道
    }
    if (typeof item.value.base64 !== "string" || item.value.base64 === "") continue;
    attachments.push({ mediaType: item.value.mediaType, base64: item.value.base64 });
  }
  if (attachments.length > 0) output.attachments = attachments;
  return output;
}
