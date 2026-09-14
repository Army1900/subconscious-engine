import type { ActiveEditorState, DataSource, Resolution } from "../types.js";
import { truncate } from "../text.js";

const NOT_FOUND: Resolution = { status: "not-found" };

function isValidEditor(state: unknown): state is ActiveEditorState {
  if (state === null || typeof state !== "object") return false;
  const s = state as Partial<ActiveEditorState>;
  if (typeof s.path !== "string" || s.path.trim() === "") return false;
  if (s.line !== undefined && (typeof s.line !== "number" || !Number.isFinite(s.line) || s.line < 0)) return false;
  if (s.selection !== undefined && typeof s.selection !== "string") return false;
  return true;
}

/**
 * `active-editor`（L0，类型 file + code-symbol；DESIGN §4.2、D6）。
 * 红线：env.activeEditor 缺失或非法时返回 not-found，绝不回退到目录扫描或
 * "最近编辑文件"近似冒充当前文件（不猜测当前文件）。
 */
export const activeEditorSource: DataSource = {
  id: "active-editor",
  types: ["file", "code-symbol"],
  permission: "L0-free",
  async resolve(ref, env, ctx): Promise<Resolution> {
    if (ref.expectedType !== "file" && ref.expectedType !== "code-symbol") return NOT_FOUND;
    if (!isValidEditor(env.activeEditor)) return NOT_FOUND;

    const editor = env.activeEditor;
    const line = editor.line !== undefined && editor.line > 0 ? Math.floor(editor.line) : undefined;
    const locator = line !== undefined ? `${editor.path}:${line}` : editor.path;

    if (ref.expectedType === "file") {
      return {
        status: "resolved",
        value: { type: "file", path: editor.path, ...(line !== undefined ? { line } : {}) },
        display: `${locator}（当前编辑器）`,
      };
    }

    const selection =
      editor.selection !== undefined && editor.selection.trim() !== ""
        ? truncate(editor.selection.trim(), ctx.limits.maxDiffSnippetChars)
        : undefined;
    return {
      status: "resolved",
      value: {
        type: "code-symbol",
        path: editor.path,
        ...(line !== undefined ? { line } : {}),
        ...(selection !== undefined ? { symbol: selection } : {}),
      },
      display: `${locator}（当前编辑器${selection !== undefined ? `，选区：${selection}` : ""}）`,
    };
  },
};
