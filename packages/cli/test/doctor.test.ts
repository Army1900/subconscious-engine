/**
 * doctor 命令三态测试（全好 / 缺 hook / 缺产物）+ --hosts 过滤 + 宿主 CLI PATH
 * 检查计入结论行（任一失败 exit 1）。全部临时 HOME + 桩 bin。
 */
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePaths } from "../src/paths.js";
import { runInstall } from "../src/install.js";
import { runDoctor } from "../src/doctor.js";
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
const exec = fakeExecutor()

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sc-cli-home-"))
  process.env.HOME = home
  source = await makeFakeSource()
})

afterEach(() => {
  process.env.HOME = undefined
})

async function installAll(): Promise<string[]> {
  const logs: string[] = []
  const binDir = await makeStubBin(["npm", "git", "pi", "claude", "opencode"])
  const code = await runInstall(
    { command: "install", hosts: ["pi", "claude", "opencode"], source, dryRun: false, purgeSource: false, purgeData: false, yes: false },
    { exec, log: (l) => logs.push(l), env: { HOME: home, PATH: binDir } },
  )
  expect(code).toBe(0)
  return logs
}

async function depsWithClis(logs: string[], withClis: boolean): Promise<CommandDeps> {
  const names = withClis ? ["npm", "git", "pi", "claude", "opencode"] : ["npm", "git"]
  const binDir = await makeStubBin(names)
  return { exec, log: (l) => logs.push(l), env: { HOME: home, PATH: binDir } }
}

describe("doctor 三态", () => {
  it("全好：install.json / 三宿主产物与接线 / 宿主 CLI 在 PATH → 全 ✓ exit 0", async () => {
    await installAll()
    const logs: string[] = []
    const code = await runDoctor({ command: "doctor", dryRun: false, purgeSource: false, purgeData: false, yes: false }, await depsWithClis(logs, true))
    expect(code).toBe(0)
    const text = logs.join("\n")
    expect(text).toContain("install.json")
    for (const host of ["pi", "claude", "opencode"]) expect(text).toContain(host)
    expect(text).not.toContain("✗")
  })

  it("缺 hook（删掉 SessionEnd 条目）→ claude 结论行 ✗，exit 1", async () => {
    await installAll()
    const p = computePaths({ HOME: home })
    const settings = JSON.parse(await readFile(p.claudeSettingsFile, "utf8")) as { hooks: Record<string, unknown> }
    delete settings.hooks.SessionEnd
    await writeFile(p.claudeSettingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8")
    const logs: string[] = []
    const code = await runDoctor({ command: "doctor", dryRun: false, purgeSource: false, purgeData: false, yes: false }, await depsWithClis(logs, true))
    expect(code).toBe(1)
    const claudeLine = logs.find((l) => l.includes("claude") && l.includes("✗"))
    expect(claudeLine).toBeDefined()
  })

  it("缺产物（删 claude dist 入口）→ 产物结论行 ✗，exit 1", async () => {
    await installAll()
    await (await import("node:fs/promises")).rm(path.join(source, "packages", "adapter-claude", "dist", "hook-main.js"))
    const logs: string[] = []
    const code = await runDoctor({ command: "doctor", dryRun: false, purgeSource: false, purgeData: false, yes: false }, await depsWithClis(logs, true))
    expect(code).toBe(1)
    expect(logs.some((l) => l.includes("✗") && l.includes("claude") && l.includes("缺失"))).toBe(true)
  })

  it("pi 扩展内容漂移（多余文件）→ 一致性 ✗", async () => {
    await installAll()
    const p = computePaths({ HOME: home })
    await writeFile(path.join(p.piExtensionDir, "drift.js"), "x", "utf8")
    const logs: string[] = []
    const code = await runDoctor({ command: "doctor", dryRun: false, purgeSource: false, purgeData: false, yes: false }, await depsWithClis(logs, true))
    expect(code).toBe(1)
    expect(logs.some((l) => l.includes("pi") && l.includes("✗"))).toBe(true)
  })

  it("宿主 CLI 不在 PATH → 对应结论行 ✗ 计入 exit 1（其余检查仍全好）", async () => {
    await installAll()
    const logs: string[] = []
    const code = await runDoctor({ command: "doctor", dryRun: false, purgeSource: false, purgeData: false, yes: false }, await depsWithClis(logs, false))
    expect(code).toBe(1)
    expect(logs.some((l) => l.includes("PATH") && l.includes("✗"))).toBe(true)
    expect(logs.some((l) => l.includes("install.json") && l.includes("✓"))).toBe(true)
  })

  it("未安装 → install.json ✗ 并退出 1", async () => {
    const logs: string[] = []
    const code = await runDoctor({ command: "doctor", dryRun: false, purgeSource: false, purgeData: false, yes: false }, await depsWithClis(logs, true))
    expect(code).toBe(1)
    expect(logs.join("\n")).toContain("install.json")
  })
})

describe("doctor --hosts 过滤", () => {
  it("只检查指定宿主：claude hook 缺失但 --hosts pi → exit 0", async () => {
    await installAll()
    const p = computePaths({ HOME: home })
    const settings = JSON.parse(await readFile(p.claudeSettingsFile, "utf8")) as { hooks: Record<string, unknown> }
    delete settings.hooks.SessionEnd
    await writeFile(p.claudeSettingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8")
    const logs: string[] = []
    const code = await runDoctor(
      { command: "doctor", hosts: ["pi"], dryRun: false, purgeSource: false, purgeData: false, yes: false },
      await depsWithClis(logs, true),
    )
    expect(code).toBe(0)
    expect(logs.some((l) => l.includes("claude"))).toBe(false)
  })
})
