# subconscious-engine

在用户话语到达模型前，本地识别“上次”“这个文件”“一样的错误处理”等悬空指代，并在有证据时注入可追溯的上下文。无法可靠解析时保持原话，不猜测。

## 首版本能力

首版本提供核心引擎、`@subconscious/adapter-pi`、授权清单与离线演示。演示使用真实 pi `SessionManager` 写入系统临时目录，再经过真实 adapter 的 `before_agent_start` handler；它不会读取或写入 `~/.pi`。

已实现：

- 中英文规则检测、历史会话/变更上下文、当前工作目录与 active-editor 的保守解析；无法可靠解析时原样透传。
- `before_agent_start` pi 扩展、总超时和 fail-open 降级。
- 文件持久化授权清单，按 `sourceId + scope` 隔离；L1 clipboard 只在确认后通过宿主注入 provider 读取。
- 明确图片指代经确认后使用 macOS 原生选择框，限 PNG/JPEG/GIF/WebP、5 MiB，并走附件通道。
- 本机 `pi 0.85.1` 的真实扩展加载验证，使用 `--offline --no-session`，不触碰真实会话。

明确边界：macOS 图片选择仅在 macOS 可用；没有真人长期交互 E2E；纯终端 pi 没有 active editor 时，文件指代会被诚实丢弃而不会猜测当前文件。M3 embedding 检测器与 Claude Code/OpenCode 适配器属于后续版本。

## 本地验证

需要 Node.js 22 或更新版本：

```sh
npm ci
npm run check
npm run check-deps
npm run demo
```

`npm run check` 运行类型检查和全部测试；`npm run check-deps` 检查 pi peer 依赖与核心依赖版本约束；`npm run demo` 展示历史事件、历史内容和无 active editor 时的安全降级。

真实 pi 最小加载验证：

```sh
pi --offline --no-session --no-extensions --no-skills \
  --extension "$PWD/packages/adapter-pi/dist/index.js" --no-tools -p "hello"
```
