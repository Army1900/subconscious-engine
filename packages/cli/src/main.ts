#!/usr/bin/env node
/**
 * bin 入口（subconscious）：argv 解析 → 四命令分发 → 退出码。
 * 全部输出经 deps.log（stdout）；错误路径退出码 1。
 */
import { parseArgs } from "./args.js"
import { runDoctor } from "./doctor.js"
import { realExecutor } from "./exec.js"
import type { CommandDeps } from "./deps.js"
import { runInstall } from "./install.js"
import { runUninstall } from "./uninstall.js"
import { runUpdate } from "./update.js"

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  const deps: CommandDeps = { exec: realExecutor, log: (line) => console.log(line), env: process.env }
  if (parsed.error !== undefined || parsed.args === undefined) {
    console.error(parsed.error ?? "错误：参数解析失败")
    return 1
  }
  const args = parsed.args
  switch (args.command) {
    case "install":
      return await runInstall(args, deps)
    case "doctor":
      return await runDoctor(args, deps)
    case "update":
      return await runUpdate(args, deps)
    case "uninstall":
      return await runUninstall(args, deps)
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(`错误：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  },
)
