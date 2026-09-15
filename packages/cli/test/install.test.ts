/**
 * install 命令全链测试（假源树 + 假执行器，绝不跑真实 npm ci && npm run build）：
 * dry-run 零写入、link/git 两模式材料化与接线产物、install.json 内容、重复安装
 * 拒绝且状态不变（幂等）、--hosts 校验与预检失败路径。
 */
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecResult, Executor } from "../src/exec.js";
import { computePaths } from "../src/paths.js";
import { runInstall } from "../src/install.js";
import type { CommandDeps } from "../src/deps.js";
import type { ParsedArgs } from "../src/args.js";
import type { InstallRecord } from "../src/install-json.js";

// ---------------------------------------------------------------------------
// 测试基建：临时 HOME、桩 bin、假源树、录制型假执行器
// ---------------------------------------------------------------------------

interface FakeCall {
  command: string
  args: string[]
  cwd?: string
}

function fakeExecutor(handler?: (call: FakeCall) => ExecResult | Promise<ExecResult>): Executor & { calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fn: Executor = async (command, args, opts) => {
    const call = { command, args: [...args], cwd: opts?.cwd }
    calls.push(call)
    if (handler !== undefined) return await handler(call)
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "deadbeefcafe\n", stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  }
  return Object.assign(fn, { calls })
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

async function makeFakeSource(withLock: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sc-cli-src-"))
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "subconscious-engine-fixture", private: true }), "utf8")
  if (withLock) await writeFile(path.join(root, "package-lock.json"), "{\n}\n", "utf8")
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

interface Ctx {
  home: string
  source: string
  logs: string[]
  calls: FakeCall[]
  exec: Executor & { calls: FakeCall[] }
  deps: (overrides?: Partial<CommandDeps>) => CommandDeps
  args: (over?: Partial<ParsedArgs>) => ParsedArgs
}

let ctx: Ctx

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "sc-cli-home-"))
  process.env.HOME = home
  const source = await makeFakeSource(false)
  const binDir = await makeStubBin(["npm", "git"])
  const logs: string[] = []
  const exec = fakeExecutor()
  ctx = {
    home,
    source,
    logs,
    calls: exec.calls,
    exec,
    deps: (overrides) => ({ exec, log: (l) => logs.push(l), env: { HOME: home, PATH: binDir }, ...overrides }),
    args: (over) =>
      ({ command: "install", hosts: ["pi", "claude", "opencode"], source, dryRun: false, purgeSource: false, purgeData: false, yes: false, ...over }) as ParsedArgs,
  }
})

afterEach(() => {
  process.env.HOME = undefined
})

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

describe("install：--dry-run", () => {
  it("打印每一步计划后退出 0，零写入（无安装根/接线目标/install.json）", async () => {
    const code = await runInstall(ctx.args({ dryRun: true }), ctx.deps())
    expect(code).toBe(0)
    const text = ctx.logs.join("\n")
    expect(text).toContain("dry-run")
    expect(text).toContain("link") // link 模式（不 clone）
    expect(text).toContain("npm install")
    expect(text).toContain("npm run build")
    expect(text).toContain("pi")
    expect(text).toContain("settings.json")
    expect(text).toContain("subconscious.js")
    const p = computePaths({ HOME: ctx.home })
    expect(existsSync(p.installRoot)).toBe(false)
    expect(existsSync(p.installJsonFile)).toBe(false)
    expect(existsSync(p.piExtensionDir)).toBe(false)
    expect(existsSync(p.claudeSettingsFile)).toBe(false)
    expect(existsSync(p.opencodePluginFile)).toBe(false)
    expect(ctx.calls).toHaveLength(0) // 不执行任何外部命令
  })
})

