/**
 * 测试密闭性：本包全部安装路径经 process.env.HOME 每次现算（不缓存），setup 先把
 * HOME 钉到不存在的临时目录兜底——任何忘记在用例内自设 HOME 的代码也不会触碰真实
 * ~/.subconscious-engine / ~/.claude / ~/.pi / ~/.config/opencode / ~/.subconscious。
 * 需要具体 HOME 的用例在自身 beforeEach 内显式再设。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "sc-cli-test-home-"));
process.env.HOME = dir;
