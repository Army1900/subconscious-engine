/**
 * stdin 读取（有界、可超时、fail-open）。
 *
 * 官方协议：hook 经 stdin 收 JSON（一次性写入后关闭）。本读取器永不 reject：
 * 超时/错误/超量都 resolve 已累积文本（截断的 JSON 在解析层自然判非法 → no-op），
 * 保证入口不可能因 stdin 悬挂而挂死或以非零码退出。
 */

/** stdin 字节上限（hook 输入远小于此；防御异常宿主） */
export const MAX_STDIN_BYTES = 1_000_000;

export function readAllStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (timeoutMs <= 0 || stdin.isTTY) {
      // 无预算或非管道 stdin：立即释放句柄（否则悬挂的管道会挂住进程退出）
      stdin.destroy();
      resolve("");
      return;
    }
    let text = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.destroy(); // 释放句柄：宿主不关闭 stdin 时进程仍能退出
      resolve(text);
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      text += chunk;
      if (Buffer.byteLength(text, "utf8") > MAX_STDIN_BYTES) finish();
    });
    stdin.on("end", finish);
    stdin.on("error", finish);
  });
}
