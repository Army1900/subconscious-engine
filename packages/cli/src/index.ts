/**
 * 库入口：导出安装器公共面（命令运行器 + 路径层 + 宿主注册表 + settings 纪律纯
 * 函数），bin 分发见 main.ts。
 */
export { parseArgs, COMMANDS } from "./args.js"
export type { CommandName, ParsedArgs, ParseResult } from "./args.js"
export { computePaths } from "./paths.js"
export type { PathEnv, SubconsciousPaths } from "./paths.js"
export { HOSTS, HOST_CLI, isHostName } from "./hosts.js"
export type { HostName } from "./hosts.js"
export { CLAUDE_HOOK_EVENTS, addClaudeHooks, applyClaudeSettings, claudeHookCommand, claudeHooksPresent, collectEventCommands, removeClaudeHooks } from "./claude-settings.js"
export type { ApplyResult, ClaudeHookEvent, Mutate, MutateResult } from "./claude-settings.js"
export { readInstallRecord, writeInstallRecord } from "./install-json.js"
export type { InstallRecord, InstallRecordResult } from "./install-json.js"
export { DEFAULT_SOURCE_URL, resolveSource, validateHostsForInstall, parseHostList } from "./deps.js"
export type { CommandDeps, SourcePlan } from "./deps.js"
export { runInstall } from "./install.js"
export { runDoctor } from "./doctor.js"
export { runUpdate } from "./update.js"
export { runUninstall } from "./uninstall.js"
