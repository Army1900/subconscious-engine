/**
 * pi 会话 JSONL 的有界读取与 edit/write 解析（DESIGN §7.2、DECISIONS D9/D12.7）。
 *
 * 安全红线：
 * - 只读候选（SessionInfo.path）携带的真实路径，绝不凭 sessionId 拼路径（D12.7）；
 * - 路径必须位于本次 ctx 的 sessionDir **真实路径**之内（realpath 解析后判前缀），
 *   `..` 逃逸与指向目录外的符号链接一律拒绝；
 * - 字节上限（req.maxBytes）先 stat 后限长读取双保险；超限返回 null（不可用），不注入半份数据；
 * - 只接受合法 UTF-8（fatal 解码），编码非法返回 null；
 * - 单行 JSON 损坏跳过（计数），不因个别坏行丢掉整个会话，也不因坏行抛错。
 */
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ReadRequest, SessionChange, SessionRecord, SessionRef } from "@subconscious/core";

/** 解析中途可放弃的每文件护栏：单文件最多采纳的修改记录条数（自然上限之外的第二道界） */
export const MAX_CHANGES_PER_SESSION = 500;

/** 一个待定 toolCall 在 changes 数组中的落点，等 toolResult 标记 isError 后定稿 */
interface PendingCall {
  start: number;
  count: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 相对/绝对路径统一为绝对路径（sessionDir 为基准），返回 null 表示不可解析 */
function toAbsolutePath(target: string, sessionDir: string): string | null {
  if (target.trim() === "") return null;
  const absolute = path.resolve(sessionDir, target);
  return absolute;
}

/**
 * 校验文件真实路径位于 sessionDir 真实路径之内。
 * realpath 解析符号链接：目录内符号链接指向目录外文件时 contains 为 false（防符号链接逃逸）。
 */
export async function resolveContainedPath(
  filePath: string,
  sessionDir: string,
): Promise<string | null> {
  const absolute = toAbsolutePath(filePath, sessionDir);
  if (absolute === null) return null;
  let realFile: string;
  let realDir: string;
  try {
    realFile = await realpath(absolute);
    realDir = await realpath(sessionDir);
  } catch {
    return null; // 路径不存在或不可解析
  }
  if (realFile === realDir) return null; // 指向目录本身
  if (!realFile.startsWith(realDir + path.sep)) return null; // 逃逸（含符号链接指向目录外）
  return realFile;
}

/** 有界读取：最多 maxBytes 字节；超限/不存在/信号中止 → null */
async function readBounded(realFile: string, req: ReadRequest): Promise<Uint8Array | null> {
  if (req.signal.aborted) return null;
  const handle = await open(realFile, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const buffer = Buffer.alloc(req.maxBytes + 1); // 多读 1 字节用于判定超限
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (req.signal.aborted) return null;
    if (bytesRead > req.maxBytes) return null; // 超限：诚实不可用，不截断注入
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 展开一个 edit/write toolCall 参数为 SessionChange 列表（pi 0.85 edit 为 edits[] 数组形状） */
function expandToolCallArguments(tool: "edit" | "write", args: unknown, at: string): SessionChange[] {
  if (!isRecord(args)) return [];
  const filePath = typeof args.path === "string" ? args.path : undefined;
  const changes: SessionChange[] = [];
  if (tool === "edit") {
    if (Array.isArray(args.edits)) {
      for (const item of args.edits) {
        if (!isRecord(item)) continue;
        if (typeof item.oldText !== "string" || typeof item.newText !== "string") continue;
        changes.push({ tool, at, ...(filePath !== undefined ? { path: filePath } : {}), oldText: item.oldText, newText: item.newText });
      }
      return changes;
    }
    // 旧参数形状（扁平 oldText/newText，D9 兼容）
    if (typeof args.oldText === "string" && typeof args.newText === "string") {
      changes.push({ tool, at, ...(filePath !== undefined ? { path: filePath } : {}), oldText: args.oldText, newText: args.newText });
    }
    return changes;
  }
  if (typeof args.content === "string") {
    changes.push({ tool, at, ...(filePath !== undefined ? { path: filePath } : {}), content: args.content });
  }
  return changes;
}

/** 行级解析产出：修改记录 + 坏行计数 + 会话头 id（用于归属校验） */
export interface ParsedSession {
  changes: SessionChange[];
  badLines: number;
  headerId: string | undefined;
}

/**
 * 提取用户话语（M5c-2 惯例蒸馏素材）：message 条目里 role=user 的文本内容，
 * 每条消息的文本块按出现顺序拼接为一条话语（素材组装侧再做条数/字符上限）。
 * 与 parseSessionJsonl 同源的逐行解析纪律：坏行跳过、不猜形状（content 兼容
 * 字符串与块数组两种官方形态，非文本块忽略）。
 */
export function parseUserTurns(text: string): string[] {
  const turns: string[] = [];
  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 坏行跳过（与 parseSessionJsonl 同纪律）
    }
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") {
      if (content.trim() !== "") turns.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "text") continue;
      if (typeof block.text === "string" && block.text.trim() !== "") texts.push(block.text);
    }
    if (texts.length > 0) turns.push(texts.join("\n"));
  }
  return turns;
}

