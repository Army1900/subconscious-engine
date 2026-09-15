/**
 * Claude settings.json 写入纪律（安装器的最高风险面，硬性规则全在本模块）：
 *
 * 1. 条目形态以 adapter-claude README「安装」节的官方样例为准——matcher-group
 *    `{"hooks":[{"type":"command","command":…,"timeout":N}]}`；UserPromptSubmit 不
 *    使用 matcher，timeout 单位为秒（10 / 60）。
 * 2. 识别「已装」不挑写法：command 字符串含本安装 hook-main.js 绝对路径即视为
 *    在场（兼容扁平形态与 group 形态），跳过追加——幂等。
 * 3. 合并只追加我们的条目，其余键与条目原样保留；读失败 / JSON 解析失败 /
 *    形状异常 → 中止该宿主接线，绝不盲写，原文件字节不动。
 * 4. 写前把原文件逐字节备份到 backups/claude-settings-<时间戳>.json（仅本次
 *    调用首个写动作备份一次；原文件不存在则无备份）。
 * 5. 原子写（同目录临时文件 + rename），2 空格缩进 + 结尾换行。
 * 6. 移除只删自己的条目；事件数组清空 → 删该键；hooks 对象清空 → 删 hooks 键。
 */
import { existsSync } from "node:fs"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { atomicWriteFile } from "./fsx.js"

export const CLAUDE_HOOK_EVENTS = [
  { event: "UserPromptSubmit", timeout: 10 },
  { event: "SessionEnd", timeout: 60 },
] as const

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number]["event"]

