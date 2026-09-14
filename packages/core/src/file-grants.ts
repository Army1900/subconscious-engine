import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GrantQuery, GrantRecord, GrantStore, GrantWriteOptions } from "./types.js";

type StoredGrants = { version: 1; grants: GrantRecord[] };

function keyOf(query: GrantQuery): string {
  return `${query.sourceId}\u0000${query.scope ?? ""}`;
}

function validRecord(value: unknown): value is GrantRecord {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.sourceId === "string" && typeof item.grantedAt === "string"
    && (item.scope === undefined || typeof item.scope === "string")
    && (item.expiresAt === undefined || typeof item.expiresAt === "string");
}

function expired(record: GrantRecord, now: number): boolean {
  if (record.expiresAt === undefined) return false;
  const time = Date.parse(record.expiresAt);
  return Number.isNaN(time) || time <= now;
}

/** M2 file-backed grants. Every filesystem failure is treated as no grant. */
export class FileGrantStore implements GrantStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly now: () => number = () => Date.now()) {}

  private async read(): Promise<Map<string, GrantRecord>> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (typeof raw !== "object" || raw === null) return new Map();
      const stored = raw as Partial<StoredGrants>;
      if (stored.version !== 1 || !Array.isArray(stored.grants) || !stored.grants.every(validRecord)) return new Map();
      return new Map(stored.grants.map((record) => [keyOf(record), record]));
    } catch {
      return new Map();
    }
  }

  private async write(records: Map<string, GrantRecord>): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temp, JSON.stringify({ version: 1, grants: [...records.values()] }), "utf8");
      await rename(temp, this.filePath);
    } catch {
      // Authorization persistence must never prevent the caller from proceeding.
    }
  }

  private mutate(action: (records: Map<string, GrantRecord>) => void): Promise<void> {
    const result = this.queue.then(async () => { const records = await this.read(); action(records); await this.write(records); });
    this.queue = result.catch(() => undefined);
    return result.catch(() => undefined);
  }

  async has(query: GrantQuery): Promise<boolean> {
    const record = (await this.read()).get(keyOf(query));
    return record !== undefined && !expired(record, this.now());
  }

  grant(query: GrantQuery, options?: GrantWriteOptions): Promise<void> {
    return this.mutate((records) => records.set(keyOf(query), {
      sourceId: query.sourceId,
      ...(query.scope === undefined ? {} : { scope: query.scope }),
      grantedAt: new Date(this.now()).toISOString(),
      ...(options?.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    }));
  }

  revoke(query: GrantQuery): Promise<void> { return this.mutate((records) => records.delete(keyOf(query))); }

  async list(): Promise<readonly GrantRecord[]> { return [...(await this.read()).values()]; }
}
