/**
 * subconscious doctor [--hosts …]：逐项检查并输出中文结论行——install.json 在场、
 * 各宿主源构建产物入口存在、pi 扩展目录与源 dist 一致（条数+逐文件字节数）、
 * claude 两条 hook 在场且指向本安装、opencode 插件文件在场且 re-export 路径可解
 * 析、各宿主 CLI 在 PATH。任一 ✗ → exit 1。
 * 检查范围：--hosts 指定；缺省为 install.json 记录的宿主。
 */
import { existsSync } from "node:fs"
import type { ParsedArgs } from "./args.js"
import type { CommandDeps } from "./deps.js"
import { parseHostList } from "./deps.js"
import { isCliOnPath } from "./exec.js"
import { adapterDistEntry, checkHost, HOST_CLI, type HostName } from "./hosts.js"
import { readInstallRecord } from "./install-json.js"
import { computePaths } from "./paths.js"

export async function runDoctor(args: ParsedArgs, deps: CommandDeps): Promise<number> {
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
    log(`✗ install.json：缺失或不可读（${paths.installJsonFile}）`)
    log("无安装记录，其余检查跳过。可先运行 subconscious install。")
    return 1
  }
  const { mode, source, sourcePath, rev, hosts: recorded } = record.record
  log(`✓ install.json：在场（模式 ${mode}，源 ${source}，rev ${rev === "" ? "（非 git 源）" : rev}）`)

  const hostsCheck = parseHostList(args.hosts)
  if (hostsCheck.error !== undefined) {
    log(hostsCheck.error)
    return 1
  }
  const scope: HostName[] = hostsCheck.hosts ?? recorded

  let failed = false

  for (const host of scope) {
    const entry = adapterDistEntry(sourcePath, host)
    const ok = existsSync(entry)
    const detail = ok ? `齐（${entry}）` : `缺失（${entry}）`
    log(`${ok ? "✓" : "✗"} ${host}：源构建产物${detail}`)
    if (!ok) failed = true
  }

  for (const host of scope) {
    const ok = await checkHost(host, { paths, sourceRoot: sourcePath, log })
    const message: Record<HostName, string> = {
      pi: `pi：扩展目录与源 dist ${ok ? "一致（条数+逐文件字节数）" : "不一致"}（${paths.piExtensionDir}）`,
      claude: `claude：settings.json 两条 hook ${ok ? "在场且指向本安装" : "缺失或不完整"}（${paths.claudeSettingsFile}）`,
      opencode: `opencode：插件文件${ok ? "在场且 re-export 路径可解析" : "缺失或 re-export 路径不可解析"}（${paths.opencodePluginFile}）`,
    }
    log(`${ok ? "✓" : "✗"} ${message[host]}`)
    if (!ok) failed = true
  }

  for (const host of scope) {
    const cli = HOST_CLI[host]
    const ok = isCliOnPath(deps.env, cli)
    log(`${ok ? "✓" : "✗"} ${host}：CLI（${cli}）${ok ? "在 PATH" : "不在 PATH"}`)
    if (!ok) failed = true
  }

  return failed ? 1 : 0
}
