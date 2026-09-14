# 独立验收矩阵

以下为监督者验收条件，不以实现者自报通过替代验证。阶段当前均待验收。

| 范围 | 必须观察到的行为 | 证据要求 |
|---|---|---|
| 无指代 | 原始 prompt 不变；source/交互/grants 无调用 | 带计数器的独立调用 |
| 检测器 | 中英文显式引用；span 对应原文；低置信丢弃；普通 this is 不触发 | 正负例与 Unicode 样例 |
| 环境 | enrich 每次快照可更新，不跨请求串历史选择 | 两次调用不同 env |
| 当前文件 | 无编辑器和有效最近读写记录时不得凭 cwd 指认文件 | 缺上下文样例 |
| 历史 | 消歧选定 ID 后才读其内容；重复标签仍使用稳定 ID | 多候选、相同标签、乱序/无效日期 |
| 来源 | registry 重复 ID/不兼容类型受控；单源故障不损失其他源 | 故障注入 |
| 权限 | 未授权/拒绝/unsupported 不读取；scope 不越界；过期撤销生效；L2 不存储 | spy source + 临时 grants 文件 |
| 获取 | 显式引用+缺数据+确认才执行；取消不会再读取/持久化 | 交互调用顺序 |
| 超时 | 3s 默认有界；保留已完成项；迟到返回不再写 grant/开 UI；无未处理 rejection | 永不结束、迟到成功、迟到失败端口 |
| 并发 | 独立项并行，历史内容等待所属事件；同时 enrich 不串数据 | 可控 barrier 测试 |
| 注入 | 只注入 resolved，标来源、可见；原话不改写；内容大小有界 | 结构化输出检查 |
| 图片 | 附件有 MIME/大小约束；不将 base64 塞进 context；已有附件不丢 | 实际宿主消息协议 fixture |
| 持久化 | 临时文件原子替换，损坏/并发/权限错误处理明确 | 临时目录集成测试 |
| pi | 官方 SDK 类型通过；真实扩展可加载；失败返回透传 | 锁定版本、真实 runner 或最小宿主加载 |
| Claude | stdin hook JSON -> stdout 合法 hook JSON；日志仅 stderr；无 UI 时降级 | 子进程协议测试、安装示例 |
| OpenCode | 官方 plugin 类型和事件点匹配；只改当前用户消息 | 锁定版本、真实加载/协议证据 |
| M3 embedding | 真正本地向量分类实现；无模型/加载失败仍规则回退；评估集不只训练例 | 离线固定向量测试+可复现真实模型评估 |
| 工程 | strict、无 any、核心依赖方向、Node22、干净安装构建 | check + 包 tarball 独立 consumer |
| 产品演示 | M1 历史+文件；M2 花图两次交互；无指代一致 | 可运行演示及人工宿主验证状态明确 |

## 上游核实
2026-09-13 已由监督者读取 pi 官方 extensions.md：before_agent_start 允许返回可见 custom message；input 支持 text/images transform；ctx.signal 在 before_agent_start 不保证存在，应自建总超时 controller。官方文档来源：https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md 。构建验收仍须以锁定的安装版本类型为准。
