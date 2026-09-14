import type { DataSource, Resolution } from "../types.js";
import { truncate } from "../text.js";

const NOT_FOUND: Resolution = { status: "not-found" };

/** L1 clipboard source. The host injects the reader; core never reads a system clipboard. */
export const clipboardSource: DataSource = {
  id: "clipboard",
  grantScope: "clipboard:global",
  types: ["text"],
  permission: "L1-grant-once",
  async resolve(ref, env, ctx): Promise<Resolution> {
    if (ref.expectedType !== "text" || typeof env.readClipboardText !== "function") return NOT_FOUND;
    try {
      const value = await env.readClipboardText({ signal: ctx.signal, maxBytes: ctx.limits.maxSourceBytes });
      if (typeof value !== "string" || value.trim() === "") return NOT_FOUND;
      const text = truncate(value, ctx.limits.maxRefDisplayChars);
      return { status: "resolved", value: { type: "text", text }, display: `剪贴板内容：${text}` };
    } catch { return NOT_FOUND; }
  },
};
