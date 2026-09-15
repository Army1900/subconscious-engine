/**
 * 参数解析测试：命令名 + 旗标（--hosts/--source/--dry-run/--purge-source/
 * --purge-data/--yes），空格与等号两种取值形态；未知命令/未知旗标/缺值为错误。
 */
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("无参数 → 错误并带用法提示", () => {
    const r = parseArgs([]);
    expect(r.args).toBeUndefined();
    expect(r.error).toContain("用法");
  });

  it("未知命令 → 错误并列出四个命令", () => {
    const r = parseArgs(["frobnicate"]);
    expect(r.error).toContain("frobnicate");
    for (const cmd of ["install", "doctor", "update", "uninstall"]) {
      expect(r.error).toContain(cmd);
    }
  });

  it("install --hosts pi,claude --source /tmp/x --dry-run 全量解析", () => {
    const r = parseArgs(["install", "--hosts", "pi,claude", "--source", "/tmp/x", "--dry-run"]);
    expect(r.error).toBeUndefined();
    expect(r.args?.command).toBe("install");
    expect(r.args?.hosts).toEqual(["pi", "claude"]);
    expect(r.args?.source).toBe("/tmp/x");
    expect(r.args?.dryRun).toBe(true);
    expect(r.args?.purgeSource).toBe(false);
    expect(r.args?.purgeData).toBe(false);
    expect(r.args?.yes).toBe(false);
  });

  it("等号形态与空白容错：--hosts=pi, claude → [pi, claude]", () => {
    const r = parseArgs(["doctor", "--hosts=pi, claude"]);
    expect(r.args?.command).toBe("doctor");
    expect(r.args?.hosts).toEqual(["pi", "claude"]);
  });

  it("hosts 逗号切分后过滤空串", () => {
    const r = parseArgs(["uninstall", "--hosts", "pi,,opencode,"]);
    expect(r.args?.hosts).toEqual(["pi", "opencode"]);
  });

  it("uninstall 的 purge 旗标组合", () => {
    const r = parseArgs(["uninstall", "--purge-source", "--purge-data", "--yes"]);
    expect(r.args?.command).toBe("uninstall");
    expect(r.args?.purgeSource).toBe(true);
    expect(r.args?.purgeData).toBe(true);
    expect(r.args?.yes).toBe(true);
    expect(r.args?.hosts).toBeUndefined();
  });

  it("未知旗标 → 错误", () => {
    const r = parseArgs(["install", "--hosts", "pi", "--nukes"]);
    expect(r.error).toContain("--nukes");
  });

  it("取值旗标缺值 → 错误", () => {
    expect(parseArgs(["install", "--hosts"]).error).toContain("--hosts");
    expect(parseArgs(["install", "--source"]).error).toContain("--source");
  });

  it("布尔旗标不吞后续值：--dry-run 后跟位置无关旗标仍正确", () => {
    const r = parseArgs(["update", "--dry-run"]);
    expect(r.args?.dryRun).toBe(true);
  });
});
