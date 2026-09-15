/**
 * Claude settings.json 写入纪律测试（硬性要求的全部面）：
 * - 合并只追加我们的条目（官方 matcher-group 形态），其余键与条目原样保留；
 * - 幂等：command 含本安装 hook-main.js 绝对路径即视为已装，跳过；
 * - 读失败/JSON 解析失败 → 中止接线，绝不盲写，原文件字节不变；
 * - 写前备份原文件到 backups/claude-settings-<时间戳>.json（一次）；
 * - 原子写 + 2 空格缩进；
 * - 移除只删自己的条目，空数组/空对象键清理。
 */
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_HOOK_EVENTS,
  addClaudeHooks,
  applyClaudeSettings,
  claudeHookCommand,
  collectEventCommands,
  removeClaudeHooks,
} from "../src/claude-settings.js";

const HOOK_MAIN = "/home/u/.subconscious-engine/src/packages/adapter-claude/dist/hook-main.js"

describe("claude 纯合并函数", () => {
  it("空对象 → 两个事件各追加一条 matcher-group 条目（UserPromptSubmit timeout 10 / SessionEnd timeout 60）", () => {
    const r = addClaudeHooks({}, HOOK_MAIN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    type Group = { hooks: Array<{ type: string; command: string; timeout: number }> }
    const data = r.data as { hooks: Record<string, Group[]> }
    expect(r.added.sort()).toEqual(["SessionEnd", "UserPromptSubmit"])
    const submit = data.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]
    expect(submit).toEqual({ type: "command", command: claudeHookCommand(HOOK_MAIN), timeout: 10 })
    const end = data.hooks?.SessionEnd?.[0]?.hooks?.[0]
    expect(end).toEqual({ type: "command", command: claudeHookCommand(HOOK_MAIN), timeout: 60 })
    expect(CLAUDE_HOOK_EVENTS.map((e) => e.event).sort()).toEqual(["SessionEnd", "UserPromptSubmit"])
  })

  it("幂等：已含本安装路径的条目 → 跳过不重复（added 为空，数据不变）", () => {
    const once = addClaudeHooks({}, HOOK_MAIN)
    if (!once.ok) throw new Error("unreachable")
    const twice = addClaudeHooks(once.data, HOOK_MAIN)
    expect(twice.ok).toBe(true)
    if (!twice.ok) return
    expect(twice.added).toEqual([])
    expect(twice.data).toEqual(once.data)
  })

  it("保留无关键与他人条目：只追加，不动其余（含顶层无关键、无关事件、同事件内他人条目）", () => {
    const other = { type: "command", command: "node /elsewhere/hook.js", timeout: 30 }
    const original = {
      model: "opus",
      permissions: { allow: ["Bash"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [other] }],
        UserPromptSubmit: [{ hooks: [other] }],
      },
    }
    const r = addClaudeHooks(original, HOOK_MAIN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as typeof original & { hooks: { SessionEnd: unknown[] } }
    expect(data.model).toBe("opus")
    expect(data.permissions).toEqual({ allow: ["Bash"] })
    expect(data.hooks.PreToolUse).toEqual(original.hooks.PreToolUse)
    const submit = data.hooks.UserPromptSubmit as Array<{ hooks: unknown[] }>
    expect(submit).toHaveLength(2) // 他人条目 + 追加条目
    expect(submit[0]).toEqual(original.hooks.UserPromptSubmit[0])
    expect(data.hooks.SessionEnd).toHaveLength(1)
  })

  it("形状异常 → ok:false 中止（hooks 为数组 / 事件键为字符串 / 根为数组）", () => {
    expect(addClaudeHooks({ hooks: [] }, HOOK_MAIN).ok).toBe(false)
    expect(addClaudeHooks({ hooks: { UserPromptSubmit: "nope" } }, HOOK_MAIN).ok).toBe(false)
    expect(addClaudeHooks([1, 2], HOOK_MAIN).ok).toBe(false)
    expect(addClaudeHooks("string", HOOK_MAIN).ok).toBe(false)
  })

  it("removeClaudeHooks：只删自己的条目；事件数组空 → 删键；hooks 空 → 删 hooks 键；无关全保留", () => {
    const other = { type: "command", command: "node /elsewhere/hook.js", timeout: 30 }
    const withOurs = addClaudeHooks({ model: "opus", hooks: { PreToolUse: [{ hooks: [other] }] } }, HOOK_MAIN)
    if (!withOurs.ok) throw new Error("unreachable")
    const r = removeClaudeHooks(withOurs.data, HOOK_MAIN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.changed).toBe(true)
    expect(r.data).toEqual({ model: "opus", hooks: { PreToolUse: [{ hooks: [other] }] } })

    // 只有我们的条目 → hooks 键整个消失
    const onlyOurs = addClaudeHooks({}, HOOK_MAIN)
    if (!onlyOurs.ok) throw new Error("unreachable")
    const r2 = removeClaudeHooks(onlyOurs.data, HOOK_MAIN)
    expect(r2.ok && r2.data).toEqual({})
  })

  it("removeClaudeHooks：无匹配 → changed:false（不触发写）", () => {
    const r = removeClaudeHooks({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /x/y.js" }] }] } }, HOOK_MAIN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.changed).toBe(false)
  })

  it("collectEventCommands 兼容官方 group 形态与扁平形态（识别已装不挑写法）", () => {
    const value = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "node /a.js" }] },
          { type: "command", command: "node /flat.js" },
          { matcher: "X", hooks: [{ type: "command", command: "node /b.js" }] },
        ],
      },
    }
    expect(collectEventCommands(value, "UserPromptSubmit")).toEqual(["node /a.js", "node /flat.js", "node /b.js"])
  })
})

