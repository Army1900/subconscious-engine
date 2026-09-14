#!/usr/bin/env node
/**
 * 独立消费者 tarball smoke（硬化轮；docs/ACCEPTANCE「工程」行：包 tarball 独立 consumer）。
 *
 * 做什么：对 core / adapter-claude / adapter-opencode / embedding-local 各执行
 *   npm pack → 在全新临时目录 npm install 四个 tarball → 运行 consumer 脚本做
 *   导入 + 最小功能断言（见 CONSUMER_SCRIPT）。
 *
 * 断言面：
 * - core：createEngine + 无指代 enrich no-op（运行时可用，非仅导入）；
 * - adapter-claude："." 入口导入 + handleUserPromptSubmit 真实注入；bin
 *   dist/hook-main.js 存在于 tarball；
 * - adapter-opencode：未安装 peer（@opencode-ai/plugin）时 "." 与 "./plugin" 子导出
 *   均可导入且 SubconsciousPlugin 可调用（type-only import 编译期擦除的证据）；
 * - embedding-local：未安装可选依赖且模型缺失时 createLocalEmbeddingDetector
 *   fail-open 为规则等价检测器（不抛错）。
 *
 * 离线纪律：四个 tarball 互相满足依赖（core 被其余三者依赖），npm install 不需要
 * registry；脚本把 registry 指向不可达地址，任何意外的联网解析都会立即失败。
 *
 * 边界（诚实声明）：adapter-pi 不在本 smoke 范围——其 peer
 * @earendil-works/pi-coding-agent 非可选，离线安装会因 registry 不可达而失败；
 * pi 的加载验证走仓库内真实 SessionManager fixture 测试与 M1 的最小宿主加载记录。
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["core", "adapter-claude", "adapter-opencode", "embedding-local"];
const UNREACHABLE_REGISTRY = "http://127.0.0.1:9/";

function fail(message) {
  console.error(`pack-smoke: ${message}`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    console.error(result.stdout ?? "");
    console.error(result.stderr ?? "");
    fail(`命令失败：${cmd} ${args.join(" ")}`);
  }
  return result.stdout ?? "";
}

/** 直通子进程输出（断言明细作为验收证据展示） */
function runInherit(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.status !== 0) fail(`命令失败：${cmd} ${args.join(" ")}`);
}

