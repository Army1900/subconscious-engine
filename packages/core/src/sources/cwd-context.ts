import type { CwdSnapshot, DataSource, Resolution } from "../types.js";
import { truncate } from "../text.js";

const NOT_FOUND: Resolution = { status: "not-found" };

function isValidSnapshot(snap: unknown): snap is CwdSnapshot {
  if (snap === null || typeof snap !== "object") return false;
  const s = snap as Partial<CwdSnapshot>;
  if (typeof s.cwd !== "string" || s.cwd.trim() === "") return false;
  if (s.gitStatus !== undefined && typeof s.gitStatus !== "string") return false;
  if (s.dirSummary !== undefined && typeof s.dirSummary !== "string") return false;
  return true;
}

/**
 * `cwd-context`（L0，类型 project；DESIGN §4.2）。
 * 通过 env.readCwdContext 惰性读取；provider 缺失/返回 null/形状非法 → not-found，
 * 绝不注入半可信数据（D2.3）。数据有界截断。
 */
export const cwdContextSource: DataSource = {
  id: "cwd-context",
  types: ["project"],
  permission: "L0-free",
  async resolve(ref, env, ctx): Promise<Resolution> {
    if (ref.expectedType !== "project") return NOT_FOUND;
    if (typeof env.readCwdContext !== "function") return NOT_FOUND;
    let snap: CwdSnapshot | null = null;
    try {
      snap = await env.readCwdContext({ signal: ctx.signal, maxBytes: ctx.limits.maxSourceBytes });
    } catch {
      return NOT_FOUND;
    }
    if (!isValidSnapshot(snap)) return NOT_FOUND;

    const cap = ctx.limits.maxRefDisplayChars;
    const parts: string[] = [];
    if (snap.gitStatus !== undefined && snap.gitStatus !== "") {
      parts.push(`git 状态：\n${truncate(snap.gitStatus, cap)}`);
    }
    if (snap.dirSummary !== undefined && snap.dirSummary !== "") {
      parts.push(`目录摘要：\n${truncate(snap.dirSummary, cap)}`);
    }
    const summary = truncate(parts.join("\n"), cap * 2);
    const display =
      parts.length === 0
        ? `工作目录 ${snap.cwd}`
        : `工作目录 ${snap.cwd}\n${summary}`;
    return {
      status: "resolved",
      value: { type: "project", cwd: snap.cwd, summary },
      display,
    };
  },
};
