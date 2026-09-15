/**
 * 命令行参数解析（纯函数，零依赖）。
 *
 * 形态：`subconscious <install|doctor|update|uninstall> [旗标...]`
 * 取值旗标支持 `--flag value` 与 `--flag=value` 两种写法；hosts 为逗号列表。
 * 解析只负责语法——hosts 合法性（是否在宿主注册表内）由命令层校验并给出
 * 「可用宿主 + CLI 在 PATH 状态」的完整错误文案。
 */

export type CommandName = "install" | "doctor" | "update" | "uninstall"

export const COMMANDS: readonly CommandName[] = ["install", "doctor", "update", "uninstall"]

export interface ParsedArgs {
  command: CommandName
  /** --hosts 逗号列表（原始 token，合法性由命令层校验） */
  hosts?: string[]
  /** --source：git URL 或本地绝对路径 */
  source?: string
  dryRun: boolean
  purgeSource: boolean
  purgeData: boolean
  yes: boolean
}

export interface ParseResult {
  args?: ParsedArgs
  error?: string
}

const VALUE_FLAGS = new Set(["--hosts", "--source"])
const BOOLEAN_FLAGS = new Set(["--dry-run", "--purge-source", "--purge-data", "--yes"])
const USAGE = "用法：subconscious <install|doctor|update|uninstall> [--hosts pi,claude,opencode] [--source <git-url|本地绝对路径>] [--dry-run] [--purge-source] [--purge-data --yes]"

function usageError(detail: string): ParseResult {
  return { error: `${detail}\n${USAGE}` }
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const [command, ...rest] = argv
  if (command === undefined) return usageError("错误：缺少命令")
  if (!(COMMANDS as readonly string[]).includes(command)) {
    return usageError(`错误：未知命令 "${command}"（可用：${COMMANDS.join(" / ")}）`)
  }

  const args: ParsedArgs = {
    command: command as CommandName,
    dryRun: false,
    purgeSource: false,
    purgeData: false,
    yes: false,
  }

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token === undefined) break
    const eq = token.indexOf("=")
    const head = eq === -1 ? token : token.slice(0, eq)
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1)

    if (VALUE_FLAGS.has(head)) {
      const value = inlineValue ?? rest[i + 1]
      if (value === undefined || value === "") return usageError(`错误：${head} 需要一个值`)
      if (inlineValue === undefined) i++
      if (head === "--hosts") {
        args.hosts = value.split(",").map((h) => h.trim()).filter((h) => h !== "")
      } else {
        args.source = value
      }
    } else if (BOOLEAN_FLAGS.has(head)) {
      if (inlineValue !== undefined) return usageError(`错误：${head} 是布尔旗标，不接受值`)
      switch (head) {
        case "--dry-run":
          args.dryRun = true
          break
        case "--purge-source":
          args.purgeSource = true
          break
        case "--purge-data":
          args.purgeData = true
          break
        case "--yes":
          args.yes = true
          break
      }
    } else {
      return usageError(`错误：未知参数 "${token}"`)
    }
  }

  return { args }
}