describe("applyClaudeSettings I/O 纪律", () => {
  async function tempBase(): Promise<{ base: string; settings: string; backups: string }> {
    const base = await mkdtemp(path.join(tmpdir(), "sc-cli-claude-"))
    const settings = path.join(base, "settings.json")
    const backups = path.join(base, "backups")
    return { base, settings, backups }
  }

  it("文件缺失 → 视为空对象创建，无备份产生", async () => {
    const { settings, backups } = await tempBase()
    const r = await applyClaudeSettings(settings, backups, (v) => addClaudeHooks(v, HOOK_MAIN))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.changed).toBe(true)
    expect(r.backup).toBeUndefined()
    const data = JSON.parse(await readFile(settings, "utf8")) as unknown
    expect(addClaudeHooks(data, HOOK_MAIN).ok && (addClaudeHooks(data, HOOK_MAIN) as { added: string[] }).added).toEqual([])
    expect(existsSync(backups)).toBe(false)
  })

  it("已有文件 → 写前备份一次（内容=原文件字节）；写入 2 空格缩进 + 无关键保留", async () => {
    const { settings, backups } = await tempBase()
    const original = '{"model":"opus","hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"node /x.js"}]}]}}'
    await mkdir(path.dirname(settings), { recursive: true })
    await writeFile(settings, original, "utf8")
    const r = await applyClaudeSettings(settings, backups, (v) => addClaudeHooks(v, HOOK_MAIN))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.backup).toBeDefined()
    const backupFiles = await readdir(backups)
    expect(backupFiles).toHaveLength(1)
    expect(backupFiles[0]).toMatch(/^claude-settings-.*\.json$/)
    expect(await readFile(path.join(backups, backupFiles[0]!), "utf8")).toBe(original) // 逐字节
    const text = await readFile(settings, "utf8")
    expect(text).toContain('  "model": "opus"') // 2 空格缩进重排
    expect(text.endsWith("\n")).toBe(true)
    const data = JSON.parse(text) as { model: string }
    expect(data.model).toBe("opus")
  })

  it("损坏 JSON → 中止该宿主接线：不写、不备份、原文件字节不变", async () => {
    const { settings, backups } = await tempBase()
    await mkdir(path.dirname(settings), { recursive: true })
    const corrupt = "{oops!!"
    await writeFile(settings, corrupt, "utf8")
    const r = await applyClaudeSettings(settings, backups, (v) => addClaudeHooks(v, HOOK_MAIN))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("解析")
    expect(await readFile(settings, "utf8")).toBe(corrupt)
    expect(existsSync(backups)).toBe(false)
  })

  it("读权限类失败（目标是目录）→ 中止且不写", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "sc-cli-claude-dir-"))
    const settingsAsDir = path.join(base, "settings.json")
    await mkdir(settingsAsDir, { recursive: true })
    const r = await applyClaudeSettings(settingsAsDir, path.join(base, "backups"), (v) => addClaudeHooks(v, HOOK_MAIN))
    expect(r.ok).toBe(false)
  })

  it("已装（changed:false）→ 不写不备份，原字节不变", async () => {
    const { settings, backups } = await tempBase()
    const r1 = await applyClaudeSettings(settings, backups, (v) => addClaudeHooks(v, HOOK_MAIN))
    expect(r1.ok).toBe(true)
    const before = await readFile(settings, "utf8")
    const r2 = await applyClaudeSettings(settings, backups, (v) => addClaudeHooks(v, HOOK_MAIN))
    expect(r2.ok && r2.changed).toBe(false)
    expect(await readFile(settings, "utf8")).toBe(before)
    // 幂等跳过 → 不产生备份（backups 目录甚至不应被创建）
    expect(existsSync(backups)).toBe(false)
  })
})