describe("install：link 模式（本地绝对路径，原地构建）", () => {
  it("三宿主接线产物 + install.json 内容 + 执行序列（无 clone）", async () => {
    const code = await runInstall(ctx.args(), ctx.deps())
    expect(code).toBe(0)
    const p = computePaths({ HOME: ctx.home })

    // pi：dist/* 拷入扩展目录
    expect(await readFile(path.join(p.piExtensionDir, "index.js"), "utf8")).toContain("stub adapter-pi/index.js")
    expect(existsSync(path.join(p.piExtensionDir, "distill-child.js"))).toBe(true)

    // claude：两条 hook 指向 link 源
    const settings = JSON.parse(await readFile(p.claudeSettingsFile, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }> | undefined>
    }
    const expectedCommand = `node ${path.join(ctx.source, "packages", "adapter-claude", "dist", "hook-main.js")}`
    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(expectedCommand)
    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.timeout).toBe(10)
    expect(settings.hooks?.SessionEnd?.[0]?.hooks[0]?.command).toBe(expectedCommand)
    expect(settings.hooks?.SessionEnd?.[0]?.hooks[0]?.timeout).toBe(60)

    // opencode：插件文件指向 link 源
    const plugin = await readFile(p.opencodePluginFile, "utf8")
    expect(plugin).toBe(`export { SubconsciousPlugin } from "${path.join(ctx.source, "packages", "adapter-opencode", "dist", "plugin.js")}";\n`)

    // install.json
    const record = JSON.parse(await readFile(p.installJsonFile, "utf8")) as InstallRecord
    expect(record.mode).toBe("link")
    expect(record.source).toBe(ctx.source)
    expect(record.sourcePath).toBe(ctx.source)
    expect(record.rev).toBe("deadbeefcafe")
    expect(record.hosts).toEqual(["pi", "claude", "opencode"])
    expect(typeof record.installedAt).toBe("string")

    // 执行序列：无 clone；无 lock → npm install；build；rev-parse 在源内
    const commands = ctx.calls.map((c) => `${c.command} ${c.args.join(" ")}`)
    expect(commands.some((c) => c.startsWith("git clone"))).toBe(false)
    expect(commands).toContain("npm install")
    expect(commands).toContain("npm run build")
    expect(ctx.calls.find((c) => c.command === "npm")?.cwd).toBe(ctx.source)
    expect(ctx.calls.find((c) => c.args[0] === "rev-parse")?.cwd).toBe(ctx.source)
  })

  it("重复 install：拒绝并提示用 update，且状态不变（hook 不重复、pi 拷贝等价）", async () => {
    await runInstall(ctx.args(), ctx.deps())
    const p = computePaths({ HOME: ctx.home })
    const before = await readFile(p.claudeSettingsFile, "utf8")
    const logs2: string[] = []
    const code = await runInstall(ctx.args(), ctx.deps({ log: (l) => logs2.push(l) }))
    expect(code).toBe(1)
    expect(logs2.join("\n")).toContain("update")
    expect(await readFile(p.claudeSettingsFile, "utf8")).toBe(before) // 字节不变 = hook 未重复
    const settings = JSON.parse(before) as { hooks: Record<string, unknown[]> }
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1)
    expect(settings.hooks.SessionEnd).toHaveLength(1)
    expect(await readFile(path.join(p.piExtensionDir, "index.js"), "utf8")).toContain("stub adapter-pi/index.js")
  })
})

