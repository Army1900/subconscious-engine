/**
 * update 命令测试：--ff-only 拉取（link 模式在 sourcePath 内同样执行）→ 重建 →
 * 重接线 → install.json 的 rev/updatedAt 更新（installedAt 不变）；pull 失败路径
 * （分叉/非 git）提示且不触碰接线。
 */
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePaths } from "../src/paths.js";
import { runInstall } from "../src/install.js";
import { runUpdate } from "../src/update.js";
import type { Executor } from "../src/exec.js";

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
let binDir: string
const installLogs: string[] = []
const installExec: Executor = async (_command, args) =>
  args[0] === "rev-parse" ? { code: 0, stdout: "rev0001\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sc-cli-home-"))
  process.env.HOME = home
  source = await makeFakeSource()
  binDir = await makeStubBin(["npm", "git"])
  const code = await runInstall(
    { command: "install", hosts: ["pi", "claude", "opencode"], source, dryRun: false, purgeSource: false, purgeData: false, yes: false },
    { exec: installExec, log: (l) => installLogs.push(l), env: { HOME: home, PATH: binDir } },
  )
  expect(code).toBe(0)
})

afterEach(() => {
  process.env.HOME = undefined
})

describe("update：成功路径", () => {
  it("link 模式：git pull --ff-only 在 sourcePath 内 → 重建 → 重接线 → install.json rev/updatedAt 更新且 installedAt 不变", async () => {
    const p = computePaths({ HOME: home })
    const before = JSON.parse(await readFile(p.installJsonFile, "utf8")) as { rev: string; installedAt: string }
    // 模拟漂移：pi 扩展目录塞入垃圾文件（update 应重拷恢复一致）
    await writeFile(path.join(p.piExtensionDir, "stale.js"), "stale", "utf8")
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = []
    const logs: string[] = []
    const updateExec: Executor = async (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts?.cwd })
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "rev0002\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    }
    const code = await runUpdate(
      { command: "update", dryRun: false, purgeSource: false, purgeData: false, yes: false },
      { exec: updateExec, log: (l) => logs.push(l), env: { HOME: home, PATH: binDir } },
    )
    expect(code).toBe(0)
    // pull 语义与 cwd
    const pull = calls.find((c) => c.command === "git" && c.args[0] === "pull")
    expect(pull?.args.join(" ")).toBe("pull --ff-only")
    expect(pull?.cwd).toBe(source)
    // 重建步骤仍在
    expect(calls.some((c) => c.command === "npm" && (c.args[0] === "install" || c.args[0] === "ci"))).toBe(true)
    expect(calls.some((c) => c.command === "npm" && c.args[0] === "run")).toBe(true)
    // pi 重拷恢复一致（垃圾文件消失）
    expect(existsSync(path.join(p.piExtensionDir, "stale.js"))).toBe(false)
    // claude 不重复
    const settings = JSON.parse(await readFile(p.claudeSettingsFile, "utf8")) as { hooks: { UserPromptSubmit: unknown[]; SessionEnd: unknown[] } }
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1)
    expect(settings.hooks.SessionEnd).toHaveLength(1)
    // install.json
    const after = JSON.parse(await readFile(p.installJsonFile, "utf8")) as { rev: string; installedAt: string; updatedAt?: string }
    expect(after.rev).toBe("rev0002")
    expect(after.installedAt).toBe(before.installedAt)
    expect(typeof after.updatedAt).toBe("string")
  })

  it("git 模式：pull 在安装根/src 内执行", async () => {
    const p = computePaths({ HOME: home })
    // 重新以 git 模式安装到同一 HOME 的临时源树（假 clone 物化 fixture）
    const gitHome = await mkdtemp(path.join(tmpdir(), "sc-cli-git-home-"))
    const savedHome = process.env.HOME
    process.env.HOME = gitHome
    try {
      const gitPaths = computePaths({ HOME: gitHome })
      const installGit: Executor = async (command, args) => {
        if (command === "git" && args[0] === "clone") {
          const { cp } = await import("node:fs/promises")
          await cp(source, args[4]!, { recursive: true })
          return { code: 0, stdout: "", stderr: "" }
        }
        if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "g0001\n", stderr: "" }
        return { code: 0, stdout: "", stderr: "" }
      }
      const code = await runInstall(
        { command: "install", hosts: ["pi"], source: "https://example.com/x.git", dryRun: false, purgeSource: false, purgeData: false, yes: false },
        { exec: installGit, log: () => undefined, env: { HOME: gitHome, PATH: binDir } },
      )
      expect(code).toBe(0)
      const calls: Array<{ command: string; args: string[]; cwd?: string }> = []
      const updateExec: Executor = async (command, args, opts) => {
        calls.push({ command, args: [...args], cwd: opts?.cwd })
        return { code: 0, stdout: "g0002\n", stderr: "" }
      }
      const code2 = await runUpdate(
        { command: "update", dryRun: false, purgeSource: false, purgeData: false, yes: false },
        { exec: updateExec, log: () => undefined, env: { HOME: gitHome, PATH: binDir } },
      )
      expect(code2).toBe(0)
      const pull = calls.find((c) => c.command === "git" && c.args[0] === "pull")
      expect(pull?.cwd).toBe(gitPaths.srcDir)
    } finally {
      process.env.HOME = savedHome
      void p
    }
  })
})

describe("update：失败路径", () => {
  it("git pull --ff-only 失败（分叉）→ exit 1 并提示；接线状态未被改动", async () => {
    const p = computePaths({ HOME: home })
    await writeFile(path.join(p.piExtensionDir, "stale.js"), "stale", "utf8")
    const settingsBefore = await readFile(p.claudeSettingsFile, "utf8")
    const logs: string[] = []
    const failExec: Executor = async (command, args) => {
      if (command === "git" && args[0] === "pull") {
        return { code: 1, stdout: "", stderr: "Not possible to fast-forward, aborting." }
      }
      return { code: 0, stdout: "", stderr: "" }
    }
    const code = await runUpdate(
      { command: "update", dryRun: false, purgeSource: false, purgeData: false, yes: false },
      { exec: failExec, log: (l) => logs.push(l), env: { HOME: home, PATH: binDir } },
    )
    expect(code).toBe(1)
    const text = logs.join("\n")
    expect(text).toContain("--ff-only")
    expect(text).toContain("fast-forward") // stderr 原文带回
    // 失败发生在重建/重接线之前：pi 垃圾仍在、settings 字节不变
    expect(existsSync(path.join(p.piExtensionDir, "stale.js"))).toBe(true)
    expect(await readFile(p.claudeSettingsFile, "utf8")).toBe(settingsBefore)
    // install.json 未被更新
    const record = JSON.parse(await readFile(p.installJsonFile, "utf8")) as { rev: string }
    expect(record.rev).toBe("rev0001")
  })

  it("未安装 → exit 1", async () => {
    const emptyHome = await mkdtemp(path.join(tmpdir(), "sc-cli-empty-home-"))
    const savedHome = process.env.HOME
    process.env.HOME = emptyHome
    try {
      const logs: string[] = []
      const code = await runUpdate(
        { command: "update", dryRun: false, purgeSource: false, purgeData: false, yes: false },
        { exec: installExec, log: (l) => logs.push(l), env: { HOME: emptyHome, PATH: binDir } },
      )
      expect(code).toBe(1)
      expect(logs.join("\n")).toContain("install.json")
    } finally {
      process.env.HOME = savedHome
    }
  })
})
