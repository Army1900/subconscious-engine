/**
 * 个人记忆层接线（M5b，DECISIONS D24；组合模式参照 embedding-optin.ts）。
 *
 * 契约：
 * - 默认路径 ~/.subconscious/memory.json（与 grants.json 同目录）；SUBCONSCIOUS_MEMORY_FILE
 *   覆盖（非空生效，推荐绝对路径；测试用临时目录钉住，绝不触真实 ~/.subconscious）；
 * - 引擎构造时读取词典：本适配器每 chat.message 重建引擎（D11），语义即「每条消息
 *   重读」（手工编辑 memory.json 天然热生效）；listPhrases() 非空时用
 *   createPersonalPhraseDetector 包住现有检测器（规则或 opt-in embedding；个人短语
 *   优先于基座命中）；零合法词条不包装（行为逐字节一致）；
 * - FileMemoryStore 读取失败/损坏 fail-open 为空记忆（core 已有）；本层任何异常
 *   不抛出、不阻塞 enrich——记忆问题绝不影响宿主消息流（也不占用适配器总超时预算）；
 * - store 按路径 memoize（长寿命插件进程内写队列串行化；store 每次操作直读磁盘、
 *   无实例内缓存，D24 快照纪律不变）；
 * - 本宿主无 confirm/select API：先验「学习」结构性不发生，但共享 memory.json 的
 *   先验（其他宿主学到/手工写入）在此可用——达门槛即自动代选（display 标注
 *   「按你的常用选择」）。
 */
import { homedir } from "node:os";
import path from "node:path";
import {
  createPersonalPhraseDetector,
  createRuleDetector,
  FileMemoryStore,
} from "@subconscious/core";
import type { Detector, Logger, MemoryStore, PersonalPhrase } from "@subconscious/core";

/** 记忆文件路径覆盖变量（非空生效；测试/多配置隔离用） */
export const MEMORY_FILE_ENV_VAR = "SUBCONSCIOUS_MEMORY_FILE";

/** 记忆文件默认位置：~/.subconscious/memory.json（与 grants.json 同目录，人可编辑） */
export function resolveMemoryFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: () => string = homedir,
): string {
  const raw = env[MEMORY_FILE_ENV_VAR];
  if (typeof raw === "string" && raw.trim() !== "") return raw;
  return path.join(home(), ".subconscious", "memory.json");
}

export interface MemoryWireOptions {
  /** env 快照（缺省 process.env；测试注入显式 env 而不改全局） */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
}

export interface MemoryWiring {
  /** 引擎 memory 选项：先验读取 + select 亲选学习（宿主有 select 通道时） */
  readonly store: MemoryStore;
  /** base 包好个人词典后的检测器；base 为 undefined 且零词条时为 undefined（引擎默认规则） */
  readonly detector: Detector | undefined;
}

/** 同路径 store memoize：进程内写队列串行化；读取每次直读磁盘（热生效） */
const stores = new Map<string, FileMemoryStore>();

function storeFor(filePath: string): FileMemoryStore {
  let store = stores.get(filePath);
  if (store === undefined) {
    store = new FileMemoryStore(filePath);
    stores.set(filePath, store);
  }
  return store;
}

/**
 * 引擎构造前的记忆接线：读取词典并组合检测器 + 提供记忆 store。永不抛出、永不
 * reject（fail-open：任何记忆故障 = 无记忆，prompt 照常发出）。
 */
export async function wireMemory(
  base: Detector | undefined,
  options: MemoryWireOptions = {},
): Promise<MemoryWiring> {
  const env = options.env ?? process.env;
  const store = storeFor(resolveMemoryFilePath(env));
  const phrases = await readPhrases(store, options.logger);
  const detector = phrases.length > 0 ? createPersonalPhraseDetector(base ?? createRuleDetector(), phrases) : base;
  return { store, detector };
}

/** 读取词典（每次接线直读磁盘）；FileMemoryStore 自身 fail-open，此处再兜一层防未来实现抛错 */
async function readPhrases(store: MemoryStore, logger: Logger | undefined): Promise<readonly PersonalPhrase[]> {
  try {
    return await store.listPhrases();
  } catch (err) {
    logger?.({
      level: "warn",
      event: "memory-phrase-read-failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
