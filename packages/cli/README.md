# @subconscious/cli

subconscious 独立安装器 CLI（bin：`subconscious`，**零运行时依赖**，只需 Node ≥22）：
把 subconscious-engine 源码安装为**用户级全局接线**，install / doctor / update /
uninstall 一步到位。独立于任何宿主产品（如 hi-agi）——只读写用户家目录（安装根
`~/.subconscious-engine/` 与三宿主全局接线点），本仓库不因此新增任何对外耦合。
决策记录见 `docs/DECISIONS.md` D27。

## 用法

```sh
# 从官方仓库安装并接线（--hosts 必填：接线宿主必须显式指定）
subconscious install --hosts pi,claude,opencode
# 开发者 link 模式：不 clone、原地构建、接线指向该工作副本
subconscious install --hosts pi --source /path/to/subconscious-engine
# 只看将执行的每一步（含配置 diff 预览），零写入
subconscious install --hosts pi,claude,opencode --dry-run

subconscious doctor            # 逐项检查（可 --hosts 过滤），任一失败 exit 1
subconscious update            # git pull --ff-only → 重建 → 重接线 → 更新 install.json
subconscious uninstall         # 拆接线（--hosts 缺省 = 记录的全部宿主）
subconscious uninstall --purge-source            # 全部拆完才删 ~/.subconscious-engine/ 整目录
subconscious uninstall --purge-data --yes        # 才会删用户数据区 ~/.subconscious/（memory/grants）
```

## 接线点与幂等判据（2026-09-15 经各适配器 README / .supervision 锁定文档核实）

| 宿主 | 动作 | 幂等判据 |
|---|---|---|
| pi | `~/.pi/agent/extensions/subconscious/` ← `packages/adapter-pi/dist/*` 全量重拷（先清空旧目录） | 目录内容与源 dist 一致（条数 + 逐文件字节数） |
| claude | `~/.claude/settings.json` 的 `UserPromptSubmit`（timeout 10）与 `SessionEnd`（timeout 60）各追加一条官方 matcher-group 条目 | command 含本安装 `hook-main.js` 绝对路径即视为已装，跳过 |
| opencode | `~/.config/opencode/plugins/subconscious.js` 整文件覆写为一行 re-export（`SubconsciousPlugin`） | 文件存在且含当前绝对路径 |

**claude settings.json 写入纪律（硬性）**：读失败 / JSON 解析失败 → 中止该宿主接线
（原文件字节不动，绝不盲写）；写前把原文件逐字节备份到
`~/.subconscious-engine/backups/claude-settings-<时间戳>.json`（仅本次调用首个写
动作备份一次）；合并只追加本安装条目，其余键与条目原样保留；原子写（同目录临时
文件 + rename）+ 2 空格缩进；uninstall 只删本安装条目，事件数组清空删键、hooks
对象清空删 hooks 键。

## 安装根与用户数据区

- `~/.subconscious-engine/`：`src/`（git 模式源码树）、`install.json`（状态事实源：
  source / sourcePath / rev / hosts / installedAt）、`backups/`。
- `~/.subconscious/`：**用户数据区**（memory/grants，宿主适配器运行时读写）——安装
  器默认绝不碰，只有 `uninstall --purge-data --yes` 才会删除，且删前打印路径。

## 测试与验证边界

`npm test -w @subconscious/cli`（先 build 再 vitest，87 例）：全部离线——临时 HOME
（路径经 `process.env.HOME` 每次现算）+ 假源树（`packages/*/dist` 桩文件）+ 可注入
假执行器驱动 install / doctor / update / uninstall 全链；claude 合并纪律（无关键保
留 / 损坏中止 / 备份 / 幂等）与 uninstall 边界（只删自己、--purge-data 需 --yes）
逐例锁定；bin 入口另有真实子进程测试（argv 分发 / 退出码）。**不跑真实
`npm ci && npm run build`**（慢），真实构建链路（clone → 构建 → 三宿主接线）属真机
验收；测试绝不触碰真实 `~/.claude` / `~/.pi` / `~/.config/opencode` /
`~/.subconscious`。

## 依赖

零运行时依赖（纯 node:fs / node:path / node:child_process）。不依赖
`@subconscious/core`——安装器材料化与接线的是源码树，不是运行时 API。
