/**
 * subconscious install：预检 → 材料化源码（git clone --depth 1 / link 原地）→
 * npm ci|install → npm run build → 逐宿主接线 → 写 install.json。
 * --dry-run 打印将执行的每一步（含配置 diff 预览）后退出，零写入。
 * 已有 install.json 拒绝（提示 update）；src 目录存在但无标记拒绝（防覆盖来路不
 * 明的内容）。
 */
import { existsSync } from "node:fs"
import type { ParsedArgs } from "./args.js"
import { cloneSource, currentRev, installDepsAndBuild, preflight, resolveSource, validateHostsForInstall } from "./deps.js"
import type { CommandDeps } from "./deps.js"
import { claudeHookCommand } from "./claude-settings.js"
import { adapterDistDir, claudeHookMain, opencodePluginContent, wireHost, type HostIo, type HostName } from "./hosts.js"
import { readInstallRecord, writeInstallRecord } from "./install-json.js"
import { computePaths } from "./paths.js"

function hostIo(paths: ReturnType<typeof computePaths>, sourcePath: string, deps: CommandDeps): HostIo {
  return { paths, sourceRoot: sourcePath, log: deps.log }
}

function printPlan(hosts: HostName[], sourcePath: string, mode: "git" | "link", deps: CommandDeps, paths: ReturnType<typeof computePaths>): void {
  const log = deps.log
  log(`[dry-run] 1/6 预检：node ≥22、npm 在 PATH${mode === "git" ? "、git 在 PATH（git 模式）" : ""}`)
  log(mode === "git"
    ? `[dry-run] 2/6 材料化源码：git clone --depth 1 <source> ${paths.srcDir}`
    : `[dry-run] 2/6 材料化源码：link 模式，不 clone（原地构建：${sourcePath}）`)
  log("[dry-run] 3/6 依赖与构建：npm ci（有 package-lock.json 时）或 npm install，随后 npm run build")
  for (const host of hosts) {
    if (host === "pi") {
      log(`[dry-run] 4/6 pi：清空并拷贝 ${adapterDistDir(sourcePath, "pi")} → ${paths.piExtensionDir}`)
    } else if (host === "claude") {
      const hookMain = claudeHookMain(sourcePath)
      log(`[dry-run] 4/6 claude：${paths.claudeSettingsFile} 追加（已装则跳过）：`)
      log(`[dry-run]     UserPromptSubmit ← {"hooks":[{"type":"command","command":"${claudeHookCommand(hookMain)}","timeout":10}]}`)
      log(`[dry-run]     SessionEnd      ← {"hooks":[{"type":"command","command":"${claudeHookCommand(hookMain)}","timeout":60}]}`)
    } else {
      log(`[dry-run] 4/6 opencode：覆写 ${paths.opencodePluginFile} → ${opencodePluginContent(sourcePath).trim()}`)
    }
  }
  log("[dry-run] 5/6 各宿主接线（上表）；claude 写前备份原 settings.json")
  log(`[dry-run] 6/6 写安装记录 ${paths.installJsonFile}`)
  log("[dry-run] 本次零写入，未执行任何命令。")
}

export async function runInstall(args: ParsedArgs, deps: CommandDeps): Promise<number> {
  const log = deps.log
  let paths
  try {
    paths = computePaths({ HOME: deps.env.HOME })
  } catch (err) {
    log(err instanceof Error ? err.message : String(err))
    return 1
  }

  const hostsCheck = validateHostsForInstall(args.hosts, deps)
  if (hostsCheck.error !== undefined || hostsCheck.hosts === undefined) {
    log(hostsCheck.error ?? "错误：--hosts 非法")
    return 1
  }
  const hosts = hostsCheck.hosts

  const sourceCheck = resolveSource(args.source, paths)
  if (sourceCheck.error !== undefined || sourceCheck.plan === undefined) {
    log(sourceCheck.error ?? "错误：--source 非法")
    return 1
  }
  const plan = sourceCheck.plan

  // 拒绝条件（dry-run 同样检查：已装/脏 src 时「将执行」没有意义）
  const existing = await readInstallRecord(paths.installJsonFile)
  if (existing.ok) {
    log(`错误：${paths.installJsonFile} 已存在——已安装（模式 ${existing.record.mode}，宿主 ${existing.record.hosts.join("/")}）。`)
    log("请使用 subconscious update 更新，或 subconscious uninstall 后重新安装。")
    return 1
  }
  if (plan.mode === "git" && existsSync(paths.srcDir)) {
    log(`错误：${paths.srcDir} 已存在但无安装标记（install.json）。`)
    log("该目录不是本安装器管理的源码树，拒绝覆盖。请人工确认：确属遗留可删除该目录后重试，或用 --source <本地绝对路径> 走 link 模式。")
    return 1
  }

  const preflightOk = preflight(deps, plan.mode)

  if (args.dryRun) {
    printPlan(hosts, plan.sourcePath, plan.mode, deps, paths)
    return preflightOk ? 0 : 1
  }
  if (!preflightOk) {
    log("✗ 预检未通过，已中止（零写入）。")
    return 1
  }

  if (plan.mode === "git") {
    if (!(await cloneSource(plan, deps, paths))) return 1
  } else {
    log(`→ link 模式：使用源码树 ${plan.sourcePath}（不 clone）`)
  }

  if (!(await installDepsAndBuild(plan.sourcePath, deps))) return 1

  const wired: HostName[] = []
  for (const host of hosts) {
    if (await wireHost(host, hostIo(paths, plan.sourcePath, deps))) wired.push(host)
  }
  if (wired.length === 0) {
    log("✗ 没有任何宿主接线成功，未写入安装记录。")
    return 1
  }
  if (wired.length < hosts.length) {
    log(`⚠ 部分宿主接线失败：${hosts.filter((h) => !wired.includes(h)).join(" / ")}（安装记录只登记成功的宿主）`)
  }

  const rev = await currentRev(plan.sourcePath, deps)
  const now = new Date().toISOString()
  await writeInstallRecord(paths.installJsonFile, {
    version: 1,
    mode: plan.mode,
    source: plan.source,
    sourcePath: plan.sourcePath,
    rev,
    hosts: wired,
    installedAt: now,
  })

  log(`✓ 安装完成（模式 ${plan.mode}，宿主 ${wired.join(" / ")}，rev ${rev === "" ? "（非 git 源，无 rev）" : rev}）`)
  log(`✓ 安装记录：${paths.installJsonFile}`)
  log("建议：subconscious doctor 检查接线状态；安装后先用无指代语句冒烟（行为应与裸宿主一致）。")
  return wired.length === hosts.length ? 0 : 1
}
