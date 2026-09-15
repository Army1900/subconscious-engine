/**
 * 安装记录（~/.subconscious-engine/install.json）：install 的产物标记、update 与
 * uninstall 的状态事实源。字段：source（git URL 或本地路径）/ sourcePath（材料化
 * 后的源码根）/ rev（git rev-parse HEAD，非 git 源为空串）/ hosts / installedAt。
 * 读取做形状校验，非法记录按「不可用」处理（doctor / update / uninstall 各自给
 * 出明确错误），绝不带着半份记录继续。
 */
import { readJsonFile, writeJsonAtomic } from "./fsx.js"
import { isHostName, type HostName } from "./hosts.js"

export interface InstallRecord {
  version: 1
  mode: "git" | "link"
  source: string
  sourcePath: string
  rev: string
  hosts: HostName[]
  installedAt: string
  updatedAt?: string
}

export type InstallRecordResult = { ok: true; record: InstallRecord } | { ok: false; error: string }

export async function readInstallRecord(file: string): Promise<InstallRecordResult> {
  const result = await readJsonFile<Record<string, unknown>>(file)
  if (!result.ok) return { ok: false, error: result.error }
  const v = result.value
  const invalid: string[] = []
  if (v.version !== 1) invalid.push("version")
  if (v.mode !== "git" && v.mode !== "link") invalid.push("mode")
  if (typeof v.source !== "string" || v.source === "") invalid.push("source")
  if (typeof v.sourcePath !== "string" || v.sourcePath === "") invalid.push("sourcePath")
  if (typeof v.installedAt !== "string" || v.installedAt === "") invalid.push("installedAt")
  if (!Array.isArray(v.hosts) || v.hosts.length === 0 || !v.hosts.every((h) => isHostName(String(h)))) {
    invalid.push("hosts")
  }
  if (invalid.length > 0) return { ok: false, error: `install.json 字段非法：${invalid.join(", ")}（${file}）` }
  return {
    ok: true,
    record: {
      version: 1,
      mode: v.mode as "git" | "link",
      source: v.source as string,
      sourcePath: v.sourcePath as string,
      rev: typeof v.rev === "string" ? v.rev : "",
      hosts: v.hosts as HostName[],
      installedAt: v.installedAt as string,
      updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : undefined,
    },
  }
}

export async function writeInstallRecord(file: string, record: InstallRecord): Promise<void> {
  await writeJsonAtomic(file, record)
}