export function claudeHookCommand(hookMainPath: string): string {
  return `node ${hookMainPath}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 深拷贝（settings 只含 JSON 数据；丢引用使合并绝不污染调用方输入） */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 收集某事件数组下的全部 command 字符串（group 形态 + 扁平形态都认） */
export function collectEventCommands(value: unknown, event: string): string[] {
  if (!isPlainObject(value)) return []
  const hooks = value.hooks
  if (!isPlainObject(hooks)) return []
  const entries = hooks[event]
  if (!Array.isArray(entries)) return []
  const commands: string[] = []
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue
    if (Array.isArray(entry.hooks)) {
      for (const hook of entry.hooks) {
        if (isPlainObject(hook) && typeof hook.command === "string") commands.push(hook.command)
      }
    }
    if (typeof entry.command === "string") commands.push(entry.command)
  }
  return commands
}

export type MutateResult = { ok: true; data: unknown; changed: boolean } | { ok: false; error: string }
export type Mutate = (value: unknown) => MutateResult

/** 追加两条 hook（已装事件跳过）；形状异常 → 中止（返回 ok:false，不写） */
export function addClaudeHooks(value: unknown, hookMainPath: string):
  | { ok: true; data: unknown; changed: boolean; added: ClaudeHookEvent[]; skipped: ClaudeHookEvent[] }
  | { ok: false; error: string } {
  if (value === null || value === undefined) value = {}
  if (!isPlainObject(value)) return { ok: false, error: "settings.json 根不是 JSON 对象" }
  const data = deepClone(value)
  if (data.hooks === undefined) data.hooks = {}
  if (!isPlainObject(data.hooks)) return { ok: false, error: "settings.json 的 hooks 不是对象" }
  const hooks = data.hooks as Record<string, unknown>

  const added: ClaudeHookEvent[] = []
  const skipped: ClaudeHookEvent[] = []
  for (const { event, timeout } of CLAUDE_HOOK_EVENTS) {
    if (hooks[event] === undefined) hooks[event] = []
    const entries = hooks[event]
    if (!Array.isArray(entries)) return { ok: false, error: `settings.json 的 hooks.${event} 不是数组` }
    const present = collectEventCommands({ hooks }, event).some((command) => command.includes(hookMainPath))
    if (present) {
      skipped.push(event)
      continue
    }
    entries.push({ hooks: [{ type: "command", command: claudeHookCommand(hookMainPath), timeout }] })
    added.push(event)
  }
  return { ok: true, data, changed: added.length > 0, added, skipped }
}

/** 删除 command 含 hookMainPath 的条目（两条事件全扫）；空数组/空对象键清理 */
export function removeClaudeHooks(value: unknown, hookMainPath: string): MutateResult {
  if (value === null || value === undefined) return { ok: true, data: value, changed: false }
  if (!isPlainObject(value)) return { ok: false, error: "settings.json 根不是 JSON 对象" }
  const data = deepClone(value)
  if (data.hooks === undefined || !isPlainObject(data.hooks)) return { ok: true, data, changed: false }
  const hooks = data.hooks as Record<string, unknown>

  let changed = false
  for (const key of Object.keys(hooks)) {
    const entries = hooks[key]
    if (!Array.isArray(entries)) continue
    let removedHere = false
    const kept: unknown[] = []
    for (const entry of entries) {
      if (!isPlainObject(entry)) {
        kept.push(entry)
        continue
      }
      // 扁平形态：command 直接命中 → 整条删
      if (typeof entry.command === "string" && entry.command.includes(hookMainPath)) {
        removedHere = true
        continue
      }
      // group 形态：过滤内层 hooks；内层清空 → 整组删
      if (Array.isArray(entry.hooks)) {
        const inner = entry.hooks.filter(
          (hook) => !(isPlainObject(hook) && typeof hook.command === "string" && hook.command.includes(hookMainPath)),
        )
        if (inner.length !== entry.hooks.length) {
          removedHere = true
          if (inner.length > 0) kept.push({ ...entry, hooks: inner })
          continue
        }
      }
      kept.push(entry)
    }
    if (removedHere) {
      changed = true
      if (kept.length === 0) delete hooks[key]
      else hooks[key] = kept
    }
  }
  if (changed && Object.keys(hooks).length === 0) delete data.hooks
  return { ok: true, data, changed }
}

function backupStamp(now: () => Date): string {
  return now().toISOString().replace(/[:.]/g, "-")
}

export type ApplyResult =
  | { ok: true; changed: boolean; backup?: string }
  | { ok: false; error: string }

/**
 * 读 → 变换 → （有变更时）备份 + 原子写的完整纪律封装。
 * 读失败（非缺失）/ 解析失败 / mutate 中止 → ok:false，文件系统零改动。
 */
export async function applyClaudeSettings(
  settingsFile: string,
  backupsDir: string,
  mutate: Mutate,
  opts?: { now?: () => Date },
): Promise<ApplyResult> {
  const now = opts?.now ?? (() => new Date())
  let text: string | null = null
  try {
    text = await readFile(settingsFile, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      text = null
    } else {
      return { ok: false, error: `无法读取 ${settingsFile}：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  let value: unknown = undefined
  if (text !== null) {
    try {
      value = JSON.parse(text)
    } catch (err) {
      return {
        ok: false,
        error: `JSON 解析失败 ${settingsFile}：${err instanceof Error ? err.message : String(err)}（已中止，原文件未改动）`,
      }
    }
  }

  const result = mutate(value ?? {})
  if (!result.ok) return { ok: false, error: `${result.error}（已中止，原文件未改动）` }
  if (!result.changed) return { ok: true, changed: false }

  let backup: string | undefined
  if (text !== null) {
    await mkdir(backupsDir, { recursive: true })
    const stamp = backupStamp(now)
    backup = path.join(backupsDir, `claude-settings-${stamp}.json`)
    for (let i = 2; existsSync(backup); i++) {
      backup = path.join(backupsDir, `claude-settings-${stamp}-${i}.json`)
    }
    await writeFile(backup, text, "utf8") // 逐字节原文
  }

  await atomicWriteFile(settingsFile, `${JSON.stringify(result.data, null, 2)}\n`)
  return { ok: true, changed: true, backup }
}

/** doctor 判据：两条 hook 均在场且 command 指向本安装的 hook-main.js */
export async function claudeHooksPresent(settingsFile: string, hookMainPath: string): Promise<boolean> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(settingsFile, "utf8"))
  } catch {
    return false
  }
  return CLAUDE_HOOK_EVENTS.every(({ event }) =>
    collectEventCommands(value, event).some((command) => command.includes(hookMainPath)),
  )
}
