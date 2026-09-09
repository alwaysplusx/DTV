type LogArgs = unknown[];
type LogLevel = "debug" | "info" | "warn" | "error";

const isProd = process.env.NODE_ENV === "production";
// Tauri 注入的全局内部对象；浏览器直开 dev server 时不存在，此时不做 IPC 转发
const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

function safeConsole(method: LogLevel, ...args: LogArgs) {
  // Some WebView environments may not have full console support.
  // Also keep logging overhead minimal in production.
  try {
    const c = console as any;
    const fn = c?.[method] as ((...a: LogArgs) => void) | undefined;
    if (typeof fn === "function") fn(...args);
  } catch {
    // ignore
  }
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  // JSON.stringify(Error) 会得到 {}，丢 message/stack——logger.error("x", err) 场景很常见
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

// ---- IPC 转发到 tauri-plugin-log 落盘（应用内「运行日志」面板读取）----
// 动态 import 缓存；加载完成前的日志先入队，避免丢早期记录
let pluginMod: any = null;
let pluginLoading = false;
const pendingForward: Array<[LogLevel, string]> = [];

function forwardToRust(level: LogLevel, message: string) {
  if (!isTauri) return;
  if (level === "debug" && isProd) return; // 生产不落 debug，与控制台策略一致
  if (pluginMod) {
    try {
      Promise.resolve(pluginMod[level]?.(message)).catch(() => {});
    } catch {
      // ignore
    }
    return;
  }
  pendingForward.push([level, message]);
  // 正常情况 import 很快完成；封顶防 import 一直卡住时无界增长
  if (pendingForward.length > 200) pendingForward.shift();
  if (!pluginLoading) {
    pluginLoading = true;
    import("@tauri-apps/plugin-log")
      .then((mod) => {
        pluginMod = mod;
        for (const [l, msg] of pendingForward.splice(0)) {
          try {
            Promise.resolve((mod as any)[l]?.(msg)).catch(() => {});
          } catch {
            // ignore
          }
        }
      })
      .catch(() => {
        pendingForward.length = 0;
      });
  }
}

function emit(level: LogLevel, ...args: LogArgs) {
  safeConsole(level, ...args);
  forwardToRust(level, args.map(formatArg).join(" "));
}

export const logger = {
  debug: (...args: LogArgs) => {
    if (isProd) return;
    emit("debug", ...args);
  },
  info: (...args: LogArgs) => emit("info", ...args),
  warn: (...args: LogArgs) => emit("warn", ...args),
  error: (...args: LogArgs) => emit("error", ...args)
};
