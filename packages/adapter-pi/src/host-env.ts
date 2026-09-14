/**
 * pi → core 的 HostEnv 构建（DESIGN §6/§7.2、DECISIONS D2/D6/D11/D12.7）。
 *
 * - 每次事件重建（D11）：便宜字段内联（cwd），昂贵字段全部惰性 provider（D2），
 *   未命中指代类型则 provider 永不被调用（无指代零开销）。
 * - activeEditor：pi 无编辑器概念，适配器**不提供**（D6 绝不猜测）。
 *   options.activeEditor 仅供「有显式编辑器状态的宿主」测试夹具使用（demo 场景 B），
 *   真实 pi 扩展入口不传。
 * - recentSessions：SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir())
 *   ——官方签名（session-manager.d.ts:349，ReadonlySessionManager 含 getSessionDir）。
 * - 内容读取只信候选携带的真实 path 并校验位于 sessionDir 内（session-jsonl.ts）。
 * - cwd-context：git status 走 pi.exec（信号+超时），目录摘要走有界 readdir。
 */
import { readdir } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ExecOptions, ExecResult, SessionInfo } from "@earendil-works/pi-coding-agent";
import { truncate } from "@subconscious/core";
import type { ActiveEditorState, HostEnv, SessionSummary } from "@subconscious/core";
import { readSessionChanges } from "./session-jsonl.js";

/**
 * 本模块依赖的 ctx 子面：真实 ExtensionContext 结构性满足；
 * sessionManager 只需 getSessionDir（ExtensionContext.sessionManager 的官方类型
 * ReadonlySessionManager = Pick<SessionManager, …> 含 getSessionDir，此处再收窄到该成员）。
 */
export type PiHostContext = Pick<ExtensionContext, "cwd"> & {
  sessionManager: Pick<SessionManager, "getSessionDir">;
};

/** pi.exec 的可注入形状（ExtensionAPI.exec） */
export type PiExec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/** SessionManager.list 的可注入形状（测试/演示注入假实现；缺省用真实实现） */
export type ListSessionsFn = (cwd: string, sessionDir: string) => Promise<SessionInfo[]>;

/** git status 单次执行上限（引擎总预算之外的第二道界） */
export const GIT_STATUS_TIMEOUT_MS = 2000;

/** 会话标题截断（D9：name ?? firstMessage 截断，不调 LLM） */
export const TITLE_MAX_CHARS = 80;

/** provider 侧会话列表护栏（core 侧另有 maxListItems 界） */
export const MAX_SESSION_ENTRIES = 50;

/** 目录摘要条目上限 */
export const MAX_DIR_ENTRIES = 30;

export interface PiHostEnvOptions {
  /** pi.exec（扩展工厂注入）；缺省时 git status 不可用，目录摘要仍可用 */
  exec?: PiExec;
  /** SessionManager.list；缺省用真实静态方法 */
  listSessions?: ListSessionsFn;
  /**
   * 宿主编辑器状态夹具。真实 pi 不提供（D6：无编辑器不猜，指代诚实 dropped）；
   * 仅用于演示「宿主若显式给出 activeEditor 则文件+历史零反问」的组合行为。
   */
  activeEditor?: ActiveEditorState | null;
}

/** 会话目录：读取失败/抛错一律 null（provider 不可用，core 按 not-found 处理） */
function safeSessionDir(ctx: PiHostContext): string | null {
  try {
    return ctx.sessionManager.getSessionDir();
  } catch {
    return null;
  }
}

/** 无取消参数的 Promise 与 AbortSignal 竞速：中止 → null；底层 rejection 就地吞掉不外溢 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    const onAbort = (): void => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      },
    );
  });
}

/** SessionInfo → SessionSummary：无稳定 id 或无真实 path 的候选不可用（内容读取依赖 path，D12.7） */
function toSummary(info: SessionInfo): SessionSummary | null {
  if (typeof info.id !== "string" || info.id.trim() === "") return null;
  if (typeof info.path !== "string" || info.path.trim() === "") return null;
  const rawTitle = (info.name !== undefined && info.name !== "" ? info.name : info.firstMessage).trim();
  return {
    id: info.id,
    path: info.path,
    title: rawTitle === "" ? "（无标题会话）" : truncate(rawTitle, TITLE_MAX_CHARS),
    at: info.modified instanceof Date && !Number.isNaN(info.modified.getTime()) ? info.modified.toISOString() : "",
  };
}

/** git status --porcelain：非 git 仓库/失败/超时/中止 → undefined（不注入） */
async function readGitStatus(cwd: string, exec: PiExec, req: { signal: AbortSignal; maxBytes: number }): Promise<string | undefined> {
  try {
    const result = await exec("git", ["status", "--porcelain"], {
      cwd,
      signal: req.signal,
      timeout: GIT_STATUS_TIMEOUT_MS,
    });
    if (req.signal.aborted) return undefined;
    if (result.code !== 0) return undefined;
    const text = result.stdout.trim();
    if (text === "") return undefined; // 干净工作区不注入空块
    return truncate(text, req.maxBytes);
  } catch {
    return undefined;
  }
}

/** 有界目录摘要：读取失败 → undefined；条目数与字符数双重上限 */
async function readDirSummary(cwd: string, req: { maxBytes: number }): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
  const shown = names.slice(0, MAX_DIR_ENTRIES);
  const rest = names.length - shown.length;
  const text = rest > 0 ? `${shown.join("、")} …（另有 ${rest} 项）` : shown.join("、");
  if (text === "") return undefined;
  return truncate(text, req.maxBytes);
}

/**
 * 从 pi 扩展上下文构建 HostEnv。provider 全部有界、可取消、异常返回 null；
 * core 侧再做空值/形状校验（绝不注入半可信数据）。
 */
export function createPiHostEnv(
  ctx: PiHostContext,
  options: PiHostEnvOptions = {},
): HostEnv {
  const listSessions: ListSessionsFn = options.listSessions ?? ((cwd, sessionDir) => SessionManager.list(cwd, sessionDir));
  const exec = options.exec;

  return {
    cwd: ctx.cwd,
    activeEditor: options.activeEditor, // D6：真实 pi 不传 → undefined → active-editor 源诚实 not-found
    async listRecentSessions(req) {
      if (req.signal.aborted) return null;
      const dir = safeSessionDir(ctx);
      if (dir === null) return null;
      const infos = await raceAbort(listSessions(ctx.cwd, dir), req.signal);
      if (infos === null || !Array.isArray(infos)) return null;
      const summaries = infos
        .map((info) => (info instanceof Object ? toSummary(info) : null))
        .filter((summary): summary is SessionSummary => summary !== null)
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // 降序防御性排序后再截断
      return summaries.slice(0, MAX_SESSION_ENTRIES);
    },
    async readSessionContent(session, req) {
      if (req.signal.aborted) return null;
      const dir = safeSessionDir(ctx);
      if (dir === null) return null;
      return readSessionChanges(session, dir, req);
    },
    async readCwdContext(req) {
      if (req.signal.aborted) return null;
      const [gitStatus, dirSummary] = await Promise.all([
        exec !== undefined ? readGitStatus(ctx.cwd, exec, req) : Promise.resolve(undefined),
        readDirSummary(ctx.cwd, req),
      ]);
      if (req.signal.aborted) return null;
      return {
        cwd: ctx.cwd,
        ...(gitStatus !== undefined ? { gitStatus } : {}),
        ...(dirSummary !== undefined ? { dirSummary } : {}),
      };
    },
  };
}
