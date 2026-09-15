/**
 * 文件系统工具测试（真实临时目录）：递归拷贝、树快照等价（条数 + 逐文件字节数，
 * doctor 的 pi 扩展一致性判据）、原子写（tmp + rename）、JSON 读写。
 */
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteFile, copyTree, readJsonFile, removePath, snapshotTree, treesEqual, writeJsonAtomic } from "../src/fsx.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe("copyTree / snapshotTree / treesEqual", () => {
  it("递归拷贝保持子目录结构与内容；快照按相对路径排序", async () => {
    const base = await tempDir("sc-cli-fsx-");
    const src = path.join(base, "src");
    await mkdir(path.join(src, "sub"), { recursive: true });
    await writeFile(path.join(src, "index.js"), "entry\n");
    await writeFile(path.join(src, "sub", "child.js"), "child-content\n");
    const dest = path.join(base, "dest");
    await copyTree(src, dest);
    expect(await readFile(path.join(dest, "sub", "child.js"), "utf8")).toBe("child-content\n");
    const a = await snapshotTree(src);
    const b = await snapshotTree(dest);
    expect(a.files.map((f) => f.rel)).toEqual(["index.js", path.join("sub", "child.js")]);
    expect(treesEqual(a, b)).toBe(true);
  });

  it("字节数不同或条数不同 → 不等价（doctor 一致性判据）", async () => {
    const base = await tempDir("sc-cli-fsx-neq-");
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    const c = path.join(base, "c");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await mkdir(c, { recursive: true });
    await writeFile(path.join(a, "x.js"), "1234");
    await writeFile(path.join(b, "x.js"), "12345"); // 同名不同大小
    await writeFile(path.join(c, "x.js"), "1234");
    await writeFile(path.join(c, "extra.js"), "1"); // 多一条
    expect(treesEqual(await snapshotTree(a), await snapshotTree(b))).toBe(false);
    expect(treesEqual(await snapshotTree(a), await snapshotTree(c))).toBe(false);
    expect(treesEqual(await snapshotTree(a), await snapshotTree(a))).toBe(true);
  });

  it("快照目录不存在 → files 为空（不抛出）", async () => {
    const snap = await snapshotTree(path.join(await tempDir("sc-cli-fsx-miss-"), "nope"));
    expect(snap.files).toEqual([]);
  });
});

describe("removePath", () => {
  it("递归删除目录；目标不存在不抛出", async () => {
    const base = await tempDir("sc-cli-fsx-rm-");
    const dir = path.join(base, "victim");
    await mkdir(path.join(dir, "inner"), { recursive: true });
    await writeFile(path.join(dir, "inner", "f"), "x");
    await removePath(dir);
    await removePath(dir); // 幂等
    await expect(readFile(dir, "utf8")).rejects.toThrow();
  });
});

describe("atomicWriteFile / writeJsonAtomic / readJsonFile", () => {
  it("原子写后内容可见且无 .tmp 残留", async () => {
    const base = await tempDir("sc-cli-fsx-atomic-");
    const file = path.join(base, "out.txt");
    await atomicWriteFile(file, "hello");
    expect(await readFile(file, "utf8")).toBe("hello");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(base)).sort()).toEqual(["out.txt"]);
  });

  it("写 JSON：两空格缩进 + 结尾换行；读回往返", async () => {
    const base = await tempDir("sc-cli-fsx-json-");
    const file = path.join(base, "data.json");
    await writeJsonAtomic(file, { a: 1, nested: { b: [1, 2] } });
    const text = await readFile(file, "utf8");
    expect(text).toBe('{\n  "a": 1,\n  "nested": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}\n');
    const r = await readJsonFile(file);
    expect(r.ok).toBe(true);
  });

  it("readJsonFile：缺失与损坏 JSON → ok:false 带 error，绝不抛出", async () => {
    const base = await tempDir("sc-cli-fsx-bad-");
    const missing = await readJsonFile(path.join(base, "no.json"));
    expect(missing.ok).toBe(false);
    const corrupt = path.join(base, "corrupt.json");
    await writeFile(corrupt, "{oops");
    const r = await readJsonFile(corrupt);
    expect(r.ok).toBe(false);
  });

  it("原子写覆盖已有文件（rename 语义）", async () => {
    const base = await tempDir("sc-cli-fsx-over-");
    const file = path.join(base, "f.json");
    await writeFile(file, "old");
    await rename(file, path.join(base, "gone")); // 制造历史文件名碰撞场景
    await atomicWriteFile(file, "new");
    expect(await readFile(file, "utf8")).toBe("new");
  });
});
