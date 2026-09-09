"use client";

import { invoke } from "@tauri-apps/api/core";

import type { WatchEvent, WatchHistory, WatchSession } from "@/types/watchStats";
import { logger } from "@/utils/logger";

type Listener = (history: WatchHistory) => void;

const EMPTY_HISTORY: WatchHistory = { version: 1, sessions: [], events: [] };
const listeners = new Set<Listener>();
const pendingWrites = new Set<Promise<void>>();
let cache: WatchHistory | null = null;

function notify() {
  const snapshot = cache ?? EMPTY_HISTORY;
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // ignore listener failures
    }
  }
}

/** 订阅 stats store 最新值；首次订阅立即回调一次当前缓存（若有）。 */
export function subscribeWatchHistory(listener: Listener): () => void {
  listeners.add(listener);
  if (cache) {
    try {
      listener(cache);
    } catch {
      // ignore
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

export async function readWatchHistory(): Promise<WatchHistory> {
  try {
    const history = await invoke<WatchHistory>("read_watch_stats_cmd");
    cache = history ?? EMPTY_HISTORY;
    notify();
    return cache;
  } catch (e) {
    logger.warn("[watchStats] read failed", e);
    return cache ?? EMPTY_HISTORY;
  }
}

/** 等待所有在途的 append 落盘（窗口关闭前的结清路径）。 */
export async function flushWatchStats(): Promise<void> {
  await Promise.allSettled([...pendingWrites]);
}

export async function appendWatchSession(session: WatchSession): Promise<void> {
  const write = (async () => {
    try {
      await invoke("append_watch_session_cmd", { session });
      if (cache) {
        cache.sessions.push(session);
        notify();
      }
    } catch (e) {
      logger.warn("[watchStats] append session failed", e);
    }
  })();
  pendingWrites.add(write);
  void write.finally(() => pendingWrites.delete(write));
  return write;
}

export async function appendWatchEvent(event: WatchEvent): Promise<void> {
  const write = (async () => {
    try {
      await invoke("append_watch_event_cmd", { event });
      if (cache) {
        cache.events.push(event);
        notify();
      }
    } catch (e) {
      logger.warn("[watchStats] append event failed", e);
    }
  })();
  pendingWrites.add(write);
  void write.finally(() => pendingWrites.delete(write));
  return write;
}
