/**
 * subconscious uninstall [--hosts …] [--purge-source] [--purge-data --yes]：
 * --hosts 缺省 = install.json 记录的全部宿主。拆接线（pi 删目录 / claude 只删本安
 * 装条目 / opencode 只删指向本安装的文件）；全部宿主拆完且给了 --purge-source 才
 * 删整个安装根 ~/.subconscious-engine/。--purge-data（需 --yes）删用户数据区
 * ~/.subconscious/（memory/grants）——默认绝不碰，删前打印将删路径；拒绝时发生在
 * 任何动作之前。
 */
import type { ParsedArgs } from "./args.js"
import type { CommandDeps } from "./deps.js"
import { parseHostList } from "./deps.js"
import { unwireHost, type HostName } from "./hosts.js"
import { readInstallRecord, writeInstallRecord } from "./install-json.js"
import { computePaths } from "./paths.js"
import { removePath } from "./fsx.js"

export async function runUninstall(args: ParsedArgs, deps: CommandDeps): Promise<number> {
  const log = deps.log
  let paths
  try {
    paths = computePaths({ HOME: deps.env.HOME })
  } catch (err) {
    log(err instanceof Error ? err.message : String(err))
    return 1
  }

  // 拒绝先行：--purge-data 无 --yes 时在任何动作之前退出
  if (args.purgeData && !args.yes) {
    log(`错误：--purge-data 需要 --yes 确认（将删除用户数据区 ${paths.dataDir}，含 memory/grants，不可恢复）。`)
    return 1
  }

  const record = await readInstallRecord(paths.installJsonFile)
  if (!record.ok && !args.purgeSource && !args.purgeData) {
    log(`错误：未找到可用安装记录（${paths.installJsonFile}）：${record.error}`)
    return 1
  }
  if (!record.ok) log(`- 无可用安装记录（${record.error}），仅执行 purge 请求的部分`)

  const hostsCheck = parseHostList(args.hosts)
  if (hostsCheck.error !== undefined) {
    log(hostsCheck.error)
    return 1
  }
  const toRemove: HostName[] = hostsCheck.hosts ?? (record.ok ? record.record.hosts : [])

  const sourceRoot = record.ok ? record.record.sourcePath : ""
  for (const host of toRemove) {
    await unwireHost(host, { paths, sourceRoot, log })
  }

  const remaining = record.ok ? record.record.hosts.filter((h) => !toRemove.includes(h)) : []
  if (!record.ok || remaining.length === 0) {
    if (args.purgeSource) {
      log(`将删除安装根目录：${paths.installRoot}（含 src/install.json/backups）`)
      await removePath(paths.installRoot)
      log(`✓ 已删除 ${paths.installRoot}`)
    } else if (record.ok) {
      await removePath(paths.installJsonFile)
      log(`✓ 已移除安装记录 ${paths.installJsonFile}（源码未删除；如需整体清除：subconscious uninstall --purge-source）`)
    }
  } else {
    await writeInstallRecord(paths.installJsonFile, { ...record.record, hosts: remaining })
    log(`✓ 安装记录已更新（剩余宿主：${remaining.join(" / ")}）`)
    if (args.purgeSource) {
      log(`⚠ --purge-source 未生效：仍有宿主接线（${remaining.join(" / ")}）。全部宿主拆完后才会删除安装根目录。`)
    }
  }

  if (args.purgeData) {
    log(`将删除用户数据区：${paths.dataDir}（memory/grants）`)
    await removePath(paths.dataDir)
    log(`✓ 已删除 ${paths.dataDir}`)
  } else {
    log(`- 用户数据区 ${paths.dataDir}（memory/grants）未改动；如需清除：subconscious uninstall --purge-data --yes`)
  }
  return 0
}
