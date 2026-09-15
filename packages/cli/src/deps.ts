/**
 * 命令层共享依赖与步骤：可注入 deps（执行器/日志/环境/node 版本）、宿主列表校验
 * （--hosts 的错误文案契约）、--source 归类（git URL vs 本地绝对路径 link 模式）、
 * 依赖安装 + 构建步骤、rev 读取。install 与 update 复用同一套步骤实现。
 */
import { existsSync, statSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { isCliOnPath, nodeMajor as realNodeMajor, type Executor } from "./exec.js"
import { HOST_CLI, HOSTS, isHostName, type HostName } from "./hosts.js"
import type { SubconsciousPaths } from "./paths.js"

export interface CommandDeps {
  exec: Executor
  log: (line: string) => void
  env: { HOME?: string; PATH?: string }
  /** 预检用 node 主版本（默认真实 process.versions.node） */
  nodeMajor?: () => number
}

export const DEFAULT_SOURCE_URL = "https://github.com/Army1900/subconscious-engine.git"

export interface SourcePlan {
  mode: "git" | "link"
  /** 原样记录：git URL 或本地绝对路径 */
  source: string
  /** 源码根：git 模式 = 安装根/src；link 模式 = 用户指定的绝对路径 */
  sourcePath: string
}

/**
 * --source 归类：本地绝对路径且是目录 → link 模式（不 clone、原地构建、接线用该
 * 绝对路径）；其余（缺省走官方仓库 URL）→ git 模式。绝对路径不存在 → 错误。
 */
export function resolveSource(raw: string | undefined, paths: SubconsciousPaths): { plan?: SourcePlan; error?: string } {
  if (raw === undefined || raw.trim() === "") {
    return { plan: { mode: "git", source: DEFAULT_SOURCE_URL, sourcePath: paths.srcDir } }
  }
  const source = raw.trim()
  if (path.isAbsolute(source)) {
    let isDir = false
    try {
      isDir = statSync(source).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) return { error: `错误：--source 本地路径不存在或不是目录：${source}` }
    return { plan: { mode: "link", source, sourcePath: source } }
  }
  if (source === "") return { error: "错误：--source 为空" }
  return { plan: { mode: "git", source, sourcePath: paths.srcDir } }
}

function hostPathLines(deps: CommandDeps): string[] {
  return HOSTS.map((host) => {
    const onPath = isCliOnPath(deps.env, HOST_CLI[host])
    return `  - ${host}（CLI ${HOST_CLI[host]} 在 PATH：${onPath ? "是" : "否"}）`
  })
}

/** install 的 --hosts 校验：必填 + 未知名（错误文案列出可用宿主与 CLI PATH 状态） */
export function validateHostsForInstall(hosts: string[] | undefined, deps: CommandDeps): { hosts?: HostName[]; error?: string } {
  if (hosts === undefined || hosts.length === 0) {
    return {
      error: [
        "错误：--hosts 必填（接线宿主必须显式指定）。可用宿主：",
        ...hostPathLines(deps),
        "提示：宿主 CLI 未安装不阻塞安装，仅提示（该宿主安装后不会生效直至 CLI 可用）。",
      ].join("\n"),
    }
  }
  return parseHostList(hosts)
}

/** 通用宿主列表校验（uninstall / doctor：缺省合法，未知名报错） */
export function parseHostList(hosts: string[] | undefined): { hosts?: HostName[]; error?: string } {
  if (hosts === undefined) return { hosts: undefined }
  const unknown = hosts.filter((h) => !isHostName(h))
  if (unknown.length > 0) {
    return { error: `错误：未知宿主名 ${unknown.map((h) => `"${h}"`).join("、")}。可用宿主：${HOSTS.join(" / ")}` }
  }
  return { hosts: hosts as HostName[] }
}

/**
 * 预检：node ≥ 22；npm 在场（两模式都要构建）；git 模式还需 git。宿主 CLI 在 PATH
 * 仅为提示行（不阻塞）。返回是否可继续。
 */
export function preflight(deps: CommandDeps, mode: "git" | "link"): boolean {
  const log = deps.log
  const major = (deps.nodeMajor ?? realNodeMajor)()
  const nodeOk = major >= 22
  log(`预检：node v${major}（要求 ≥22）${nodeOk ? "✓" : "✗"}`)
  const npmOk = isCliOnPath(deps.env, "npm")
  log(`预检：npm 在 PATH ${npmOk ? "✓" : "✗"}`)
  let gitOk = true
  if (mode === "git") {
    gitOk = isCliOnPath(deps.env, "git")
    log(`预检：git 在 PATH（git 模式需要）${gitOk ? "✓" : "✗"}`)
  }
  for (const host of HOSTS) {
    if (!isCliOnPath(deps.env, HOST_CLI[host])) {
      log(`⚠ 提示：${host} CLI（${HOST_CLI[host]}）不在 PATH——不阻塞安装，该宿主接线后需 CLI 可用才会生效`)
    }
  }
  return nodeOk && npmOk && gitOk
}

/** 依赖安装（有 lock 走 npm ci，否则 npm install；ci 与 lock 不同步时降级 install）+ 构建；失败自带错误行 */
export async function installDepsAndBuild(sourcePath: string, deps: CommandDeps): Promise<boolean> {
  const hasLock = existsSync(path.join(sourcePath, "package-lock.json"))
  let action = hasLock ? "ci" : "install"
  let install = await runNpm(action, sourcePath, deps)
  // 源码树的 lock 可能陈旧（新包未入 lock / 手改 package.json）——ci 严格拒绝时降级 install
  if (!install && action === "ci") {
    deps.log("↻ npm ci 与 lock 不同步，降级 npm install（源码树 lock 陈旧属正常）")
    action = "install"
    install = await runNpm(action, sourcePath, deps)
  }
  if (!install) return false
  deps.log(`→ npm run build（${sourcePath}）`)
  const build = await deps.exec("npm", ["run", "build"], { cwd: sourcePath })
  if (build.code !== 0) {
    deps.log(`✗ npm run build 失败（退出码 ${build.code}）${build.stderr.trim() ? `：${build.stderr.trim()}` : ""}`)
    return false
  }
  return true
}

async function runNpm(action: string, sourcePath: string, deps: CommandDeps): Promise<boolean> {
  deps.log(`→ npm ${action}（${sourcePath}）`)
  const r = await deps.exec("npm", [action], { cwd: sourcePath })
  if (r.code !== 0) {
    deps.log(`✗ npm ${action} 失败（退出码 ${r.code}）${r.stderr.trim() ? `：${r.stderr.trim()}` : ""}`)
    return false
  }
  return true
}

/** git rev-parse HEAD（失败容忍为空串：非 git 的 link 源没有 rev） */
export async function currentRev(sourcePath: string, deps: CommandDeps): Promise<string> {
  const r = await deps.exec("git", ["rev-parse", "HEAD"], { cwd: sourcePath })
  return r.code === 0 ? r.stdout.trim() : ""
}

/** git 模式材料化：clone --depth 1 到安装根/src（父目录先建） */
export async function cloneSource(plan: SourcePlan, deps: CommandDeps, paths: SubconsciousPaths): Promise<boolean> {
  await mkdir(paths.installRoot, { recursive: true })
  deps.log(`→ git clone --depth 1 ${plan.source} ${paths.srcDir}`)
  const r = await deps.exec("git", ["clone", "--depth", "1", plan.source, paths.srcDir])
  if (r.code !== 0) {
    deps.log(`✗ git clone 失败（退出码 ${r.code}）${r.stderr.trim() ? `：${r.stderr.trim()}` : ""}`)
    return false
  }
  return true
}
