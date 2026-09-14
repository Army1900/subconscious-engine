/**
 * Claude Code hooks → core 的 HostEnv 构建（DESIGN §7.3、D2/D6）。
 *
 * - cwd：只取 hook 输入 JSON 的 cwd 字段（官方字段，2026-09-14 核实），缺失已在
 *   input 解析层判为非法——不回退 process.cwd()，不猜测。
 * - activeEditor：hooks 协议不提供编辑器状态 → 结构性缺失（D6：无编辑器不猜，
 *   「最近编辑的文件」不是「当前文件」）。
 * - readSessionContent / readClipboardText：结构性缺失。transcript JSONL 的内部
 *   结构无官方文档，不解析不猜（会话内容注入留待结构可核实时开放）；clipboard 是
 *   L1 源，本环境无确认通道（InteractPort 全 unsupported），授权前不得读取。
 * - recent-sessions：官方 transcript_path 指向 ~/.claude/projects/<项目>/<会话>.jsonl，
 *   同项目历史会话是该目录下的兄弟 *.jsonl 文件——这是从官方字段本身可核实的部分；
 *   会话元数据只取文件名（稳定 id）与 mtime（at），标题由文件名派生，不解析文件内容。
 * - cwd-context：目录摘要走有界 readdir；git status 走可注入 exec（默认 node 子进程，
 *   带超时与取消），失败/非 git 仓库 → gitStatus 诚实缺失。
 */
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { truncate } from "@subconscious/core";
import type { CwdSnapshot, HostEnv, ReadRequest, SessionSummary } from "@subconscious/core";
import type { ClaudeHookInput } from "./input.js";

/** git 单次执行上限（引擎 3s 机器预算外的第二道界） */
export const GIT_STATUS_TIMEOUT_MS = 2000;

/** 会话标题/文件名截断（不解析会话内容，标题仅由文件名派生） */
export const SESSION_TITLE_MAX_CHARS = 80;

/** provider 侧会话列表护栏（core 侧另有 maxListItems 界） */
export const MAX_SESSION_ENTRIES = 50;

/** 目录扫描上限（防御性：会话目录异常膨胀时不再 stat 更多文件） */
export const MAX_SESSION_SCAN = 500;

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

export interface ClaudeHostEnvOptions {
  /** git 执行器；缺省真实子进程（带超时与取消） */
  exec?: GitExec;
}

/** 会话目录：只信绝对路径 transcript_path 的 dirname；相对/缺失 → null（不猜） */
function sessionDir(transcriptPath: string): string | null {
  if (transcriptPath === "" || !path.isAbsolute(transcriptPath)) return null;
  return path.dirname(transcriptPath);
}

function toSummary(dir: string, name: string, mtimeMs: number): SessionSummary {
  const stem = name.slice(0, -".jsonl".length);
  return {
    id: stem,
    path: path.join(dir, name),
    title: truncate(`Claude 会话 ${stem}`, SESSION_TITLE_MAX_CHARS),
    at: new Date(mtimeMs).toISOString(),
  };
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
 * 从 UserPromptSubmit hook 输入构建 HostEnv。provider 全部有界、可取消、异常返回 null；
 * core 侧再做空值/形状校验（绝不注入半可信数据）。
 */
export function createClaudeHostEnv(input: ClaudeHookInput, options: ClaudeHostEnvOptions = {}): HostEnv {
  const exec: GitExec = options.exec ?? nodeGitExec;

  return {
    cwd: input.cwd,
    // activeEditor / readSessionContent / readClipboardText：结构性缺失（见模块头注释）
    async listRecentSessions(req) {
      if (req.signal.aborted) return null;
      const dir = sessionDir(input.transcriptPath);
      if (dir === null) return null;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      if (req.signal.aborted) return null;
      const currentFile = input.sessionId !== "" ? `${input.sessionId}.jsonl` : null;
      const names = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== currentFile)
        .map((entry) => entry.name)
        .slice(0, MAX_SESSION_SCAN);
      const withMtime: Array<{ name: string; mtimeMs: number }> = [];
      for (const name of names) {
        try {
          const info = await stat(path.join(dir, name));
          withMtime.push({ name, mtimeMs: info.mtimeMs });
        } catch {
          // 单文件 stat 失败（并发删除等）：跳过该文件，不影响其余
        }
      }
      if (req.signal.aborted) return null;
      return withMtime
        .sort((a, b) => b.mtimeMs - a.mtimeMs) // mtime 降序（新在前）
        .slice(0, MAX_SESSION_ENTRIES)
        .map((item) => toSummary(dir, item.name, item.mtimeMs));
    },
    async readCwdContext(req) {
      if (req.signal.aborted) return null;
      const [gitStatus, dirSummary] = await Promise.all([
        readGitStatus(input.cwd, exec, req),
        readDirSummary(input.cwd, req),
      ]);
      if (req.signal.aborted) return null;
      const snapshot: CwdSnapshot = {
        cwd: input.cwd,
        ...(gitStatus !== undefined ? { gitStatus } : {}),
        ...(dirSummary !== undefined ? { dirSummary } : {}),
      };
      return snapshot;
    },
  };
}
