import type { GrantQuery, GrantRecord, GrantStore, GrantWriteOptions } from "./types.js";

function keyOf(query: GrantQuery): string {
  return `${query.sourceId}\u0000${query.scope ?? ""}`;
}

/** 解析 ISO 时间；非法字符串返回 NaN（调用方按"更安全一侧"处理） */
function parseIso(value: string | undefined): number {
  if (typeof value !== "string" || value.trim() === "") return Number.NaN;
  return Date.parse(value);
}

/**
 * 内存授权清单（M1 交付；D7）。文件持久化、细粒度 scope 归 M2。
 * 语义：
 * - has：仅当存在未过期记录才为 true；expiresAt 非法按已过期处理（宁可不授权）。
 * - grant：覆盖写；grantedAt 由本实现生成。
 * - revoke：删除匹配记录（sourceId [+ scope]）。
 * - L2 数据源永远不应走 grant（引擎侧保证，测试锁定）。
 */
export class InMemoryGrantStore implements GrantStore {
  private readonly records = new Map<string, GrantRecord>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  async has(query: GrantQuery): Promise<boolean> {
    const record = this.records.get(keyOf(query));
    if (record === undefined) return false;
    const expiresAt = parseIso(record.expiresAt);
    if (Number.isNaN(expiresAt)) {
      // expiresAt 缺失 = 永久；expiresAt 存在但非法 = 按已过期处理（保守侧）
      if (record.expiresAt !== undefined) return false;
      return true;
    }
    return expiresAt > this.now();
  }

  async grant(query: GrantQuery, options?: GrantWriteOptions): Promise<void> {
    const expiresAt = options?.expiresAt;
    const record: GrantRecord = {
      sourceId: query.sourceId,
      ...(query.scope !== undefined ? { scope: query.scope } : {}),
      grantedAt: new Date(this.now()).toISOString(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    this.records.set(keyOf(query), record);
  }

  async revoke(query: GrantQuery): Promise<void> {
    this.records.delete(keyOf(query));
  }

  async list(): Promise<readonly GrantRecord[]> {
    return [...this.records.values()];
  }
}
