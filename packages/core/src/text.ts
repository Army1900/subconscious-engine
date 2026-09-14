/** 文本界限工具：所有进入注入文本的数据必须有界（监督红线：上下文大小界限） */

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 超长截断，带显式标记 */
export function truncate(text: string, maxChars: number, marker = "…[已截断]"): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

/** 多行片段压成缩进块并截断（diff 条目用） */
export function snippetBlock(text: string, maxChars: number, indent = "  "): string {
  const flattened = text.split(/\r?\n/).join(`\n${indent}`);
  return truncate(flattened, maxChars);
}

/** 重复标签去重：同名候选追加序号后缀，保证 label → 候选映射唯一（稳定 id 纪律） */
export function uniquifyLabels(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const n = seen.get(label) ?? 0;
    seen.set(label, n + 1);
    return n === 0 ? label : `${label}（${n + 1}）`;
  });
}
