import { EngineConfigError } from "./errors.js";
import type { DataSource, DataType } from "./types.js";

/** DataType 封闭集的运行时名单（JS 传入的 source.types 需校验，受控失败） */
const KNOWN_DATA_TYPES: ReadonlySet<string> = new Set<string>([
  "file",
  "code-symbol",
  "image",
  "project",
  "history-event",
  "history-content",
  "data-record",
  "person",
  "number",
  "text",
]);

/** 授权级别封闭集的运行时名单（JS 传入的 source.permission 需校验，监督整改 5） */
const KNOWN_PERMISSION_LEVELS: ReadonlySet<string> = new Set<string>([
  "L0-free",
  "L1-grant-once",
  "L2-confirm-each",
  "L3-acquire",
]);

export function isDataType(value: unknown): value is DataType {
  return typeof value === "string" && KNOWN_DATA_TYPES.has(value);
}

/**
 * 数据源注册表（DESIGN §4.2）：纯数据 + 解析函数的登记处，新增数据源不改 core 逻辑。
 * 重复 id / 未知类型 / 非法声明在 register 时抛 EngineConfigError（受控，构造期暴露）。
 */
export class DataSourceRegistry {
  private readonly byId = new Map<string, DataSource>();

  register(source: DataSource): void {
    if (source === null || typeof source !== "object") {
      throw new EngineConfigError("invalid-source", "数据源必须是对象");
    }
    if (typeof source.id !== "string" || source.id.trim() === "") {
      throw new EngineConfigError("invalid-source", "数据源 id 必须是非空字符串");
    }
    if (!Array.isArray(source.types) || source.types.length === 0) {
      throw new EngineConfigError("invalid-source", `数据源 ${source.id} 必须声明至少一个服务类型`);
    }
    for (const t of source.types) {
      if (!isDataType(t)) {
        throw new EngineConfigError("unknown-type", `数据源 ${source.id} 声明了未知类型 ${JSON.stringify(t)}`);
      }
    }
    if (typeof source.permission !== "string" || !KNOWN_PERMISSION_LEVELS.has(source.permission)) {
      // 运行时校验四个允许值：非法/缺省授权级别会让引擎的权限门禁失真（监督整改 5）
      throw new EngineConfigError(
        "invalid-permission",
        `数据源 ${source.id} 声明了非法授权级别 ${JSON.stringify(source.permission)}（允许值：L0-free / L1-grant-once / L2-confirm-each / L3-acquire）`,
      );
    }
    if (typeof source.resolve !== "function") {
      throw new EngineConfigError("invalid-source", `数据源 ${source.id} 缺少 resolve 函数`);
    }
    if (this.byId.has(source.id)) {
      throw new EngineConfigError("duplicate-source-id", `数据源 id 重复注册：${source.id}`);
    }
    this.byId.set(source.id, source);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): DataSource | undefined {
    return this.byId.get(id);
  }

  /** 按注册顺序返回服务该类型的全部数据源（前者优先） */
  findByType(type: DataType): readonly DataSource[] {
    const out: DataSource[] = [];
    for (const source of this.byId.values()) {
      if (source.types.includes(type)) out.push(source);
    }
    return out;
  }

  list(): readonly DataSource[] {
    return [...this.byId.values()];
  }
}
