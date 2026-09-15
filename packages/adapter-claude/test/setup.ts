/**
 * 测试密闭性（M5b 记忆接线后必需）：本包任何未显式注入 env 的用例（含 spawn 真实
 * dist/hook-main.js 的 proc 用例——子进程继承 vitest 进程 env）一律把
 * SUBCONSCIOUS_MEMORY_FILE 钉到不存在的临时路径：缺失文件 fail-open 为空记忆 =
 * 接线前基线行为。绝不读真实 ~/.subconscious（否则开发机上的真实先验/词条会让
 * 断言随环境漂移）。需要真实记忆文件的用例在自身用例内显式注入 deps.env。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "sc-claude-test-home-"));
process.env.SUBCONSCIOUS_MEMORY_FILE = path.join(dir, "memory.json");
