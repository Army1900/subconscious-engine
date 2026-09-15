/**
 * uninstall 命令测试：拆接线只拆自己的产物、install.json 状态维护、--purge-source
 * 需全部宿主拆完、--purge-data 需 --yes 且删前打印路径、用户数据区默认绝不碰。
 */
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePaths } from "../src/paths.js";
import { runInstall } from "../src/install.js";
import { runUninstall } from "../src/uninstall.js";
import type { CommandDeps } from "../src/deps.js";
import type { Executor } from "../src/exec.js";

function fakeExecutor(): Executor {
  return async (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "deadbeefcafe\n", stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  }
}

async function makeStubBin(names: readonly string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sc-cli-bin-"))
  for (const name of names) {
    const file = path.join(dir, name)
    await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8")
    await chmod(file, 0o755)
  }
  return dir
}

async function makeFakeSource(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sc-cli-src-"))
  await writeFile(path.join(root, "package.json"), "{}", "utf8")
  const dists: Array<[string, string]> = [
    ["adapter-pi", "index.js"],
    ["adapter-pi", "distill-child.js"],
    ["adapter-claude", "hook-main.js"],
    ["adapter-opencode", "plugin.js"],
  ]
  for (const [pkg, entry] of dists) {
    await mkdir(path.join(root, "packages", pkg, "dist"), { recursive: true })
    await writeFile(path.join(root, "packages", pkg, "dist", entry), `// stub ${pkg}/${entry}\n`, "utf8")
  }
  return root
}

let home: string
let source: string
let exec: Executor

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sc-cli-home-"))
  process.env.HOME = home
  source = await makeFakeSource()
  exec = fakeExecutor()
})

afterEach(() => {
  process.env.HOME = undefined
})

async function deps(logs: string[], overrides?: Partial<CommandDeps>): Promise<CommandDeps> {
  const binDir = await makeStubBin(["npm", "git"])
  return { exec, log: (l) => logs.push(l), env: { HOME: home, PATH: binDir }, ...overrides }
}

async function installAll(): Promise<void> {
  const logs: string[] = []
  const code = await runInstall(
    { command: "install", hosts: ["pi", "claude", "opencode"], source, dryRun: false, purgeSource: false, purgeData: false, yes: false },
    await deps(logs),
  )
  expect(code).toBe(0)
}

/** 预置他人条目 + 用户数据，验证 uninstall 的「只拆自己」边界 */
async function seedForeignState(): Promise<void> {
  const p = computePaths({ HOME: home })
  const settings = JSON.parse(await readFile(p.claudeSettingsFile, "utf8")) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ type: string; command: string }> }> }
  }
  settings.hooks.PreToolUse = [{ hooks: [{ type: "command", command: "node /elsewhere/hook.js" }] }]
  await writeFile(p.claudeSettingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8")
  await mkdir(path.join(p.dataDir), { recursive: true })
  await writeFile(path.join(p.dataDir, "memory.json"), '{"version":2,"disambiguation":[],"phrases":[],"conventions":[]}\n', "utf8")
}

describe("uninstall：全部宿主（缺省 = install.json 记录）", () => {
  it("只删自己的产物：claude 只删本安装 hook（他人条目保留）、pi 目录删、opencode 文件删、install.json 移除、src 与用户数据保留", async () => {
    await installAll()
    await seedForeignState()
    const p = computePaths({ HOME: home })
    const logs: string[] = []
    const code = await runUninstall(
      { command: "uninstall", dryRun: false, purgeSource: false, purgeData: false, yes: false },
      await deps(logs),
    )
    expect(code).toBe(0)
    // pi / opencode 产物删除
    expect(existsSync(p.piExtensionDir)).toBe(false)
    expect(existsSync(p.opencodePluginFile)).toBe(false)
    // claude：只剩他人条目，本安装 hook 消失
    const settings = JSON.parse(await readFile(p.claudeSettingsFile, "utf8")) as {
      hooks: { PreToolUse: unknown[]; UserPromptSubmit?: unknown[]; SessionEnd?: unknown[] }
    }
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.UserPromptSubmit).toBeUndefined()
    expect(settings.hooks.SessionEnd).toBeUndefined()
    // install.json 移除；link 源码树原样保留；用户数据区不动
    expect(existsSync(p.installJsonFile)).toBe(false)
    expect(existsSync(path.join(source, "packages", "adapter-pi", "dist", "index.js"))).toBe(true)
    expect(await readFile(path.join(p.dataDir, "memory.json"), "utf8")).toContain('"version":2')
    expect(logs.join("\n")).toContain("memory")
    expect(logs.join("\n")).not.toContain("已删除 " + p.dataDir)
  })
})

