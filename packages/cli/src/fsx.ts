/**
 * 文件系统工具（node:fs 包装，零依赖）：递归拷贝、树快照（条数 + 逐文件字节数，
 * doctor 的 pi 扩展一致性判据）、原子写（同目录临时文件 + rename）、JSON 读写。
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true })
  await cp(src, dest, { recursive: true })
}

export async function removePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true })
}

export interface TreeSnapshot {
  files: Array<{ rel: string; size: number }>
}

/** 递归收集相对路径 + 字节数（排序确定）；目录不存在 → 空快照（不抛出） */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const files: Array<{ rel: string; size: number }> = []
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = prefix === "" ? entry.name : path.join(prefix, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
      } else if (entry.isFile()) {
        const info = await stat(abs)
        files.push({ rel, size: info.size })
      }
    }
  }
  await walk(root, "")
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files }
}

export function treesEqual(a: TreeSnapshot, b: TreeSnapshot): boolean {
  if (a.files.length !== b.files.length) return false
  return a.files.every((file, i) => {
    const other = b.files[i]
    return other !== undefined && file.rel === other.rel && file.size === other.size
  })
}

/** 原子写：同目录临时文件 + rename（进程中断不会留下半份文件） */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, content, "utf8")
  await rename(tmp, file)
}

/** 两空格缩进 JSON + 结尾换行（与仓库 memory.json/settings.json 排版纪律一致） */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

export type ReadJsonResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** JSON 读取：缺失/损坏 → ok:false 带 error，绝不抛出（调用方决定中止语义） */
export async function readJsonFile<T>(file: string): Promise<ReadJsonResult<T>> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (err) {
    return { ok: false, error: `无法读取 ${file}：${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch (err) {
    return { ok: false, error: `JSON 解析失败 ${file}：${err instanceof Error ? err.message : String(err)}` }
  }
}
