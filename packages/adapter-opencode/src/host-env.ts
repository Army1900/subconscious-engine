/**
 * OpenCode plugin → core 的 HostEnv 构建（DESIGN §7.4、D2/D6）。
 *
 * 协议事实（@opencode-ai/sdk@1.18.30 dist/gen/*.d.ts，2026-09-14 核实）：
 * - `client.session.list({ query?: { directory? } })` → `RequestResult`，成功时
 *   `data: Array<Session>`；`Session { id; directory; title: string; time: { created; updated } }`；
 * - `client.session.get({ path: { id } })` → `data: Session`；
 * - `client.session.diff({ path: { id } })` → `data: Array<FileDiff>`；
 *   `FileDiff { file; before; after; additions; deletions }`（会话级修改记录）。
 * RequestResult 是 `{ data?; error?; request; response }`，非 200 时 data 缺失——
 * 一律按不可用（null）处理，绝不注入半可信数据。
 *
 * 纪律（对齐 adapter-claude host-env）：
 * - activeEditor / readClipboardText：OpenCode plugin API 无编辑器状态与剪贴板读取
 *   （TUI 客户端有 toast，但无插件可调的编辑器/剪贴板通道）→ 结构性缺失，不猜（D6）；
 * - 会话列表按 directory 过滤（本项目会话）、排除当前 sessionID、time.updated 降序
 *   （无效时间确定性排最后）、条数与标题双截断；
 * - 会话内容 = 绑定会话的 FileDiff[]（edit 语义：before/after），at 取会话
 *   time.updated（缺失 → 空串，core 按无效时间排后，不猜）；
 * - cwd-context：目录摘要有界 readdir；git status 走可注入 exec（默认 node 子进程，
 *   带超时与取消），失败/非 git 仓库 → gitStatus 诚实缺失；
 * - 所有 provider 有界、可取消、异常返回 null；core 侧再做空值/形状校验。
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { truncate } from "@subconscious/core";
import type {
  CwdSnapshot,
  HostEnv,
  ReadRequest,
  SessionChange,
  SessionRecord,
  SessionSummary,
} from "@subconscious/core";

/** git 单次执行上限（引擎 3s 机器预算外的第二道界） */
export const GIT_STATUS_TIMEOUT_MS = 2000;

/** 会话标题截断（不解析会话内容，标题只用官方 Session.title） */
export const SESSION_TITLE_MAX_CHARS = 80;

/** provider 侧会话列表护栏（core 侧另有 maxListItems 界） */
export const MAX_SESSION_ENTRIES = 50;

/** 目录摘要条目上限 */
export const MAX_DIR_ENTRIES = 30;

/** exec 结果：code 为退出码；spawn 级失败（git 不存在等）以 reject 表达 */
export interface GitExecResult {
  code: number;
  stdout: string;
}

/** 可注入 git 执行器（测试注入假实现；缺省真实 node 子进程） */
export type GitExec = (
  args: readonly string[],
  opts: { cwd: string; timeout: number; signal: AbortSignal },
) => Promise<GitExecResult>;

function nodeGitExec(args: readonly string[], opts: { cwd: string; timeout: number; signal: AbortSignal }): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd: opts.cwd, timeout: opts.timeout, signal: opts.signal, encoding: "utf8" },
      (err, stdout) => {
        if (err === null) {
          resolve({ code: 0, stdout: typeof stdout === "string" ? stdout : "" });
          return;
        }
        // 非零退出：code 为数字（合法结果）；spawn 失败（ENOENT 等）：code 为字符串 → reject
        if (typeof err.code === "number") {
          resolve({ code: err.code, stdout: typeof stdout === "string" ? stdout : "" });
          return;
        }
        reject(err);
      },
    );
  });
}

/**
 * 官方 session 客户端的结构子面（真实接线见 plugin.ts 的 toSessionClient）。
 * 响应载荷为 unknown：宿主 API 可能来自 JS，形状校验在本模块完成。
 */
export interface SessionClient {
  /** GET /session（query.directory 过滤本项目会话） */
  list(query?: { directory?: string }): Promise<{ data?: unknown }>;
  /** GET /session/{id} */
  get(id: string): Promise<{ data?: unknown }>;
  /** GET /session/{id}/diff */
  diff(id: string): Promise<{ data?: unknown }>;
}

export interface OpenCodeHostEnvSnapshot {
  /** 插件工作目录（PluginInput.directory，官方字段） */
  cwd: string;
  /** 当前会话 id（chat.message input.sessionID）；列表排除自身 */
  currentSessionId?: string;
}