/** consumer 侧断言脚本（在临时目录内以独立进程运行；只依赖已安装的 tarball） */
const CONSUMER_SCRIPT = `
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const results = [];
const step = (name) => { results.push(name); console.log(\`  ✓ \${name}\`); };

// 1. core：引擎构造 + 无指代 no-op（运行时证据，非仅类型/导入）
{
  const { createEngine, DEFAULT_SOURCES, createRuleDetector } = await import("@subconscious/core");
  const engine = createEngine({ sources: DEFAULT_SOURCES });
  const out = await engine.enrich("直接回答就好", {});
  assert.equal(out.context, undefined);
  assert.equal(typeof createRuleDetector, "function");
  step("core: createEngine + 无指代 enrich no-op");
}

// 2. adapter-claude：库式入口 + 真实注入 + bin 交付物
{
  const { handleUserPromptSubmit } = await import("@subconscious/adapter-claude");
  const dir = await mkdtemp(path.join(tmpdir(), "sc-smoke-claude-"));
  await writeFile(path.join(dir, "README.md"), "x", "utf8");
  const noOp = await handleUserPromptSubmit({
    hookEventName: "UserPromptSubmit",
    sessionId: "s",
    transcriptPath: path.join(dir, "t.jsonl"),
    cwd: dir,
    prompt: "直接回答就好",
  });
  assert.equal(noOp, undefined);
  const injected = await handleUserPromptSubmit({
    hookEventName: "UserPromptSubmit",
    sessionId: "s",
    transcriptPath: path.join(dir, "t.jsonl"),
    cwd: dir,
    prompt: "介绍一下这个项目",
  });
  assert.match(injected?.additionalContext ?? "", /\\[潜意识引擎·已解析\\]/);
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@subconscious/adapter-claude");
  await access(path.join(path.dirname(entry), "hook-main.js")); // dist/index.js → dist/hook-main.js
  step("adapter-claude: handleUserPromptSubmit 注入 + bin dist/hook-main.js 存在");
}

// 3. adapter-opencode：未装 peer @opencode-ai/plugin 时 "." 与 "./plugin" 都不抛错
{
  const lib = await import("@subconscious/adapter-opencode");
  assert.equal(typeof lib.createOpenCodeHostEnv, "function");
  const pluginMod = await import("@subconscious/adapter-opencode/plugin");
  assert.equal(typeof pluginMod.SubconsciousPlugin, "function");
  assert.equal(typeof pluginMod.handleChatMessage, "function");
  // 真实注入路径（无 session client，仅 cwd-context）
  const { handleChatMessage } = pluginMod;
  const dir = await mkdtemp(path.join(tmpdir(), "sc-smoke-oc-"));
  await writeFile(path.join(dir, "README.md"), "x", "utf8");
  const parts = [{ type: "text", text: "介绍一下这个项目" }];
  const ok = await handleChatMessage({ sessionID: "s", cwd: dir }, { parts });
  assert.equal(ok, true);
  assert.match(parts[0].text, /\\[潜意识引擎·已解析\\]/);
  step("adapter-opencode: 无 peer 导入 ./plugin + handleChatMessage 注入");
}

// 4. embedding-local：依赖/模型缺失 → 规则等价 fail-open（不抛错）
{
  const { createLocalEmbeddingDetector } = await import("@subconscious/embedding-local");
  const { createRuleDetector } = await import("@subconscious/core");
  const detector = await createLocalEmbeddingDetector({
    modelDir: path.join(tmpdir(), "sc-smoke-不存在的模型目录"),
  });
  const rule = createRuleDetector();
  const prompt = "参考上次的修改，把这个函数改成一样的错误处理";
  assert.deepEqual(detector.detect(prompt), rule.detect(prompt));
  step("embedding-local: 缺依赖/模型 → 规则等价 fail-open");
}

console.log(\`consumer: \${results.length} 项断言全部通过\`);
`;

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), "sc-pack-smoke-"));
  try {
    // 1. npm pack（仓库内完成，不联网）
    const tarballs = [];
    for (const name of PACKAGES) {
      const pkgDir = path.join(ROOT, "packages", name);
      const out = run("npm", ["pack", "--json", "--loglevel=error", "--pack-destination", workDir], { cwd: pkgDir });
      const parsed = JSON.parse(out);
      const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename;
      if (typeof filename !== "string" || filename.length === 0) fail(`npm pack 输出无法解析（${name}）：${out}`);
      tarballs.push(path.join(workDir, filename));
      console.log(`pack: ${name} → ${filename}`);
    }

    // 2. 临时消费者目录：manifest + consumer 脚本
    await writeFile(
      path.join(workDir, "package.json"),
      `${JSON.stringify({ name: "sc-pack-smoke-consumer", private: true, type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(workDir, "consumer.mjs"), CONSUMER_SCRIPT, "utf8");

    // 3. 安装四个 tarball（互相满足依赖；registry 指向不可达地址证明离线）
    const installEnv = {
      ...process.env,
      npm_config_registry: UNREACHABLE_REGISTRY,
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    run("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--loglevel=error", ...tarballs], {
      cwd: workDir,
      env: installEnv,
    });
    console.log("install: 四个 tarball 安装成功（registry 不可达，纯离线解析）");

    // 4. 运行消费者断言
    runInherit("node", ["consumer.mjs"], { cwd: workDir });
    console.log("pack-smoke: 通过（core / adapter-claude / adapter-opencode / embedding-local）");
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
