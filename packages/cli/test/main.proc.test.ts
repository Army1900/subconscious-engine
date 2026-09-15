/**
 * bin 入口真实子进程测试（照 adapter-claude 的 proc 测试形态）：经 dist/main.js
 * 验证 argv 分发、用法错误与退出码；HOME 指向临时目录绝不触真实家目录。
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const main = path.join(pkgRoot, "dist", "main.js")

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function runCli(args: string[], envHome: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [main, ...args], {
      env: { ...process.env, HOME: envHome, PATH: "/usr/bin:/bin" },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8")
    })
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

describe("bin 入口（真实子进程）", () => {
  it("无参数 → 用法错误（含四命令），exit 1", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sc-cli-proc-"))
    const r = await runCli([], home)
    expect(r.code).toBe(1)
    const text = r.stdout + r.stderr
    expect(text).toContain("用法")
    for (const cmd of ["install", "doctor", "update", "uninstall"]) expect(text).toContain(cmd)
  })

  it("未知命令 → exit 1", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sc-cli-proc-"))
    const r = await runCli(["wat"], home)
    expect(r.code).toBe(1)
    expect(r.stdout + r.stderr).toContain("wat")
  })

  it("doctor（空 HOME）→ install.json 缺失结论行，exit 1", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sc-cli-proc-"))
    const r = await runCli(["doctor"], home)
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("install.json")
  })

  it("install 缺 --hosts → 错误并列出宿主，exit 1", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sc-cli-proc-"))
    const r = await runCli(["install"], home)
    expect(r.code).toBe(1)
    const text = r.stdout + r.stderr
    for (const host of ["pi", "claude", "opencode"]) expect(text).toContain(host)
  })
})
