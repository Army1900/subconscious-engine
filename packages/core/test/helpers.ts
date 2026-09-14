import { InMemoryGrantStore } from "../src/grants.js";
import type {
  DataSource,
  DataType,
  DanglingRef,
  GrantQuery,
  GrantStore,
  GrantWriteOptions,
  GrantRecord,
  HostEnv,
  InteractPort,
  PermissionLevel,
  Resolution,
  ResolveContext,
  ResolvedValue,
} from "../src/types.js";

/** 测试用 deferred：受控释放的 promise */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

/** 让微任务队列排空几轮（不引入真实延时） */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

/** 可编程交互端口：记录调用顺序，响应可设为值或 promise */
export class FakeInteract implements InteractPort {
  readonly log: string[] = [];
  confirmResult: "yes" | "no" | "unsupported" | Promise<"yes" | "no" | "unsupported"> = "yes";
  selectResult: string | null | "unsupported" | Promise<string | null | "unsupported"> = null;
  acquireResult: ResolvedValue | null | "unsupported" | Promise<ResolvedValue | null | "unsupported"> = null;

  async confirm(prompt: string): Promise<"yes" | "no" | "unsupported"> {
    this.log.push(`confirm:${prompt}`);
    return this.confirmResult;
  }

  async select(title: string, options: readonly string[]): Promise<string | null | "unsupported"> {
    this.log.push(`select:${title}:${options.join("|")}`);
    return this.selectResult;
  }

  async acquire(spec: { prompt: string }): Promise<ResolvedValue | null | "unsupported"> {
    this.log.push(`acquire:${spec.prompt}`);
    return this.acquireResult;
  }
}

/** 记录型授权清单：包住内存实现，记录方法调用顺序 */
export class RecordingGrants implements GrantStore {
  readonly log: string[] = [];

  constructor(private readonly inner: GrantStore = new InMemoryGrantStore()) {}

  async has(query: GrantQuery): Promise<boolean> {
    this.log.push(`has:${query.sourceId}`);
    return this.inner.has(query);
  }

  async grant(query: GrantQuery, options?: GrantWriteOptions): Promise<void> {
    this.log.push(`grant:${query.sourceId}`);
    return this.inner.grant(query, options);
  }

  async revoke(query: GrantQuery): Promise<void> {
    this.log.push(`revoke:${query.sourceId}`);
    return this.inner.revoke(query);
  }

  async list(): Promise<readonly GrantRecord[]> {
    return this.inner.list();
  }
}

/** 记录型数据源包装：委托真实实现并记录 resolve 调用 */
export function recordingSource(real: DataSource): { source: DataSource; calls: string[] } {
  const calls: string[] = [];
  const source: DataSource = {
    id: real.id,
    types: real.types,
    permission: real.permission,
    async resolve(ref: DanglingRef, env: HostEnv, ctx: ResolveContext): Promise<Resolution> {
      calls.push(`resolve:${real.id}:${ref.id}:${ref.expectedType}`);
      return real.resolve(ref, env, ctx);
    },
  };
  return { source, calls };
}

/** 记录型 HostEnv：包装 provider，未提供则记录为 missing 并返回 null */
export function recordingEnv(base: Partial<HostEnv> & Pick<HostEnv, "cwd">): { env: HostEnv; calls: string[] } {
  const calls: string[] = [];
  const env: HostEnv = {
    cwd: base.cwd,
    activeEditor: base.activeEditor,
    listRecentSessions:
      base.listRecentSessions !== undefined
        ? async (req) => {
            calls.push("listRecentSessions");
            return base.listRecentSessions?.(req) ?? null;
          }
        : undefined,
    readSessionContent:
      base.readSessionContent !== undefined
        ? async (session, req) => {
            calls.push(`readSessionContent:${session.id}`);
            return base.readSessionContent?.(session, req) ?? null;
          }
        : undefined,
    readCwdContext:
      base.readCwdContext !== undefined
        ? async (req) => {
            calls.push("readCwdContext");
            return base.readCwdContext?.(req) ?? null;
          }
        : undefined,
  };
  return { env, calls };
}

/** 快速声明测试数据源 */
export function stubSource(spec: {
  id: string;
  types: readonly DataType[];
  permission?: PermissionLevel;
  resolve?: (ref: DanglingRef, env: HostEnv, ctx: ResolveContext) => Promise<Resolution> | Resolution;
}): DataSource {
  return {
    id: spec.id,
    types: spec.types,
    permission: spec.permission ?? "L0-free",
    async resolve(ref, env, ctx) {
      return typeof spec.resolve === "function" ? spec.resolve(ref, env, ctx) : { status: "not-found" };
    },
  };
}

/** 已知会话内容 fixture */
export function sessionRecordFixture(sessionId: string): { sessionId: string; changes: unknown[] } {
  return {
    sessionId,
    changes: [
      { at: "2026-09-10T10:00:00.000Z", tool: "edit", path: "src/api.ts", oldText: "try {}", newText: "try {} catch {}" },
      { at: "2026-09-10T10:05:00.000Z", tool: "write", path: "src/retry.ts", content: "export const retry = () => {};" },
      { at: "2026-09-10T10:06:00.000Z", tool: "edit", path: "src/broken.ts", oldText: "a", newText: "b", isError: true },
    ],
  };
}
