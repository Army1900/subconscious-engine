#!/usr/bin/env node
/**
 * 依赖契约检查（M1 交付 3）。
 *
 * 规则（监督定界，见 .supervision/task-08.txt 目标 3）：
 * - R1 adapter-pi 的 peerDependencies["@earendil-works/pi-coding-agent"] 必须存在，
 *      且为显式 semver 范围（X.Y.Z / ^X.Y.Z / ~X.Y.Z；禁止 *、latest、空串、别名）；
 * - R2 adapter-pi 的 devDependencies["@earendil-works/pi-coding-agent"] 必须为精确版本
 *      （裸 X.Y.Z，禁止 ^ ~ >= 等 range 修饰、* 、latest）——锁定 fixture/类型所对的实现；
 * - R3 R2 的精确版本必须满足 R1 的 peer 范围（caret/tilde/exact 子集语义自实现）；
 * - R4 core 的 dependencies 每一项必须是显式 semver，禁止 *（core 零宿主依赖红线，
 *      一旦未来引入依赖也只允许显式 semver）。
 *
 * 实现说明：不引入 semver 依赖（工程脚本同样遵循零额外依赖）；允许的语法子集即
 * M1 策略本身，超集（|| 并集、复合比较范围、dist-tag）一律按「非显式 semver」拒绝。
 *
 * 用法：node scripts/check-deps.mjs [--root <dir>]（默认本仓库根；--root 供夹具验证）。
 * 退出码：0 = 全部通过；1 = 存在违规（逐条列出，不隐藏失败）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const DEFAULT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

// ---------------------------------------------------------------------------
// 显式 semver 语法子集（M1 策略即语法）：精确 / caret / tilde，允许 prerelease/build 后缀
// ---------------------------------------------------------------------------
const VERSION_BODY = "\\d+\\.\\d+\\.\\d+(?:[-][0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const EXACT_RE = new RegExp(`^${VERSION_BODY}$`);
const CARET_RE = new RegExp(`^\\^${VERSION_BODY}$`);
const TILDE_RE = new RegExp(`^~${VERSION_BODY}$`);

function isExplicitSemver(spec) {
  return EXACT_RE.test(spec) || CARET_RE.test(spec) || TILDE_RE.test(spec);
}

function isExactSemver(spec) {
  return EXACT_RE.test(spec);
}

function parseTriple(spec) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(spec);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareTriple(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** 精确版本是否满足范围（仅支持本脚本允许的三种语法；prerelease 视为三元组一部分不特殊处理） */
function satisfies(exactSpec, rangeSpec) {
  const exact = parseTriple(exactSpec);
  if (exact === null) return false;
  if (EXACT_RE.test(rangeSpec)) {
    const range = parseTriple(rangeSpec);
    return range !== null && compareTriple(exact, range) === 0;
  }
  const rangeMatch = /^([\^~])/.exec(rangeSpec);
  if (rangeMatch === null) return false;
  const range = parseTriple(rangeSpec.slice(1));
  if (range === null) return false;
  if (compareTriple(exact, range) < 0) return false; // 低于下界
  if (rangeMatch[1] === "~") {
    return exact.major === range.major && exact.minor === range.minor; // ~X.Y.Z := >=X.Y.Z <X.(Y+1).0
  }
  // ^X.Y.Z：major>0 同 major；major=0 同 minor；major=0 且 minor=0 同 patch
  if (range.major > 0) return exact.major === range.major;
  if (range.minor > 0) return exact.major === 0 && exact.minor === range.minor;
  return exact.major === 0 && exact.minor === 0 && exact.patch === range.patch;
}

// ---------------------------------------------------------------------------
// 规则检查
// ---------------------------------------------------------------------------
function readManifest(root, relPath) {
  const file = path.join(root, relPath);
  return { file, pkg: JSON.parse(readFileSync(file, "utf8")) };
}

function checkDependencyContract(root) {
  const results = [];

  const adapter = readManifest(root, "packages/adapter-pi/package.json");
  const core = readManifest(root, "packages/core/package.json");

  // R1：peer 范围显式存在
  const peerRange = adapter.pkg.peerDependencies?.[PI_PACKAGE];
  if (peerRange === undefined) {
    results.push({ rule: "R1", ok: false, message: `adapter-pi peerDependencies 缺少 ${PI_PACKAGE}` });
  } else if (!isExplicitSemver(peerRange)) {
    results.push({ rule: "R1", ok: false, message: `peer ${PI_PACKAGE}="${peerRange}" 不是显式 semver（禁止 * / latest / 空串 / 别名）` });
  } else {
    results.push({ rule: "R1", ok: true, message: `peer ${PI_PACKAGE}="${peerRange}" 为显式 semver 范围` });
  }

  // R2：dev 精确版本
  const devVersion = adapter.pkg.devDependencies?.[PI_PACKAGE];
  if (devVersion === undefined) {
    results.push({ rule: "R2", ok: false, message: `adapter-pi devDependencies 缺少 ${PI_PACKAGE}（需精确锁定）` });
  } else if (!isExactSemver(devVersion)) {
    results.push({ rule: "R2", ok: false, message: `devDependencies ${PI_PACKAGE}="${devVersion}" 不是精确版本（需裸 X.Y.Z，禁止 ^ ~ >= * latest）` });
  } else {
    results.push({ rule: "R2", ok: true, message: `devDependencies ${PI_PACKAGE}="${devVersion}" 为精确版本` });
  }

  // R3：精确 dev 版本满足 peer 范围
  if (typeof peerRange === "string" && isExplicitSemver(peerRange) && isExactSemver(devVersion)) {
    if (satisfies(devVersion, peerRange)) {
      results.push({ rule: "R3", ok: true, message: `${devVersion} 满足 peer 范围 ${peerRange}` });
    } else {
      results.push({ rule: "R3", ok: false, message: `${devVersion} 不满足 peer 范围 ${peerRange}` });
    }
  } else {
    results.push({ rule: "R3", ok: false, message: "R1/R2 未通过，一致性检查无法执行" });
  }

  // R4：core dependencies 全部显式 semver（当前为零依赖，引入任何依赖也须显式）
  const coreDeps = core.pkg.dependencies ?? {};
  const bad = Object.entries(coreDeps).filter(([, spec]) => !isExplicitSemver(spec));
  if (bad.length === 0) {
    const count = Object.keys(coreDeps).length;
    results.push({
      rule: "R4",
      ok: true,
      message: `core dependencies（${count} 项）全部为显式 semver，无 *`,
    });
  } else {
    for (const [name, spec] of bad) {
      results.push({ rule: "R4", ok: false, message: `core dependencies ${name}="${spec}" 不是显式 semver（禁止 * / latest / 空串 / 别名）` });
    }
  }

  return results;
}

function parseArgs(argv) {
  const rootFlag = argv.indexOf("--root");
  if (rootFlag !== -1 && argv[rootFlag + 1] !== undefined) return argv[rootFlag + 1];
  return DEFAULT_ROOT;
}

function main() {
  const root = parseArgs(process.argv.slice(2));
  let results;
  try {
    results = checkDependencyContract(root);
  } catch (err) {
    console.error(`check-deps: 无法读取清单（root=${root}）：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  for (const item of results) console.log(`[${item.rule}] ${item.ok ? "✓" : "✗"} ${item.message}`);
  const failures = results.filter((item) => !item.ok);
  if (failures.length > 0) {
    console.error(`依赖契约检查失败：${failures.length} 项违规（root=${root}）`);
    process.exit(1);
  }
  console.log(`依赖契约检查通过（root=${root}）`);
}

main();