describe("install：git 模式（clone --depth 1 到安装根/src）", () => {
  function gitHandler(fixture: string) {
    return async (call: FakeCall): Promise<ExecResult> => {
      if (call.command === "git" && call.args[0] === "clone") {
        // 假 clone：把 fixture 材料化到目标目录（真实 clone 的桩等价物）
        const { cp } = await import("node:fs/promises")
        await cp(fixture, call.args[4]!, { recursive: true })
        return { code: 0, stdout: "", stderr: "" }
      }
      if (call.command === "git" && call.args[0] === "rev-parse") return { code: 0, stdout: "feedface0000\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    }
  }

  it("clone → npm ci（有 lock）→ build → 接线指向安装根/src → install.json mode git", async () => {
    const withLock = await makeFakeSource(true)
    const p = computePaths({ HOME: ctx.home })
    const gitExec = fakeExecutor(gitHandler(withLock))
    const code = await runInstall(
      ctx.args({ source: "https://github.com/Army1900/subconscious-engine.git" }),
      ctx.deps({ exec: gitExec }),
    )
    expect(code).toBe(0)

    // 执行序列：clone --depth 1 到安装根/src；有 lock → npm ci
    const commands = gitExec.calls.map((c) => `${c.command} ${c.args.join(" ")}`)
    expect(commands).toContain("git clone --depth 1 https://github.com/Army1900/subconscious-engine.git " + p.srcDir)
    expect(commands).toContain("npm ci")
    expect(commands).toContain("npm run build")
    expect(gitExec.calls.find((c) => c.command === "npm")?.cwd).toBe(p.srcDir)

    const settings = JSON.parse(await readFile(p.claudeSettingsFile, "utf8")) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> }
    }
    expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(
      `node ${path.join(p.srcDir, "packages", "adapter-claude", "dist", "hook-main.js")}`,
    )
    const record = JSON.parse(await readFile(p.installJsonFile, "utf8")) as InstallRecord
    expect(record.mode).toBe("git")
    expect(record.source).toBe("https://github.com/Army1900/subconscious-engine.git")
    expect(record.sourcePath).toBe(p.srcDir)
    expect(record.rev).toBe("feedface0000")
  })

  it("默认 --source 即官方仓库 URL（缺省 clone 模式）", async () => {
    const withLock = await makeFakeSource(false)
    const p = computePaths({ HOME: ctx.home })
    const code = await runInstall(ctx.args({ source: undefined }), ctx.deps({ exec: fakeExecutor(gitHandler(withLock)) }))
    expect(code).toBe(0)
    const record = JSON.parse(await readFile(p.installJsonFile, "utf8")) as InstallRecord
    expect(record.mode).toBe("git")
    expect(record.source).toBe("https://github.com/Army1900/subconscious-engine.git")
  })

  it("src 目录已存在但无 install.json（无标记）→ 拒绝并提示", async () => {
    const p = computePaths({ HOME: ctx.home })
    await mkdir(p.srcDir, { recursive: true })
    const logs: string[] = []
    const code = await runInstall(
      ctx.args({ source: "https://example.com/x.git" }),
      ctx.deps({ log: (l) => logs.push(l) }),
    )
    expect(code).toBe(1)
    expect(logs.join("\n")).toContain("src")
  })
})

describe("install：参数与预检失败路径", () => {
  it("--hosts 缺省 → 报错并列出可用宿主与各宿主 CLI 的 PATH 状态（不执行任何步骤）", async () => {
    const logs: string[] = []
    const code = await runInstall(ctx.args({ hosts: undefined }), ctx.deps({ log: (l) => logs.push(l) }))
    expect(code).toBe(1)
    const text = logs.join("\n")
    for (const host of ["pi", "claude", "opencode"]) expect(text).toContain(host)
    expect(text).toContain("PATH")
    expect(ctx.calls).toHaveLength(0)
  })

  it("空 hosts 列表同样视为缺省报错", async () => {
    const code = await runInstall(ctx.args({ hosts: [] }), ctx.deps())
    expect(code).toBe(1)
  })

  it("未知宿主名 → 报错并列出合法名", async () => {
    const logs: string[] = []
    const code = await runInstall(ctx.args({ hosts: ["pi", "vscode"] }), ctx.deps({ log: (l) => logs.push(l) }))
    expect(code).toBe(1)
    const text = logs.join("\n")
    expect(text).toContain("vscode")
    expect(text).toContain("claude")
  })

  it("node < 22 → 预检拒绝", async () => {
    const logs: string[] = []
    const code = await runInstall(ctx.args(), ctx.deps({ log: (l) => logs.push(l), nodeMajor: () => 18 }))
    expect(code).toBe(1)
    expect(logs.join("\n")).toContain("node")
    expect(ctx.calls).toHaveLength(0)
  })

  it("git 模式 npm/git 不在 PATH → 预检拒绝", async () => {
    const emptyBin = await mkdtemp(path.join(tmpdir(), "sc-cli-emptybin-"))
    const logs: string[] = []
    const code = await runInstall(
      ctx.args({ source: "https://example.com/x.git" }),
      ctx.deps({ log: (l) => logs.push(l), env: { HOME: ctx.home, PATH: emptyBin } }),
    )
    expect(code).toBe(1)
    const text = logs.join("\n")
    expect(text).toContain("npm")
    expect(text).toContain("git")
  })

  it("link 源路径不存在 → 拒绝", async () => {
    const logs: string[] = []
    const code = await runInstall(ctx.args({ source: "/definitely/not/here" }), ctx.deps({ log: (l) => logs.push(l) }))
    expect(code).toBe(1)
    expect(ctx.calls).toHaveLength(0)
  })
})
