/**
 * 路径层测试：全部路径经 env.HOME 每次现算（不缓存、不落模块级状态），HOME 缺失
 * 受控报错。换 HOME 即换全套路径（测试与多用户隔离的全部前提）。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { computePaths } from "../src/paths.js";

describe("computePaths", () => {
  it("默认安装根 ~/.subconscious-engine，src/install.json/backups 各就各位", () => {
    const p = computePaths({ HOME: "/home/u" });
    expect(p.installRoot).toBe(path.join("/home/u", ".subconscious-engine"));
    expect(p.srcDir).toBe(path.join(p.installRoot, "src"));
    expect(p.installJsonFile).toBe(path.join(p.installRoot, "install.json"));
    expect(p.backupsDir).toBe(path.join(p.installRoot, "backups"));
  });

  it("三宿主接线目标路径（pi 扩展目录 / claude 全局 settings / opencode 全局插件）", () => {
    const p = computePaths({ HOME: "/home/u" });
    expect(p.piExtensionDir).toBe(path.join("/home/u", ".pi", "agent", "extensions", "subconscious"));
    expect(p.claudeSettingsFile).toBe(path.join("/home/u", ".claude", "settings.json"));
    expect(p.opencodePluginFile).toBe(path.join("/home/u", ".config", "opencode", "plugins", "subconscious.js"));
  });

  it("用户数据区 ~/.subconscious 独立于安装根（purge-data 才会碰它）", () => {
    const p = computePaths({ HOME: "/home/u" });
    expect(p.dataDir).toBe(path.join("/home/u", ".subconscious"));
    expect(p.dataDir.startsWith(p.installRoot)).toBe(false);
  });

  it("每次现算：同一 env 对象改 HOME 后两次调用结果不同（无缓存）", () => {
    const env = { HOME: "/home/a" };
    const first = computePaths(env).installRoot;
    env.HOME = "/home/b";
    const second = computePaths(env).installRoot;
    expect(first).toBe(path.join("/home/a", ".subconscious-engine"));
    expect(second).toBe(path.join("/home/b", ".subconscious-engine"));
  });

  it("HOME 缺失/空白 → 受控抛错（中文信息）", () => {
    expect(() => computePaths({})).toThrow("HOME");
    expect(() => computePaths({ HOME: "  " })).toThrow("HOME");
  });
});
