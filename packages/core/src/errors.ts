/** 构造期配置错误（受控失败：enrich 永不抛出，配置错误在 createEngine 时暴露） */
export type EngineErrorCode =
  | "duplicate-source-id"
  | "unknown-type"
  | "invalid-source"
  | "invalid-permission"
  | "invalid-limits"
  | "invalid-detector-options"
  | "invalid-memory";

export class EngineConfigError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineConfigError";
    this.code = code;
  }
}

/** unknown 错误转可读字符串（日志用，不抛出） */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return "[unserializable error]";
  }
}
