/**
 * 宿主注册表与三宿主接线（install / update 重接线 / uninstall 拆线 / doctor 检查
 * 共用同一套幂等实现）。接线目标形态均经各适配器 README 与 .supervision 锁定文档
 * 核实（2026-09-15）：
 * - pi：`~/.pi/agent/extensions/subconscious/` ← `packages/adapter-pi/dist/*` 全量
 *   重拷（先清空旧目录；一致 = 条数 + 逐文件字节数）；
 * - claude：`~/.claude/settings.json` 追加 UserPromptSubmit(timeout 10) 与
 *   SessionEnd(timeout 60) 两条 command hook，command 含本安装 hook-main.js 绝对
 *   路径即视为已装（写入纪律见 claude-settings.ts）；
 * - opencode：`~/.config/opencode/plugins/subconscious.js` 整文件覆写为一行
 *   re-export（SubconsciousPlugin，指向本安装 plugin.js 绝对路径）。
 */
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { addClaudeHooks, applyClaudeSettings, claudeHooksPresent, removeClaudeHooks } from "./claude-settings.js"
import { atomicWriteFile, copyTree, removePath, snapshotTree, treesEqual } from "./fsx.js"
import type { SubconsciousPaths } from "./paths.js"

export const HOSTS = ["pi", "claude", "opencode"] as const
export type HostName = (typeof HOSTS)[number]

/** 各宿主 CLI 可执行名（doctor / install 提示用 PATH 探测） */
export const HOST_CLI: Record<HostName, string> = { pi: "pi", claude: "claude", opencode: "opencode" }

const ADAPTER: Record<HostName, { pkg: string; entry: string }> = {
  pi: { pkg: "adapter-pi", entry: "index.js" },
  claude: { pkg: "adapter-claude", entry: "hook-main.js" },
  opencode: { pkg: "adapter-opencode", entry: "plugin.js" },
}

export function isHostName(value: string): value is HostName {
  return (HOSTS as readonly string[]).includes(value)
}

export function adapterDistDir(sourceRoot: string, host: HostName): string {
  return path.join(sourceRoot, "packages", ADAPTER[host].pkg, "dist")
}

export function adapterDistEntry(sourceRoot: string, host: HostName): string {
  return path.join(adapterDistDir(sourceRoot, host), ADAPTER[host].entry)
}

/** claude hook 命令引用的 hook-main.js 绝对路径（接线与识别「已装」的唯一锚点） */
export function claudeHookMain(sourceRoot: string): string {
  return adapterDistEntry(sourceRoot, "claude")
}

export function opencodePluginContent(sourceRoot: string): string {
  return `export { SubconsciousPlugin } from "${adapterDistEntry(sourceRoot, "opencode")}";\n`
}

export interface HostIo {
  paths: SubconsciousPaths
  /** 源码根（git 模式 = 安装根/src；link 模式 = 用户指定的绝对路径） */
  sourceRoot: string
  log: (line: string) => void
}

export async function wireHost(host: HostName, io: HostIo): Promise<boolean> {
  switch (host) {
    case "pi": {
      const entry = adapterDistEntry(io.sourceRoot, "pi")
      if (!existsSync(entry)) {
        io.log(`✗ pi：源构建产物缺失（${entry}），请先完成构建`)
        return false
      }
      await removePath(io.paths.piExtensionDir) // 先清空旧目录，杜绝陈旧文件滞留
      await copyTree(adapterDistDir(io.sourceRoot, "pi"), io.paths.piExtensionDir)
      io.log(`✓ pi：扩展已拷贝到 ${io.paths.piExtensionDir}`)
      return true
    }
    case "claude": {
      const hookMain = claudeHookMain(io.sourceRoot)
      if (!existsSync(hookMain)) {
        io.log(`✗ claude：源构建产物缺失（${hookMain}），请先完成构建`)
        return false
      }
      const result = await applyClaudeSettings(io.paths.claudeSettingsFile, io.paths.backupsDir, (value) =>
        addClaudeHooks(value, hookMain),
      )
      if (!result.ok) {
        io.log(`✗ claude：${result.error}`)
        return false
      }
      if (!result.changed) {
        io.log("✓ claude：两条 hook 已在场（幂等跳过）")
        return true
      }
      io.log(`✓ claude：已追加 UserPromptSubmit / SessionEnd hook${result.backup ? `（原文件备份：${result.backup}）` : ""}`)
      return true
    }
    case "opencode": {
      const entry = adapterDistEntry(io.sourceRoot, "opencode")
      if (!existsSync(entry)) {
        io.log(`✗ opencode：源构建产物缺失（${entry}），请先完成构建`)
        return false
      }
      await atomicWriteFile(io.paths.opencodePluginFile, opencodePluginContent(io.sourceRoot))
      io.log(`✓ opencode：插件文件已写入 ${io.paths.opencodePluginFile}`)
      return true
    }
  }
}

export async function unwireHost(host: HostName, io: HostIo): Promise<boolean> {
  switch (host) {
    case "pi": {
      await removePath(io.paths.piExtensionDir)
      io.log(`✓ pi：已移除扩展目录 ${io.paths.piExtensionDir}`)
      return true
    }
    case "claude": {
      if (!existsSync(io.paths.claudeSettingsFile)) {
        io.log("✓ claude：settings.json 不存在，无需清理")
        return true
      }
      const result = await applyClaudeSettings(io.paths.claudeSettingsFile, io.paths.backupsDir, (value) =>
        removeClaudeHooks(value, claudeHookMain(io.sourceRoot)),
      )
      if (!result.ok) {
        io.log(`✗ claude：${result.error}`)
        return false
      }
      io.log(result.changed ? `✓ claude：已移除本安装的 hook 条目${result.backup ? `（原文件备份：${result.backup}）` : ""}` : "✓ claude：无本安装条目，无需清理")
      return true
    }
    case "opencode": {
      const file = io.paths.opencodePluginFile
      if (!existsSync(file)) {
        io.log("✓ opencode：插件文件不存在，无需清理")
        return true
      }
      const text = await readFile(file, "utf8").catch(() => "")
      if (text.includes(adapterDistEntry(io.sourceRoot, "opencode"))) {
        await removePath(file)
        io.log(`✓ opencode：已移除插件文件 ${file}`)
        return true
      }
      io.log(`- opencode：插件文件指向其他安装，未删除（${file}）`)
      return true
    }
  }
}

/** doctor 单宿主检查（不含宿主 CLI PATH 探测，那由命令层按范围汇报） */
export async function checkHost(host: HostName, io: HostIo): Promise<boolean> {
  switch (host) {
    case "pi":
      return treesEqual(
        await snapshotTree(io.paths.piExtensionDir),
        await snapshotTree(adapterDistDir(io.sourceRoot, "pi")),
      )
    case "claude":
      return claudeHooksPresent(io.paths.claudeSettingsFile, claudeHookMain(io.sourceRoot))
    case "opencode": {
      const file = io.paths.opencodePluginFile
      if (!existsSync(file)) return false
      const text = await readFile(file, "utf8").catch(() => "")
      const match = /from\s+"([^"]+)"/.exec(text)
      return match !== null && existsSync(match[1]!)
    }
  }
}