describe("uninstall：--purge-source", () => {
  it("全部宿主拆完 + --purge-source → 删除整个安装根（git 模式含 src）", async () => {
    const binDir = await makeStubBin(["npm", "git"])
    const logs: string[] = []
    // git 模式安装（假 clone 材料化）
    const gitExec: Executor = async (command, args, opts) => {
      if (command === "git" && args[0] === "clone") {
        const { cp } = await import("node:fs/promises")
        await cp(source, args[4]!, { recursive: true })
        return { code: 0, stdout: "", stderr: "" }
      }
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "feedface\n", stderr: "" }
      void opts
      return { code: 0, stdout: "", stderr: "" }
    }
    const p = computePaths({ HOME: home })
    const code = await runInstall(
      { command: "install", hosts: ["pi"], source: "https://example.com/x.git", dryRun: false, purgeSource: false, purgeData: false, yes: false },
      { exec: gitExec, log: (l) => logs.push(l), env: { HOME: home, PATH: binDir } },
    )
    expect(code).toBe(0)
    expect(existsSync(p.srcDir)).toBe(true)

    const logs2: string[] = []
    const code2 = await runUninstall(
      { command: "uninstall", purgeSource: true, dryRun: false, purgeData: false, yes: false },
      await deps(logs2),
    )
    expect(code2).toBe(0)
    expect(existsSync(p.installRoot)).toBe(false) // 整目录（含 src/install.json/backups）
  })

  it("部分拆线时 --purge-source 不删安装根（仍有宿主接线）", async () => {
    await installAll()
    const p = computePaths({ HOME: home })
    const logs: string[] = []
    const code = await runUninstall(
      { command: "uninstall", hosts: ["pi"], purgeSource: true, dryRun: false, purgeData: false, yes: false },
      await deps(logs),
    )
    expect(code).toBe(0)
    expect(existsSync(p.installRoot)).toBe(true)
    expect(existsSync(p.installJsonFile)).toBe(true)
    const record = JSON.parse(await readFile(p.installJsonFile, "utf8")) as { hosts: string[] }
    expect(record.hosts).toEqual(["claude", "opencode"])
  })
})

describe("uninstall：--purge-data", () => {
  it("无 --yes → 拒绝且什么都没动", async () => {
    await installAll()
    await seedForeignState()
    const p = computePaths({ HOME: home })
    const settingsBefore = await readFile(p.claudeSettingsFile, "utf8")
    const logs: string[] = []
    const code = await runUninstall(
      { command: "uninstall", purgeData: true, yes: false, dryRun: false, purgeSource: false },
      await deps(logs),
    )
    expect(code).toBe(1)
    expect(logs.join("\n")).toContain("--yes")
    // 拒绝发生在任何动作之前：接线未拆、数据未删
    expect(await readFile(p.claudeSettingsFile, "utf8")).toBe(settingsBefore)
    expect(existsSync(p.piExtensionDir)).toBe(true)
    expect(existsSync(path.join(p.dataDir, "memory.json"))).toBe(true)
  })

  it("--yes → 删前打印将删路径，随后删除 ~/.subconscious", async () => {
    await installAll()
    await seedForeignState()
    const p = computePaths({ HOME: home })
    const logs: string[] = []
    const code = await runUninstall(
      { command: "uninstall", purgeData: true, yes: true, dryRun: false, purgeSource: false },
      await deps(logs),
    )
    expect(code).toBe(0)
    const text = logs.join("\n")
    const idx = text.indexOf(p.dataDir)
    expect(idx).toBeGreaterThanOrEqual(0) // 删除动作前有路径提示
    expect(existsSync(p.dataDir)).toBe(false)
  })
})

describe("uninstall：边界", () => {
  it("未安装（无 install.json）且无 purge 旗标 → 报错退出 1", async () => {
    const logs: string[] = []
    const code = await runUninstall(
      { command: "uninstall", dryRun: false, purgeSource: false, purgeData: false, yes: false },
      await deps(logs),
    )
    expect(code).toBe(1)
    expect(logs.join("\n")).toContain("install.json")
  })

  it("未知宿主名 → 报错", async () => {
    await installAll()
    const logs: string[] = []
    const code = await runUninstall(
      { command: "uninstall", hosts: ["vscode"], dryRun: false, purgeSource: false, purgeData: false, yes: false },
      await deps(logs),
    )
    expect(code).toBe(1)
    expect(logs.join("\n")).toContain("vscode")
  })
})