/** 逐行解析已解码的 JSONL 文本：message 条目里 assistant 的 edit/write toolCall 展开，toolResult 标记 isError */
export function parseSessionJsonl(text: string): ParsedSession {
  const pending = new Map<string, PendingCall>();
  const changes: SessionChange[] = [];
  let badLines = 0;
  let headerId: string | undefined;

  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      badLines += 1; // 坏行跳过，不丢弃整个会话也不抛错
      continue;
    }
    if (!isRecord(entry)) {
      badLines += 1;
      continue;
    }
    if (entry.type === "session" && typeof entry.id === "string") {
      headerId = entry.id;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;

    const at = typeof entry.timestamp === "string"
      ? entry.timestamp
      : typeof message.timestamp === "number"
        ? new Date(message.timestamp).toISOString()
        : "";

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        if (block.name !== "edit" && block.name !== "write") continue;
        if (typeof block.id !== "string") continue;
        const expanded = expandToolCallArguments(block.name, block.arguments, at);
        if (expanded.length === 0) continue;
        if (changes.length + expanded.length > MAX_CHANGES_PER_SESSION) continue; // 第二道界：超出部分不再采纳
        pending.set(block.id, { start: changes.length, count: expanded.length });
        changes.push(...expanded);
      }
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      // 失败结果标记（D9）：关联的修改记录标记 isError，由 core 跳过
      if (message.isError === true) {
        const call = pending.get(message.toolCallId);
        if (call !== undefined) {
          for (let i = call.start; i < call.start + call.count; i += 1) {
            const change = changes[i];
            if (change !== undefined) changes[i] = { ...change, isError: true };
          }
        }
      }
    }
  }
  return { changes, badLines, headerId };
}

/**
 * 读取绑定会话的修改记录。
 * 只信 SessionRef 携带的 path（候选来自 SessionManager.list 的真实文件）；
 * 归属校验：JSONL 会话头 id（若可解析）必须等于 SessionRef.id，防止 path 与 id 不一致的张冠李戴。
 */
export async function readSessionChanges(
  session: SessionRef,
  sessionDir: string,
  req: ReadRequest,
): Promise<SessionRecord | null> {
  if (typeof session.path !== "string") return null; // 无真实路径不猜（D12.7）
  const realFile = await resolveContainedPath(session.path, sessionDir);
  if (realFile === null) return null;
  const bytes = await readBounded(realFile, req);
  if (bytes === null) return null;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); // 编码非法 → 不可用
  } catch {
    return null;
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1); // 去 BOM

  const parsed = parseSessionJsonl(text);
  if (parsed.headerId !== undefined && parsed.headerId !== session.id) return null; // 归属不一致
  return { sessionId: session.id, changes: parsed.changes };
}
