"use client";

import { useEffect } from "react";

import { flushActiveWatchTrackers } from "@/hooks/useWatchTracker";

/**
 * 主窗口关闭结清：Rust 拦截主窗口 CloseRequested 后发 dtv_main_close_requested，
 * 这里结清观看会话并等落盘，再 ack 真正关窗（React cleanup 在窗口销毁时不会执行，
 * 整页卸载路径全靠这里）；Rust 侧有 3s 兜底强关。只挂 Providers 主分支。
 */
export function MainWindowCloseGuard() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let handled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { invoke } = await import("@tauri-apps/api/core");
        unlisten = await listen("dtv_main_close_requested", async () => {
          if (handled) return;
          if (getCurrentWindow().label !== "main") return;
          handled = true;
          try {
            unlisten?.();
          } catch {
            // ignore
          }
          await flushActiveWatchTrackers();
          try {
            await invoke("confirm_main_close_cmd");
          } catch {
            // ignore：Rust 侧 3s 兜底会关
          }
        });
      } catch {
        // 非 Tauri 环境：忽略
      }
    })();
    return () => {
      handled = true;
      try {
        unlisten?.();
      } catch {
        // ignore
      }
    };
  }, []);
  return null;
}
