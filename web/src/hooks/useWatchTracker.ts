"use client";

import { useEffect, useRef } from "react";

import type { Platform } from "@/platforms/common/types";
import { appendWatchSession, flushWatchStats } from "@/services/watchStatsStore";
import type { WatchSession } from "@/types/watchStats";

export type WatchTrackerMeta = {
  title?: string | null;
  anchorName?: string | null;
  avatar?: string | null;
};

/** 活动会话的强制结清函数集合：正常卸载走 cleanup，窗口销毁走这里的兜底。 */
const activeTrackers = new Set<() => void>();

/** 结清所有活动观看会话并等落盘（窗口关闭前调用；finalize 幂等，与 cleanup 不冲突）。 */
export async function flushActiveWatchTrackers(): Promise<void> {
  for (const finalize of [...activeTrackers]) {
    try {
      finalize();
    } catch {
      // ignore
    }
  }
  await flushWatchStats();
}

type DraftSession = {
  platform: Platform | string;
  roomId: string;
  multiviewSlot: number | null;
  beganAt: number;
  firstPlayedAt: number | null;
};

/**
 * 每次进播放器开一份观看会话：played 在任意时刻标上 → 归为 "playing"，否则为 "offline_visit"。
 * 会话时长以首次 played 之后的累计时长计（秒）。cleanup 时 append 到后端 watch-history.json。
 *
 * 挂在 MainPlayer（单屏）与每个 PlayerCell（多屏）各自一次。
 */
export function useWatchTracker(opts: {
  platform: Platform | string;
  roomId: string;
  /** 曾成功播放过就锁存 true */
  played: boolean;
  meta?: WatchTrackerMeta;
  multiviewSlot?: number | null;
  /** false 时整段不记录（单屏多屏切换可关门） */
  enabled?: boolean;
}) {
  const { platform, roomId, played, meta, multiviewSlot = null, enabled = true } = opts;

  const draftRef = useRef<DraftSession | null>(null);
  const metaRef = useRef<WatchTrackerMeta>({});

  useEffect(() => {
    metaRef.current = meta ?? {};
  }, [meta]);

  // 开/关会话：platform/roomId/multiviewSlot/enabled 任一变化即先结后开
  useEffect(() => {
    if (!enabled) {
      return;
    }
    draftRef.current = {
      platform,
      roomId,
      multiviewSlot,
      beganAt: Date.now(),
      firstPlayedAt: null
    };
    const finalize = () => {
      const draft = draftRef.current;
      draftRef.current = null;
      if (!draft) return;
      finalizeWatchSession(draft, metaRef.current);
    };
    activeTrackers.add(finalize);
    return () => {
      activeTrackers.delete(finalize);
      finalize();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, roomId, multiviewSlot, enabled]);

  // played latch：任何一次 true 就记录起始播放时间
  useEffect(() => {
    const draft = draftRef.current;
    if (!draft) return;
    if (played && draft.firstPlayedAt == null) {
      draft.firstPlayedAt = Date.now();
    }
  }, [played]);
}

function finalizeWatchSession(draft: DraftSession, meta: WatchTrackerMeta): void {
  const endedAt = Date.now();
  const playedOnce = draft.firstPlayedAt != null;
  const seconds = playedOnce ? Math.max(0, Math.round((endedAt - draft.firstPlayedAt!) / 1000)) : 0;
  const entry: WatchSession = {
    platform: String(draft.platform),
    roomId: draft.roomId,
    anchorName: meta.anchorName ?? null,
    title: meta.title ?? null,
    avatar: meta.avatar ?? null,
    beganAt: draft.beganAt,
    endedAt,
    seconds,
    reason: playedOnce ? "playing" : "offline_visit",
    multiviewSlot: draft.multiviewSlot
  };
  void appendWatchSession(entry);
}
