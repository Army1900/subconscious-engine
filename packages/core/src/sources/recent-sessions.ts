import type { Candidate, DataSource, Resolution, ResolvedValue, SessionSummary } from "../types.js";

type HistoryEventValue = Extract<ResolvedValue, { type: "history-event" }>;

const NOT_FOUND: Resolution = { status: "not-found" };

function isSession(s: unknown): s is SessionSummary {
  if (s === null || typeof s !== "object") return false;
  const v = s as Partial<SessionSummary>;
  if (typeof v.id !== "string" || v.id.trim() === "") return false; // 稳定 id 必须存在
  if (typeof v.title !== "string") return false;
  if (typeof v.at !== "string") return false;
  if (v.path !== undefined && typeof v.path !== "string") return false;
  return true;
}

function labelOf(s: SessionSummary): string {
  return `${s.title}（${s.at}）`;
}

function valueOf(s: SessionSummary): HistoryEventValue {
  return {
    type: "history-event",
    sessionId: s.id,
    ...(s.path !== undefined ? { path: s.path } : {}),
    title: s.title,
    at: s.at,
  };
}

/**
 * `recent-sessions`（L0，类型 history-event；DESIGN §4.2）。
 * - 惰性读取 env.listRecentSessions；未命中指代类型则 provider 永不被调用（D2）。
 * - 排序：at 有效者按时间降序（最新在前）；at 无效/乱序输入确定性地排在末尾（原始顺序稳定）。
 * - 单会话 → 直接 resolved（稳定 sessionId）；多会话 → ambiguous（候选携带稳定 id，
 *   用户选择后才由引擎绑定，绝不替用户猜）。
 */
export const recentSessionsSource: DataSource = {
  id: "recent-sessions",
  types: ["history-event"],
  permission: "L0-free",
  async resolve(ref, env, ctx): Promise<Resolution> {
    if (ref.expectedType !== "history-event") return NOT_FOUND;
    if (typeof env.listRecentSessions !== "function") return NOT_FOUND;

    let sessions: SessionSummary[] | null = null;
    try {
      sessions = await env.listRecentSessions({ signal: ctx.signal, maxBytes: ctx.limits.maxSourceBytes });
    } catch {
      return NOT_FOUND;
    }
    if (!Array.isArray(sessions)) return NOT_FOUND;

    const valid = sessions.filter(isSession);
    if (valid.length === 0) return NOT_FOUND;

    const ordered = [...valid]
      .map((s, i) => ({ s, i, t: Date.parse(s.at) }))
      .sort((a, b) => {
        // 降序（新在前）；无效时间按 -Infinity 自然落在最后
        const av = Number.isNaN(a.t) ? Number.NEGATIVE_INFINITY : a.t;
        const bv = Number.isNaN(b.t) ? Number.NEGATIVE_INFINITY : b.t;
        if (av !== bv) return bv - av;
        return a.i - b.i; // 稳定
      })
      .map((x) => x.s)
      .slice(0, ctx.limits.maxListItems);

    const first = ordered[0];
    if (first === undefined) return NOT_FOUND;
    if (ordered.length === 1) {
      return { status: "resolved", value: valueOf(first), display: labelOf(first) };
    }

    const candidates: Candidate[] = ordered.map((s): Candidate => ({
      id: s.id,
      label: labelOf(s),
      value: valueOf(s),
    }));
    return { status: "ambiguous", candidates };
  },
};
