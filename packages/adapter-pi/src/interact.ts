/**
 * pi InteractPort 实现（DESIGN §4.4/§7.2、DECISIONS D5、附「M1 明确不做」）。
 *
 * - confirm/select/input 直接映射 ctx.ui 的三个对话框，透传 AbortSignal 与 timeout
 *   （ExtensionUIDialogOptions { signal, timeout }，官方类型核实记录见 DECISIONS 附表）。
 * - ctx.hasUI=false（print/json 等无对话框模式）→ 全部 unsupported，走 core 降级路径。
 * - acquire 在 M1 显式 unsupported：系统文件/图片获取对话框与图片通道归 M2
 *   （监督定界，不得虚构完成）；core 对 need-acquisition 的 confirm→acquire 流程
 *   有独立测试覆盖。
 * - input 不属于 core InteractPort（M1 无调用方），但按要求实现映射并导出，
 *   供 M2 acquire(kind:"input") 复用；信号/超时语义与 confirm/select 一致。
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InteractOptions, InteractPort } from "@subconscious/core";

/** 本模块依赖的 ui 子面：真实 ExtensionContext 结构性满足（测试可只给三个对话框） */
export type PiUiContext = Pick<ExtensionContext, "hasUI"> & {
  ui: Pick<NonNullable<ExtensionContext["ui"]>, "confirm" | "select" | "input">;
};

/** pi 交互端口：core InteractPort + input 映射（M2 acquire 的定向输入将复用） */
export interface PiInteractPort extends InteractPort {
  input(prompt: string, opts?: InteractOptions): Promise<string | null | "unsupported">;
}

/** InteractOptions → ExtensionUIDialogOptions：signal 与 timeout 一比一透传 */
function dialogOptions(opts?: InteractOptions): { signal?: AbortSignal; timeout?: number } {
  return { signal: opts?.signal, timeout: opts?.timeoutMs };
}

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

async function pickMacImage(): Promise<{ type: "image"; path: string; mediaType: string; base64: string } | null | "unsupported"> {
  if (process.platform !== "darwin") return "unsupported";
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", 'POSIX path of (choose file with prompt "选择图片" of type {"public.image"})'], { timeout: 30_000 });
    const path = stdout.trim();
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
    const mediaType = IMAGE_TYPES[extension];
    if (mediaType === undefined) return null;
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null;
    return { type: "image", path, mediaType, base64: (await readFile(path)).toString("base64") };
  } catch { return null; }
}

export function createPiInteract(ctx: PiUiContext): PiInteractPort {
  return {
    async confirm(prompt, opts) {
      if (!ctx.hasUI) return "unsupported";
      const yes = await ctx.ui.confirm("潜意识引擎", prompt, dialogOptions(opts));
      return yes ? "yes" : "no";
    },
    async select(title, options, opts) {
      if (!ctx.hasUI) return "unsupported";
      const chosen = await ctx.ui.select(title, [...options], dialogOptions(opts));
      return chosen === undefined ? null : chosen;
    },
    async input(prompt, opts) {
      if (!ctx.hasUI) return "unsupported";
      const text = await ctx.ui.input("潜意识引擎", prompt, dialogOptions(opts));
      return text === undefined ? null : text;
    },
    async acquire(spec, opts) {
      // pi 当前锁定 SDK 没有系统文件/图片 picker；但 input acquisition 可由官方 ui.input
      // 安全实现。其余 kind 必须诚实降级，不能把路径字符串伪装成附件。
      if (spec.kind === "input" && spec.expectedType === "text") {
        const text = await this.input(spec.prompt, opts);
        if (text === "unsupported") return "unsupported";
        if (text === null || text.trim() === "") return null;
        return { type: "text", text };
      }
      if (spec.kind === "pick-image" && spec.expectedType === "image") return pickMacImage();
      // M1 定界（DECISIONS 附「M1 明确不做」）：获取动作（pick-file/pick-image 的系统
      // 对话框、图片读取与附件通道）归 M2。显式 unsupported，core 走降级：
      // need-acquisition → confirm 被拒/不可用 → acquisition-declined / interaction-unsupported。
      return "unsupported";
    },
  };
}
