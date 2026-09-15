/**
 * 路径层：全部安装相关路径经 process.env.HOME **每次现算**（绝不缓存）——
 * 测试用临时 HOME 驱动全链、换 HOME 即换全套路径的全部前提。
 *
 * 两个根：
 * - 安装根 `~/.subconscious-engine/`（src 源码树、install.json、backups）；
 * - 用户数据区 `~/.subconscious/`（memory/grants，宿主适配器运行时读写）——
 *   独立于安装根，uninstall 默认绝不碰，只有 --purge-data --yes 才会删除。
 */
import path from "node:path"

export interface PathEnv {
  HOME?: string
}

export interface SubconsciousPaths {
  home: string
  /** 安装根（源码树与安装记录所在） */
  installRoot: string
  /** git 模式克隆目标（link 模式不使用） */
  srcDir: string
  installJsonFile: string
  backupsDir: string
  /** 用户数据区（memory/grants；purge-data 目标） */
  dataDir: string
  /** Claude Code 全局 settings（接线目标） */
  claudeSettingsFile: string
  /** pi 全局扩展目录下的 subconscious 子目录（接线目标） */
  piExtensionDir: string
  /** OpenCode 全局插件文件（接线目标） */
  opencodePluginFile: string
}

export function computePaths(env: PathEnv = process.env): SubconsciousPaths {
  const home = env.HOME?.trim()
  if (home === undefined || home === "") {
    throw new Error("错误：环境变量 HOME 未设置，无法确定安装路径")
  }
  const installRoot = path.join(home, ".subconscious-engine")
  return {
    home,
    installRoot,
    srcDir: path.join(installRoot, "src"),
    installJsonFile: path.join(installRoot, "install.json"),
    backupsDir: path.join(installRoot, "backups"),
    dataDir: path.join(home, ".subconscious"),
    claudeSettingsFile: path.join(home, ".claude", "settings.json"),
    piExtensionDir: path.join(home, ".pi", "agent", "extensions", "subconscious"),
    opencodePluginFile: path.join(home, ".config", "opencode", "plugins", "subconscious.js"),
  }
}
