/**
 * subconscious update：git pull --ff-only（clone 模式在安装根/src 内，link 模式在
 * sourcePath 内；分叉/失败即中止并提示）→ 重建（npm ci|install + build）→ 重接线
 * （pi 重拷、opencode 重写、claude 校验条目在场，缺失则补）→ 更新 install.json
 * 的 rev/updatedAt（installedAt 不变）。
 */
import type { ParsedArgs } from "./args.js"
import { currentRev, installDepsAndBuild } from "./deps.js"
import type { CommandDeps } from "./deps.js"
import { wireHost } from "./hosts.js"
import { readInstallRecord, writeInstallRecord } from "./install-json.js"
import { computePaths } from "./paths.js"

export async function runUpdate(args: ParsedArgs, deps: CommandDeps): Promise<number> {
  void args // update 无自有旗标（dry-run 等由 parseArgs 统一拒绝/忽略）
  const log = deps.log
  let paths
  try {
    paths = computePaths({ HOME: deps.env.HOME })
  } catch (err) {
    log(err instanceof Error ? err.message : String(err))
    return 1
  }

  const record = await readInstallRecord(paths.installJsonFile)
  if (!record.ok) {
    log(`错误：未找到可用安装记录（${paths.installJsonFile}）：${record.error}`)
    log("请先运行 subconscious install。")
    return 1
  }

  const pullCwd = record.record.mode === "git" ? paths.srcDir : record.record.sourcePath
  log(`→ git pull --ff-only（${pullCwd}）`)
  const pull = await deps.exec("git", ["pull", "--ff-only"], { cwd: pullCwd })
  if (pull.code !== 0) {
    log(`✗ 更新失败：git pull --ff-only 退出码 ${pull.code}（本地分叉或非快进可拉取状态）${pull.stderr.trim() ? `：${pull.stderr.trim()}` : ""}`)
    log("提示：进入源码目录处理分叉（git rebase / git reset）后重试；或 subconscious uninstall 后重新 install。接线状态未改动。")
    return 1
  }
  log("✓ 已拉取最新源码")

  if (!(await installDepsAndBuild(record.record.sourcePath, deps))) return 1

  let allWired = true
  for (const host of record.record.hosts) {
    if (!(await wireHost(host, { paths, sourceRoot: record.record.sourcePath, log }))) allWired = false
  }

  const rev = await currentRev(record.record.sourcePath, deps)
  await writeInstallRecord(paths.installJsonFile, { ...record.record, rev, updatedAt: new Date().toISOString() })
  log(`✓ 更新完成（rev ${rev === "" ? "（非 git 源，无 rev）" : rev}）`)
  return allWired ? 0 : 1
}
