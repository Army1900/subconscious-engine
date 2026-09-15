/**
 * 执行器测试：真实执行器经 node -e 验证 stdout/stderr/退出码；PATH 扫描不依赖
 * shell（nodeMajor 供预检用）。npm/git 一律经同一可注入接口，单测注入假实现
 * （见 install/update 测试）。
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isCliOnPath, nodeMajor, realExecutor } from "../src/exec.js";

describe("realExecutor", () => {
  it("成功命令：code 0 + stdout/stderr 捕获", async () => {
    const r = await realExecutor(process.execPath, ["-e", "console.log('out'); console.error('err')"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("out");
    expect(r.stderr).toContain("err");
  });

  it("非零退出码原样带回（不抛出，由调用方判定）", async () => {
    const r = await realExecutor(process.execPath, ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
  });

  it("cwd 生效", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sc-cli-exec-cwd-"));
    const r = await realExecutor(process.execPath, ["-e", "console.log(process.cwd())"], { cwd: dir });
    expect(r.code).toBe(0);
    // macOS 的 /var 是 /private/var 符号链接，子进程 cwd 取 realpath——按 realpath 对比
    const { realpathSync } = await import("node:fs");
    expect(r.stdout.trim()).toBe(realpathSync(dir));
  });
});

describe("isCliOnPath", () => {
  it("PATH 中存在可执行文件 → true；不存在 → false（无 shell 依赖）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sc-cli-path-"));
    const bin = path.join(dir, "fake-cli");
    const env = { PATH: `${dir}${path.delimiter}/usr/bin:/bin` };
    expect(isCliOnPath(env, "nonexistent-cli-xyz")).toBe(false);
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(bin, 0o755);
    expect(isCliOnPath(env, "fake-cli")).toBe(true);
  });

  it("PATH 缺失 → false（不抛出）", () => {
    expect(isCliOnPath({}, "git")).toBe(false);
  });
});

describe("nodeMajor", () => {
  it("返回当前主版本（测试机 node ≥ 22）", () => {
    expect(nodeMajor()).toBeGreaterThanOrEqual(22);
  });
});
