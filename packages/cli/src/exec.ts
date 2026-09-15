/**
 * 可注入执行器：npm/git 一律经此接口调用，默认实现包装真实 child_process；
 * 单测注入假实现（绝不跑真实 npm ci && npm run build）。
 *
 * PATH 探测不依赖 shell（逐目录 existsSync + X_OK），与执行器同属一个模块，
 * 预检（git/npm 在场）与「宿主 CLI 是否在 PATH」共用同一判定。
 */
import { spawn } from "node:child_process"
import { accessSync } from "node:fs"
import path from "node:path"

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
}

export type Executor = (command: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>

export const realExecutor: Executor = (command, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` })
    })
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })

/** PATH 上是否存在可执行文件（逐目录探测，无 shell 依赖） */
export function isCliOnPath(env: { PATH?: string }, cli: string): boolean {
  const paths = env.PATH?.split(path.delimiter).filter((p) => p !== "") ?? []
  for (const dir of paths) {
    const candidate = path.join(dir, cli)
    try {
      accessSync(candidate)
      return true
    } catch {
      // 继续探测下一目录
    }
  }
  return false
}

/** 当前 node 主版本（预检 node ≥ 22 用） */
export function nodeMajor(): number {
  const major = /^(\d+)\./.exec(process.versions.node)
  return major === null ? 0 : Number(major[1])
}
