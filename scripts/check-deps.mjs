#!/usr/bin/env node
/**
 * 依赖契约检查（M1 交付 3）。
 *
 * 规则（监督定界，见 .supervision/task-08.txt 目标 3；R5 为 M3 增补）：
 * - R1 adapter-pi 的 peerDependencies["@earendil-works/pi-coding-agent"] 必须存在，
 *      且为显式 semver 范围（X.Y.Z / ^X.Y.Z / ~X.Y.Z；禁止 *、latest、空串、别名）；
 * - R2 adapter-pi 的 devDependencies["@earendil-works/pi-coding-agent"] 必须为精确版本
 *      （裸 X.Y.Z，禁止 ^ ~ >= 等 range 修饰、* 、latest）——锁定 fixture/类型所对的实现；
 * - R3 R2 的精确版本必须满足 R1 的 peer 范围（caret/tilde/exact 子集语义自实现）；
 * - R4 core 的 dependencies 每一项必须是显式 semver，禁止 *（core 零宿主依赖红线，
 *      一旦未来引入依赖也只允许显式 semver）。
 * - R5 embedding-local（M3 可选向量包）：
 *      a) peerDependencies["@huggingface/transformers"] 必须存在且为显式 semver；
 *      b) peerDependenciesMeta 必须将其标记为 optional（npm 默认不安装，
 *         未安装用户构建/测试不得失败——fail-open 依赖形态的清单面契约）；
 *      c) core 的 dependencies 不得出现任何 @subconscious/* 包（依赖方向红线：
 *         core 不依赖 adapter / 可选功能包）。
 * - R6 adapter-claude（M4a Claude Code hooks 适配器）：
 *      a) dependencies 恰为 {"@subconscious/core": 显式 semver}——hooks 是协议级
 *         集成，不得引入任何宿主 SDK 运行时依赖；
 *      b) 不得声明 peerDependencies（无宿主包依赖面）；
 *      c) bin["subconscious-claude-hook"] 必须存在且指向 dist（交付物是可执行
 *         hook）。包清单缺失时跳过（--root 夹具根允许旧布局）。
 * - R7 adapter-opencode（M4b OpenCode plugin 适配器）：
 *      a) dependencies 恰为 {"@subconscious/core": 显式 semver}——运行时零宿主
 *         依赖（@opencode-ai/plugin 只允许 type-only import，编译后产物零引用）；
 *      b) peerDependencies["@opencode-ai/plugin"] 必须存在且为显式 semver，且
 *         peerDependenciesMeta 标记 optional（类型包在 OpenCode 宿主内必有、
 *         普通消费者可不装——fail-open 依赖形态的清单面契约，同 R5 形态）；
 *      c) devDependencies["@opencode-ai/plugin"] 必须为精确版本（类型来源锁定
 *         已发布版本，同 R2 纪律）；
 *      d) c 的精确版本必须满足 b 的 peer 范围（同 R3 语义）；
 *      e) exports["./plugin"] 必须存在且 default 指向 dist/（交付物是插件入口
 *         子导出）。包清单缺失时跳过（--root 夹具根允许旧布局）。
 * - R8 适配器 embedding opt-in 形态（硬化轮）：
 *      adapter-pi / adapter-claude / adapter-opencode 的 dependencies 与
 *      peerDependencies 均不得出现 @subconscious/embedding-local——opt-in 只允许
 *      动态 import（运行时结构收窄 + 缺包诚实回退规则检测器），适配器清单
 *      不得因此引入可选功能包依赖（claude/opencode 的「dependencies 恰 core」
 *      由 R6/R7 锁定，本规则补齐 pi 并显式禁止 peer 面扩张）。清单缺失时跳过。
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
const EMBEDDING_LOCAL_PACKAGE = "@subconscious/embedding-local";
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
  const embeddingLocal = readManifest(root, "packages/embedding-local/package.json");
  let adapterClaude = null;
  try {
    adapterClaude = readManifest(root, "packages/adapter-claude/package.json").pkg;
  } catch {
    adapterClaude = null; // 夹具根允许不含该包（R6 为 M4a 增补）
  }
  let adapterOpencode = null;
  try {
    adapterOpencode = readManifest(root, "packages/adapter-opencode/package.json").pkg;
  } catch {
    adapterOpencode = null; // 夹具根允许不含该包（R7 为 M4b 增补）
  }

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

  // R5：embedding-local 的可选向量依赖形态 + core 依赖方向（M3）
  const EMBEDDING_DEP = "@huggingface/transformers";
  const localPeer = embeddingLocal.pkg.peerDependencies?.[EMBEDDING_DEP];
  if (localPeer === undefined) {
    results.push({ rule: "R5", ok: false, message: `embedding-local peerDependencies 缺少 ${EMBEDDING_DEP}` });
  } else if (!isExplicitSemver(localPeer)) {
    results.push({ rule: "R5", ok: false, message: `peer ${EMBEDDING_DEP}="${localPeer}" 不是显式 semver` });
  } else {
    const optionalMeta = embeddingLocal.pkg.peerDependenciesMeta?.[EMBEDDING_DEP]?.optional === true;
    if (!optionalMeta) {
      results.push({ rule: "R5", ok: false, message: `peerDependenciesMeta.${EMBEDDING_DEP}.optional 必须为 true（可选依赖，npm 默认不安装）` });
    } else {
      results.push({ rule: "R5", ok: true, message: `embedding-local peer ${EMBEDDING_DEP}="${localPeer}" 显式 semver 且 optional` });
    }
  }
  const coreInternalDeps = Object.keys(coreDeps).filter((name) => name.startsWith("@subconscious/"));
  if (coreInternalDeps.length === 0) {
    results.push({ rule: "R5", ok: true, message: "core 不依赖任何 @subconscious/* 包（依赖方向红线）" });
  } else {
    for (const name of coreInternalDeps) {
      results.push({ rule: "R5", ok: false, message: `core dependencies 出现 ${name}：core 不得依赖 adapter / 可选功能包` });
    }
  }

  // R6：adapter-claude 依赖方向与交付形态（M4a）
  const CORE_PACKAGE = "@subconscious/core";
  if (adapterClaude === null) {
    results.push({ rule: "R6", ok: true, message: "adapter-claude 清单不存在，跳过（夹具根旧布局）" });
  } else {
    const claudeDeps = adapterClaude.dependencies ?? {};
    const claudeDepNames = Object.keys(claudeDeps);
    const wrongDeps = claudeDepNames.filter((name) => name !== CORE_PACKAGE || !isExplicitSemver(claudeDeps[name]));
    const onlyCore =
      claudeDepNames.length === 1 &&
      claudeDepNames[0] === CORE_PACKAGE &&
      isExplicitSemver(claudeDeps[CORE_PACKAGE]);
    if (claudeDepNames.length === 0 || wrongDeps.length > 0 || !onlyCore) {
      for (const name of wrongDeps) {
        results.push({
          rule: "R6",
          ok: false,
          message: `adapter-claude dependencies ${name}="${claudeDeps[name]}" 非法（只允许 ${CORE_PACKAGE} 且须显式 semver）`,
        });
      }
      if (wrongDeps.length === 0) {
        results.push({
          rule: "R6",
          ok: false,
          message: `adapter-claude dependencies 必须恰为 {"${CORE_PACKAGE}": 显式 semver}（实际 ${JSON.stringify(claudeDeps)}）`,
        });
      }
    } else {
      results.push({
        rule: "R6",
        ok: true,
        message: `adapter-claude dependencies 恰为 ${CORE_PACKAGE}="${claudeDeps[CORE_PACKAGE]}"（协议级集成，无宿主 SDK 运行时依赖）`,
      });
    }
    const peerCount = Object.keys(adapterClaude.peerDependencies ?? {}).length;
    if (peerCount === 0) {
      results.push({ rule: "R6", ok: true, message: "adapter-claude 无 peerDependencies（无宿主包依赖面）" });
    } else {
      results.push({ rule: "R6", ok: false, message: `adapter-claude 声明了 ${peerCount} 项 peerDependencies（hooks 协议级集成不应有宿主包依赖面）` });
    }
    const bin = adapterClaude.bin?.["subconscious-claude-hook"];
    const binNormalized = typeof bin === "string" ? bin.replace(/^\.\//, "") : bin;
    if (typeof binNormalized === "string" && binNormalized.startsWith("dist/")) {
      results.push({ rule: "R6", ok: true, message: `bin subconscious-claude-hook → ${bin}` });
    } else {
      results.push({ rule: "R6", ok: false, message: `bin subconscious-claude-hook 缺失或未指向 dist（实际 ${JSON.stringify(bin)}）` });
    }
  }

  // R7：adapter-opencode 依赖方向、类型锁定与交付形态（M4b）
  const OPENCODE_PLUGIN = "@opencode-ai/plugin";
  if (adapterOpencode === null) {
    results.push({ rule: "R7", ok: true, message: "adapter-opencode 清单不存在，跳过（夹具根旧布局）" });
  } else {
    const ocDeps = adapterOpencode.dependencies ?? {};
    const ocDepNames = Object.keys(ocDeps);
    const ocWrongDeps = ocDepNames.filter((name) => name !== CORE_PACKAGE || !isExplicitSemver(ocDeps[name]));
    const ocOnlyCore =
      ocDepNames.length === 1 && ocDepNames[0] === CORE_PACKAGE && isExplicitSemver(ocDeps[CORE_PACKAGE]);
    if (ocOnlyCore) {
      results.push({
        rule: "R7",
        ok: true,
        message: `adapter-opencode dependencies 恰为 ${CORE_PACKAGE}="${ocDeps[CORE_PACKAGE]}"（运行时零宿主依赖）`,
      });
    } else {
      for (const name of ocWrongDeps) {
        results.push({
          rule: "R7",
          ok: false,
          message: `adapter-opencode dependencies ${name}="${ocDeps[name]}" 非法（只允许 ${CORE_PACKAGE} 且须显式 semver）`,
        });
      }
      if (ocWrongDeps.length === 0) {
        results.push({
          rule: "R7",
          ok: false,
          message: `adapter-opencode dependencies 必须恰为 {"${CORE_PACKAGE}": 显式 semver}（实际 ${JSON.stringify(ocDeps)}）`,
        });
      }
    }
    const ocPeer = adapterOpencode.peerDependencies?.[OPENCODE_PLUGIN];
    const ocPeerOptional = adapterOpencode.peerDependenciesMeta?.[OPENCODE_PLUGIN]?.optional === true;
    if (typeof ocPeer === "string" && isExplicitSemver(ocPeer)) {
      if (ocPeerOptional) {
        results.push({ rule: "R7", ok: true, message: `peer ${OPENCODE_PLUGIN}="${ocPeer}" 显式 semver 且 optional` });
      } else {
        results.push({ rule: "R7", ok: false, message: `peerDependenciesMeta.${OPENCODE_PLUGIN}.optional 必须为 true（类型包可选，普通消费者可不装）` });
      }
    } else {
      results.push({
        rule: "R7",
        ok: false,
        message: `peer ${OPENCODE_PLUGIN}="${String(ocPeer)}" 缺失或不是显式 semver（类型来源须有可核实的 peer 范围）`,
      });
    }
    const ocDev = adapterOpencode.devDependencies?.[OPENCODE_PLUGIN];
    if (typeof ocDev === "string" && isExactSemver(ocDev)) {
      results.push({ rule: "R7", ok: true, message: `devDependencies ${OPENCODE_PLUGIN}="${ocDev}" 为精确版本（类型锁定）` });
      if (typeof ocPeer === "string" && isExplicitSemver(ocPeer)) {
        if (satisfies(ocDev, ocPeer)) {
          results.push({ rule: "R7", ok: true, message: `${ocDev} 满足 peer 范围 ${ocPeer}` });
        } else {
          results.push({ rule: "R7", ok: false, message: `${ocDev} 不满足 peer 范围 ${ocPeer}` });
        }
      }
    } else {
      results.push({
        rule: "R7",
        ok: false,
        message: `devDependencies ${OPENCODE_PLUGIN}="${String(ocDev)}" 不是精确版本（需裸 X.Y.Z，同 R2 纪律）`,
      });
    }
    const pluginExport = adapterOpencode.exports?.["./plugin"];
    const pluginDefault = typeof pluginExport === "object" && pluginExport !== null ? pluginExport.default : pluginExport;
    const pluginNormalized = typeof pluginDefault === "string" ? pluginDefault.replace(/^\.\//, "") : pluginDefault;
    if (typeof pluginNormalized === "string" && pluginNormalized.startsWith("dist/")) {
      results.push({ rule: "R7", ok: true, message: `exports["./plugin"] → ${pluginDefault}` });
    } else {
      results.push({
        rule: "R7",
        ok: false,
        message: `exports["./plugin"] 缺失或 default 未指向 dist（实际 ${JSON.stringify(pluginExport)}）`,
      });
    }
  }

  // R8：适配器 embedding opt-in 只允许动态 import 形态（硬化轮）
  const adapterManifests = [
    ["adapter-pi", adapter.pkg],
    ["adapter-claude", adapterClaude],
    ["adapter-opencode", adapterOpencode],
  ];
  for (const [name, manifest] of adapterManifests) {
    if (manifest === null) {
      results.push({ rule: "R8", ok: true, message: `${name} 清单不存在，跳过（夹具根旧布局）` });
      continue;
    }
    const pkg = manifest;
    const inDeps = Object.prototype.hasOwnProperty.call(pkg.dependencies ?? {}, EMBEDDING_LOCAL_PACKAGE);
    const inPeers = Object.prototype.hasOwnProperty.call(pkg.peerDependencies ?? {}, EMBEDDING_LOCAL_PACKAGE);
    if (inDeps || inPeers) {
      results.push({
        rule: "R8",
        ok: false,
        message: `${name} ${inDeps ? "dependencies" : "peerDependencies"} 出现 ${EMBEDDING_LOCAL_PACKAGE}：embedding opt-in 只允许动态 import（缺包诚实回退规则），适配器清单不得引入可选功能包依赖`,
      });
    } else {
      results.push({ rule: "R8", ok: true, message: `${name} 未声明 ${EMBEDDING_LOCAL_PACKAGE}（opt-in 保持动态 import 形态）` });
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
