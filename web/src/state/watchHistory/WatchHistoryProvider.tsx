"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { readWatchHistory, subscribeWatchHistory, appendWatchEvent } from "@/services/watchStatsStore";
import type { WatchHistory } from "@/types/watchStats";
import { FOLLOW_REFRESH_COMPLETED_EVENT, type FollowRefreshCompletedDetail } from "@/components/follows/followRefreshEvents";

const EMPTY_HISTORY: WatchHistory = { version: 1, sessions: [], events: [] };

type WatchHistoryContextValue = {
  history: WatchHistory;
  hydrated: boolean;
  refresh: () => Promise<void>;
};

const WatchHistoryContext = createContext<WatchHistoryContextValue | null>(null);

export function WatchHistoryProvider({ children }: { children: React.ReactNode }) {
  const [history, setHistory] = useState<WatchHistory>(EMPTY_HISTORY);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readWatchHistory().then(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return subscribeWatchHistory((next) => {
      setHistory(next);
    });
  }, []);

  const refresh = useCallback(async () => {
    await readWatchHistory();
  }, []);

  // 开播事件采集：关注刷新从非 LIVE → LIVE 的跳变时记一条 live_start_observed。
  // 首轮（含整页重载后）只吸收基线不记录，否则冷启动会把所有在播主播当成一次开播刷进去；
  // 上一轮不在列（新关注/重新关注）的在播也只吸收，同 useLiveNotifications。
  // 起始时间为“观测到”的近似时刻（平台接口未透出精确开播时间），UI 上标“约”。
  useEffect(() => {
    let prevLive: Map<string, boolean> | null = null;
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<FollowRefreshCompletedDetail>).detail;
      const nextLive = new Map<string, boolean>();
      for (const s of detail.streamers) {
        const key = `${s.platform}:${s.id}`;
        const live = s.liveStatus === "LIVE";
        if (live && prevLive?.get(key) === false) {
          void appendWatchEvent({
            platform: s.platform,
            roomId: s.id,
            anchorName: s.nickname || null,
            type: "live_start_observed",
            at: Date.now(),
            approx: true
          });
        }
        nextLive.set(key, live);
      }
      prevLive = nextLive;
    };
    window.addEventListener(FOLLOW_REFRESH_COMPLETED_EVENT, onRefresh);
    return () => window.removeEventListener(FOLLOW_REFRESH_COMPLETED_EVENT, onRefresh);
  }, []);

  const value = useMemo<WatchHistoryContextValue>(
    () => ({ history, hydrated, refresh }),
    [history, hydrated, refresh]
  );

  return <WatchHistoryContext.Provider value={value}>{children}</WatchHistoryContext.Provider>;
}

export function useWatchHistory(): WatchHistoryContextValue {
  const ctx = useContext(WatchHistoryContext);
  if (!ctx) {
    // 独立窗口（/logs/ /player-window/）未挂 Provider：退化到空数据，不炸
    return { history: EMPTY_HISTORY, hydrated: false, refresh: async () => {} };
  }
  return ctx;
}
