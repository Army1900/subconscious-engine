/**
 * 三宿主接线模块测试（真实临时目录 + 临时 HOME）：pi 全量重拷与一致性判据、
 * opencode 整文件覆写与 re-export 路径可解析、claude 经 settings 模块（细节见
 * claude-settings.test.ts，此处只测接线入口）；unwire 只拆自己的产物。
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePaths } from "../src/paths.js";
import {
  HOSTS,
  adapterDistEntry,
  claudeHookMain,
  isHostName,
  opencodePluginContent,
  unwireHost,
  wireHost,
  checkHost,
} from "../src/hosts.js";

let home: string
let sourceRoot: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sc-cli-wire-home-"))
  process.env.HOME = home
  sourceRoot = await mkdtemp(path.join(tmpdir(), "sc-cli-wire-src-"))
  // 假源树：三适配器 dist 桩文件
  for (const pkg of ["adapter-pi", "adapter-claude", "adapter-opencode"]) {
    await mkdir(path.join(sourceRoot, "packages", pkg, "dist"), { recursive: true })
  }
  await writeFile(path.join(sourceRoot, "packages", "adapter-pi", "dist", "index.js"), "pi-entry\n")
  await writeFile(path.join(sourceRoot, "packages", "adapter-pi", "dist", "distill-child.js"), "pi-child\n")
  await writeFile(path.join(sourceRoot, "packages", "adapter-claude", "dist", "hook-main.js"), "claude-entry\n")
  await writeFile(path.join(sourceRoot, "packages", "adapter-opencode", "dist", "plugin.js"), "oc-plugin\n")
})

afterEach(() => {
  process.env.HOME = undefined
})

function io() {
  return { paths: computePaths(), sourceRoot, log: () => undefined }
}

describe("注册表与派生路径", () => {
  it("HOSTS 恰为 pi/claude/opencode；isHostName 判定；dist 入口映射", () => {
    expect([...HOSTS]).toEqual(["pi", "claude", "opencode"])
    expect(isHostName("pi")).toBe(true)
    expect(isHostName("vscode")).toBe(false)
    expect(adapterDistEntry(sourceRoot, "pi")).toBe(
      path.join(sourceRoot, "packages", "adapter-pi", "dist", "index.js"),
    )
    expect(adapterDistEntry(sourceRoot, "claude")).toBe(
      path.join(sourceRoot, "packages", "adapter-claude", "dist", "hook-main.js"),
    )
    expect(adapterDistEntry(sourceRoot, "opencode")).toBe(
      path.join(sourceRoot, "packages", "adapter-opencode", "dist", "plugin.js"),
    )
    expect(claudeHookMain(sourceRoot)).toBe(adapterDistEntry(sourceRoot, "claude"))
  })
})

describe("pi 接线", () => {
  it("wire：dist/* 全量拷入 ~/.pi/agent/extensions/subconscious/（含子目录文件）", async () => {
    await expect(wireHost("pi", io())).resolves.toBe(true)
    const dir = computePaths().piExtensionDir
    expect(await readFile(path.join(dir, "index.js"), "utf8")).toBe("pi-entry\n")
    expect(await readFile(path.join(dir, "distill-child.js"), "utf8")).toBe("pi-child\n")
    await expect(checkHost("pi", io())).resolves.toBe(true)
  })

  it("wire 幂等重拷：目标已有旧垃圾 → 先清空再拷贝（旧文件消失）", async () => {
    const dir = computePaths().piExtensionDir
    await mkdir(path.join(dir, "legacy"), { recursive: true })
    await writeFile(path.join(dir, "legacy", "old.js"), "old")
    await writeFile(path.join(dir, "stale.js"), "stale")
    await expect(wireHost("pi", io())).resolves.toBe(true)
    expect(existsSync(path.join(dir, "stale.js"))).toBe(false)
    expect(existsSync(path.join(dir, "legacy"))).toBe(false)
    await expect(checkHost("pi", io())).resolves.toBe(true)
  })

  it("check：内容漂移（字节数变化/缺文件）→ false", async () => {
    await wireHost("pi", io())
    const dir = computePaths().piExtensionDir
    await writeFile(path.join(dir, "index.js"), "pi-entry-v2-longer\n")
    await expect(checkHost("pi", io())).resolves.toBe(false)
    await writeFile(path.join(dir, "index.js"), "pi-entry\n")
    await expect(checkHost("pi", io())).resolves.toBe(true)
    await writeFile(path.join(dir, "distill-child.js"), "x")
    await expect(checkHost("pi", io())).resolves.toBe(false)
  })

  it("源 dist 缺失 → wire 失败（不产生半拷贝目标）", async () => {
    await (await import("node:fs/promises")).rm(path.join(sourceRoot, "packages", "adapter-pi", "dist"), { recursive: true })
    await expect(wireHost("pi", io())).resolves.toBe(false)
    expect(existsSync(computePaths().piExtensionDir)).toBe(false)
  })

  it("unwire：扩展目录被删除", async () => {
    await wireHost("pi", io())
    await expect(unwireHost("pi", io())).resolves.toBe(true)
    expect(existsSync(computePaths().piExtensionDir)).toBe(false)
  })
})

describe("opencode 接线", () => {
  it("wire：整文件覆写为精确 re-export 行", async () => {
    await expect(wireHost("opencode", io())).resolves.toBe(true)
    const file = computePaths().opencodePluginFile
    expect(await readFile(file, "utf8")).toBe(
      `export { SubconsciousPlugin } from "${path.join(sourceRoot, "packages", "adapter-opencode", "dist", "plugin.js")}";\n`,
    )
    expect(opencodePluginContent(sourceRoot)).toContain("SubconsciousPlugin")
    await expect(checkHost("opencode", io())).resolves.toBe(true)
  })

  it("wire 幂等：重跑内容一致（覆写而非追加）", async () => {
    await wireHost("opencode", io())
    const file = computePaths().opencodePluginFile
    const first = await readFile(file, "utf8")
    await wireHost("opencode", io())
    expect(await readFile(file, "utf8")).toBe(first)
  })

  it("check：文件指向不存在的 plugin.js → false", async () => {
    await wireHost("opencode", io())
    const file = computePaths().opencodePluginFile
    await writeFile(file, 'export { SubconsciousPlugin } from "/gone/packages/adapter-opencode/dist/plugin.js";\n')
    await expect(checkHost("opencode", io())).resolves.toBe(false)
  })

  it("unwire：只删含本安装路径的文件；指向别处的文件不动", async () => {
    await wireHost("opencode", io())
    await expect(unwireHost("opencode", io())).resolves.toBe(true)
    expect(existsSync(computePaths().opencodePluginFile)).toBe(false)
    // 别人的文件
    const foreign = computePaths().opencodePluginFile
    await mkdir(path.dirname(foreign), { recursive: true })
    await writeFile(foreign, 'export { SubconsciousPlugin } from "/other/dist/plugin.js";\n')
    await expect(unwireHost("opencode", io())).resolves.toBe(true)
    expect(existsSync(foreign)).toBe(true)
  })
})

describe("claude 接线入口", () => {
  it("wire → settings 两条 hook 指向安装源；check 通过；再 wire 幂等", async () => {
    await expect(wireHost("claude", io())).resolves.toBe(true)
    await expect(checkHost("claude", io())).resolves.toBe(true)
    await expect(wireHost("claude", io())).resolves.toBe(true)
    const data = JSON.parse(await readFile(computePaths().claudeSettingsFile, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(data.hooks.UserPromptSubmit).toHaveLength(1)
    expect(data.hooks.SessionEnd).toHaveLength(1)
  })

  it("损坏 settings → wire 失败中止，原文件不变", async () => {
    const file = computePaths().claudeSettingsFile
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "{broken", "utf8")
    await expect(wireHost("claude", io())).resolves.toBe(false)
    expect(await readFile(file, "utf8")).toBe("{broken")
  })

  it("unwire：移除本安装条目（无关保留）", async () => {
    await wireHost("claude", io())
    await expect(unwireHost("claude", io())).resolves.toBe(true)
    expect(existsSync(computePaths().claudeSettingsFile)).toBe(true) // 文件保留（可能还有他人内容）
    const text = await readFile(computePaths().claudeSettingsFile, "utf8")
    expect(text).toBe("{}\n")
    await expect(checkHost("claude", io())).resolves.toBe(false)
  })
})