export interface OpenCodeHostEnvClients {
  session?: SessionClient;
  exec?: GitExec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** time.updated → ISO；缺失/非有限数 → 空串（无效时间，不猜；core 排序时排后） */
function isoOrEmpty(container: Record<string, unknown> | undefined): string {
  const time = container?.time;
  if (!isRecord(time)) return "";
  const updated = time.updated;
  if (typeof updated !== "number" || !Number.isFinite(updated)) return "";
  return new Date(updated).toISOString();
}

/** 排序键：有效时间降序（新在前），无效时间确定性排最后 */
function sessionOrder(entry: { updatedMs: number | null }): number {
  return entry.updatedMs ?? -Number.MAX_VALUE;
}

/** git status --porcelain：失败/超时/中止/干净工作区 → undefined（不注入） */
async function readGitStatus(cwd: string, exec: GitExec, req: ReadRequest): Promise<string | undefined> {
  try {
    const result = await exec(["status", "--porcelain"], { cwd, timeout: GIT_STATUS_TIMEOUT_MS, signal: req.signal });
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
async function readDirSummary(cwd: string, req: ReadRequest): Promise<string | undefined> {
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
 * 从 plugin 上下文构建 HostEnv。cwd 只取传入的 PluginInput.directory（官方字段），
 * 不回退 process.cwd()；provider 全部有界、可取消、异常返回 null。
 */
export function createOpenCodeHostEnv(
  snapshot: OpenCodeHostEnvSnapshot,
  clients: OpenCodeHostEnvClients = {},
): HostEnv {
  const exec: GitExec = clients.exec ?? nodeGitExec;
  const session = clients.session;

  return {
    cwd: snapshot.cwd,
    // activeEditor / readClipboardText：结构性缺失（见模块头注释）
    async listRecentSessions(req) {
      if (session === undefined || req.signal.aborted) return null;
      let result: { data?: unknown };
      try {
        result = await session.list({ directory: snapshot.cwd });
      } catch {
        return null;
      }
      if (req.signal.aborted) return null;
      if (!Array.isArray(result.data)) return null;
      const currentId = snapshot.currentSessionId;
      const valid: Array<{ summary: SessionSummary; updatedMs: number | null }> = [];
      for (const raw of result.data) {
        if (!isRecord(raw)) continue;
        const { id, title } = raw;
        if (typeof id !== "string" || id === "") continue;
        if (typeof title !== "string") continue;
        if (currentId !== undefined && id === currentId) continue;
        const updated = isRecord(raw.time) && typeof raw.time.updated === "number" && Number.isFinite(raw.time.updated)
          ? raw.time.updated
          : null;
        valid.push({
          summary: {
            id,
            title: truncate(title, SESSION_TITLE_MAX_CHARS),
            at: updated === null ? "" : new Date(updated).toISOString(),
          },
          updatedMs: updated,
        });
      }
      return valid
        .sort((a, b) => sessionOrder(b) - sessionOrder(a)) // updated 降序，无效排后（稳定排序）
        .slice(0, MAX_SESSION_ENTRIES)
        .map((item) => item.summary);
    },
    async readSessionContent(ref, req) {
      if (session === undefined || req.signal.aborted) return null;
      let info: { data?: unknown };
      try {
        info = await session.get(ref.id);
      } catch {
        return null;
      }
      if (req.signal.aborted) return null;
      const at = isRecord(info.data) ? isoOrEmpty(info.data) : "";
      let diff: { data?: unknown };
      try {
        diff = await session.diff(ref.id);
      } catch {
        return null;
      }
      if (req.signal.aborted) return null;
      if (!Array.isArray(diff.data)) return null;
      const changes: SessionChange[] = [];
      for (const raw of diff.data) {
        if (!isRecord(raw)) continue;
        const { file, before, after } = raw;
        if (typeof file !== "string" || file === "") continue;
        if (typeof before !== "string" || typeof after !== "string") continue;
        changes.push({
          at,
          tool: "edit",
          path: file,
          oldText: truncate(before, req.maxBytes),
          newText: truncate(after, req.maxBytes),
        });
      }
      const record: SessionRecord = { sessionId: ref.id, changes };
      return record;
    },
    async readCwdContext(req) {
      if (req.signal.aborted) return null;
      const [gitStatus, dirSummary] = await Promise.all([
        readGitStatus(snapshot.cwd, exec, req),
        readDirSummary(snapshot.cwd, req),
      ]);
      if (req.signal.aborted) return null;
      const context: CwdSnapshot = {
        cwd: snapshot.cwd,
        ...(gitStatus !== undefined ? { gitStatus } : {}),
        ...(dirSummary !== undefined ? { dirSummary } : {}),
      };
      return context;
    },
  };
}
