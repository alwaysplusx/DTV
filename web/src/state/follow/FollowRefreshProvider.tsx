"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { Platform as PlatformEnum } from "@/platforms/common/types";
import { useFollow, type FollowedStreamer, type FollowListItem } from "@/state/follow/FollowProvider";
import { FOLLOW_REFRESH_COMPLETED_EVENT, type FollowRefreshCompletedDetail } from "@/components/follows/followRefreshEvents";
import { useImageProxy } from "@/hooks/useImageProxy";
import { getFollowAutoRefreshIntervalMs } from "@/hooks/useFollowAutoRefreshInterval";
import { logger } from "@/utils/logger";

const FOLLOW_REFRESH_CONCURRENCY = 2;
const REFRESH_INITIAL_DELAY_MS = 1500;

function normalizeLiveStatus(isLive: boolean | null | undefined): FollowedStreamer["liveStatus"] {
  if (isLive === true) return "LIVE";
  if (isLive === false) return "OFFLINE";
  return "UNKNOWN";
}

async function refreshOne(streamer: FollowedStreamer) {
  if (streamer.platform === "DOUYU") {
    const info = await invoke<any>("fetch_douyu_room_info", { roomId: streamer.id });
    const showStatus = typeof info?.show_status === "number" ? info.show_status : Number(info?.show_status ?? 0);
    const rawVideoLoop = info?.video_loop ?? info?.videoLoop ?? null;
    const videoLoop =
      typeof rawVideoLoop === "number" ? rawVideoLoop : rawVideoLoop === null || typeof rawVideoLoop === "undefined" ? null : Number(rawVideoLoop);

    // Douyu: show_status === 1 需要结合 video_loop 判断；未知值一律不展示“在线”以避免误判
    let liveStatus: FollowedStreamer["liveStatus"] = "OFFLINE";
    if (showStatus === 1) {
      if (videoLoop === 0) liveStatus = "LIVE";
      else if (videoLoop === 1) liveStatus = "OFFLINE";
      else liveStatus = "UNKNOWN";
    }
    return {
      nickname: info?.nickname ?? streamer.nickname,
      avatarUrl: info?.avatar_url ?? streamer.avatarUrl,
      roomTitle: info?.room_name ?? info?.roomName ?? streamer.roomTitle,
      liveStatus,
      coverUrl: info?.cover_url ?? streamer.coverUrl,
      viewerCountStr: info?.viewer_count_str ?? streamer.viewerCountStr
    } satisfies Partial<FollowedStreamer>;
  }

  if (streamer.platform === "HUYA") {
    try {
      const info = await invoke<any>("get_huya_unified_cmd", { roomId: streamer.id, quality: null, line: null });
      return {
        nickname: info?.nick ?? streamer.nickname,
        avatarUrl: info?.avatar ?? streamer.avatarUrl,
        roomTitle: info?.title ?? streamer.roomTitle,
        liveStatus: normalizeLiveStatus(!!info?.is_live),
        coverUrl: info?.cover_url ?? streamer.coverUrl,
        viewerCountStr: info?.viewer_count_str ?? streamer.viewerCountStr
      } satisfies Partial<FollowedStreamer>;
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "";
      if (msg.includes("主播未开播或获取虎牙房间详情失败")) {
        return { liveStatus: "OFFLINE" } satisfies Partial<FollowedStreamer>;
      }
      throw e;
    }
  }

  if (streamer.platform === "BILIBILI") {
    const payload = { platform: PlatformEnum.BILIBILI, args: { room_id_str: streamer.id } };
    const cookie = typeof localStorage !== "undefined" ? localStorage.getItem("bilibili_cookie") || null : null;
    const info = await invoke<any>("fetch_bilibili_streamer_info", { payload, cookie });
    const live = Number(info?.status ?? 0) === 1;
    return {
      nickname: info?.anchor_name ?? streamer.nickname,
      avatarUrl: info?.avatar ?? streamer.avatarUrl,
      roomTitle: info?.title ?? streamer.roomTitle,
      liveStatus: normalizeLiveStatus(live),
      coverUrl: info?.cover_url ?? streamer.coverUrl,
      viewerCountStr: info?.viewer_count_str ?? streamer.viewerCountStr
    } satisfies Partial<FollowedStreamer>;
  }

  if (streamer.platform === "DOUYIN") {
    const payload = { platform: PlatformEnum.DOUYIN, args: { room_id_str: streamer.id } };
    const info = await invoke<any>("fetch_douyin_streamer_info", { payload });
    const status = Number(info?.status ?? 0);
    // Douyin: status === 2 means live (align with player/follow helpers)
    const live = status === 2;
    return {
      nickname: info?.anchor_name ?? streamer.nickname,
      avatarUrl: info?.avatar ?? streamer.avatarUrl,
      roomTitle: info?.title ?? streamer.roomTitle,
      liveStatus: normalizeLiveStatus(live),
      coverUrl: info?.cover_url ?? streamer.coverUrl,
      viewerCountStr: info?.viewer_count_str ?? streamer.viewerCountStr
    } satisfies Partial<FollowedStreamer>;
  }

  return {} satisfies Partial<FollowedStreamer>;
}

type RefreshReason = "initial" | "timer" | "visible" | "manual";

type RefreshOptions = { silent?: boolean; suppressNotifications?: boolean; reason?: RefreshReason };

type FollowRefreshContextValue = {
  /** 返回是否真正执行了刷新（已有刷新在途或列表为空时返回 false） */
  refreshList: (opts?: RefreshOptions) => Promise<boolean>;
  isRefreshing: boolean;
  progressCurrent: number;
  progressTotal: number;
};

const FollowRefreshContext = createContext<FollowRefreshContextValue | null>(null);

/**
 * 应用级刷新引擎：挂在 AppShellInner（跨路由常驻），与侧栏折叠/当前页面无关。
 * 只负责调度与拉取，并把每轮终态经 FOLLOW_REFRESH_COMPLETED_EVENT 广播；
 * 开播通知等消费方与这里完全解耦，只依赖该事件契约。
 */
export function FollowRefreshProvider({ children }: { children: React.ReactNode }) {
  const follow = useFollow();
  const { ensureProxyStarted } = useImageProxy();

  const [intervalMs, setIntervalMs] = useState<number>(() => getFollowAutoRefreshIntervalMs());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);

  // 引擎回调保持稳定标识：调用时经 ref 取最新上下文，避免 follow 身份变化重建回调
  const followRef = useRef(follow);
  useEffect(() => {
    followRef.current = follow;
  });
  const inFlightRef = useRef(false);

  useEffect(() => {
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<number>).detail;
      setIntervalMs(typeof next === "number" ? next : getFollowAutoRefreshIntervalMs());
    };
    window.addEventListener("dtv_follow_autorefresh_interval_changed", onChange as EventListener);
    return () => {
      window.removeEventListener("dtv_follow_autorefresh_interval_changed", onChange as EventListener);
    };
  }, []);

  const refreshList = useCallback(async (opts: RefreshOptions = {}): Promise<boolean> => {
    if (inFlightRef.current) {
      logger.debug("[FollowRefresh] 已有刷新在途，跳过");
      return false;
    }
    const ctx = followRef.current;
    const streamers = ctx.followedStreamers;
    if (streamers.length === 0) return false;

    inFlightRef.current = true;
    const silent = !!opts.silent;
    const reason: RefreshReason = opts.reason ?? (silent ? "timer" : "manual");
    // 只有定时轮次才弹开播通知：启动首轮 / 回前台补刷 / 手动刷新只吸收检测基线
    const shouldNotify = reason === "timer";
    const startedAt = performance.now();
    let failedCount = 0;
    logger.info(`[FollowRefresh] 开始刷新 reason=${reason} 共=${streamers.length}`);
    const updatedByKey = new Map<string, FollowedStreamer>(streamers.map((s) => [`${s.platform}:${s.id}`, s]));

    if (!silent) {
      setIsRefreshing(true);
      setProgressTotal(streamers.length);
      setProgressCurrent(0);
    }

    try {
      let idx = 0;
      const workers = Array.from({ length: Math.min(FOLLOW_REFRESH_CONCURRENCY, streamers.length) }, async () => {
        while (idx < streamers.length) {
          const current = streamers[idx];
          idx += 1;
          try {
            const patch = await refreshOne(current);
            ctx.updateStreamer(current.platform, current.id, patch);
            updatedByKey.set(`${current.platform}:${current.id}`, { ...current, ...patch });
          } catch (e) {
            // 刷新失败时，至少不要继续显示“LIVE”（避免误判在线）
            failedCount += 1;
            logger.warn(`[FollowRefresh] ${current.platform}:${current.id} 刷新失败:`, e instanceof Error ? e.message : String(e));
            if (current.liveStatus === "LIVE") {
              ctx.updateStreamer(current.platform, current.id, { liveStatus: "UNKNOWN" });
              updatedByKey.set(`${current.platform}:${current.id}`, { ...current, liveStatus: "UNKNOWN" });
            }
          } finally {
            if (!silent) setProgressCurrent((v) => v + 1);
          }
        }
      });
      await Promise.all(workers);

      // 对齐老项目：刷新完成后，把“直播中”的主播优先展示（保留同一状态桶内的原相对顺序）
      const baseOrder = followRef.current.listOrder;
      const folderItems = baseOrder.filter((x): x is Extract<FollowListItem, { type: "folder" }> => x.type === "folder");
      const liveItems: Extract<FollowListItem, { type: "streamer" }>[] = [];
      const restItems: Extract<FollowListItem, { type: "streamer" }>[] = [];
      const seen = new Set<string>();

      for (const item of baseOrder) {
        if (item.type !== "streamer") continue;
        const key = `${item.data.platform}:${item.data.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const latest = updatedByKey.get(key) ?? item.data;
        const nextItem = { type: "streamer" as const, data: latest };
        if (latest.liveStatus === "LIVE") liveItems.push(nextItem);
        else restItems.push(nextItem);
      }

      followRef.current.updateListOrder([...folderItems, ...liveItems, ...restItems]);

      window.dispatchEvent(
        new CustomEvent<FollowRefreshCompletedDetail>(FOLLOW_REFRESH_COMPLETED_EVENT, {
          detail: { notify: shouldNotify, streamers: [...updatedByKey.values()] }
        })
      );
      let liveCount = 0;
      for (const s of updatedByKey.values()) {
        if (s.liveStatus === "LIVE") liveCount += 1;
      }
      logger.info(`[FollowRefresh] 刷新完成 reason=${reason} 共=${streamers.length} 在播=${liveCount} 失败=${failedCount} 用时=${Math.round(performance.now() - startedAt)}ms`);
      return true;
    } finally {
      inFlightRef.current = false;
      if (!silent) setIsRefreshing(false);
    }
  }, []);

  // 仅在“本次启动首次进入软件”时：延迟 + idle 自动刷新一次；后续只能手动或定时刷新
  const hydrated = follow.hydrated;
  const streamerCount = follow.followedStreamers.length;
  useEffect(() => {
    if (!hydrated || streamerCount === 0) return;
    // 等待关注数据就绪后再消耗一次性标记，避免 hydrated 先到导致错过自动刷新
    if (!followRef.current.consumeInitialAutoRefresh()) return;
    const hasBiliOrHuya = follow.followedStreamers.some((s) => s.platform === "BILIBILI" || s.platform === "HUYA");

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      if (hasBiliOrHuya) void ensureProxyStarted();
      void refreshList({ silent: true, reason: "initial" });
    };
    const ric = (window as any).requestIdleCallback as ((fn: () => void, opts?: { timeout?: number }) => number) | undefined;
    let cancel: () => void;
    if (typeof ric === "function") {
      const id = ric(run, { timeout: REFRESH_INITIAL_DELAY_MS });
      cancel = () => (window as any).cancelIdleCallback?.(id);
    } else {
      const t = window.setTimeout(run, REFRESH_INITIAL_DELAY_MS);
      cancel = () => window.clearTimeout(t);
    }
    return () => {
      cancelled = true;
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, streamerCount, refreshList]);

  // 定时自动刷新（应用级常驻）：自校正调度——上一轮完成后再排下一轮，
  // 避免 React 状态更新反复重建计时器把倒计时清零导致漂移/饥饿。
  // 窗口不可见时不拉取；恢复可见先补刷一轮再继续周期。
  useEffect(() => {
    if (!hydrated || streamerCount === 0 || intervalMs <= 0) return;

    let active = true;
    let timer: number | null = null;
    logger.info(`[FollowRefresh] 定时刷新已启动 interval=${Math.round(intervalMs / 60000)}分钟 共=${streamerCount}人`);

    const scheduleNext = () => {
      if (!active) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(tick, intervalMs);
    };

    const tick = () => {
      timer = null;
      // 隐藏期间跳过本轮，按完整间隔重排（恢复可见时由 visibilitychange 补刷）
      if (document.hidden) {
        logger.debug("[FollowRefresh] 隐藏期间跳过本轮");
        scheduleNext();
        return;
      }
      void refreshList({ silent: true, reason: "timer" }).then(() => {
        if (!document.hidden) scheduleNext();
      });
    };

    const onVisChange = () => {
      if (document.hidden) {
        logger.info("[FollowRefresh] 窗口不可见，暂停定时刷新");
        if (timer != null) {
          window.clearTimeout(timer);
          timer = null;
        }
      } else {
        // 回到前台立即拉一次（窗口刚切回时，用户最希望看到最新状态）
        logger.info("[FollowRefresh] 窗口恢复可见，补刷一轮");
        void refreshList({ silent: true, reason: "visible" }).then(() => {
          if (active && !document.hidden) scheduleNext();
        });
      }
    };

    document.addEventListener("visibilitychange", onVisChange);
    if (!document.hidden) scheduleNext();

    return () => {
      active = false;
      if (timer != null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisChange);
      logger.debug("[FollowRefresh] 定时刷新调度已停止");
    };
  }, [hydrated, streamerCount, intervalMs, refreshList]);

  const value = useMemo<FollowRefreshContextValue>(
    () => ({ refreshList, isRefreshing, progressCurrent, progressTotal }),
    [refreshList, isRefreshing, progressCurrent, progressTotal]
  );

  return <FollowRefreshContext.Provider value={value}>{children}</FollowRefreshContext.Provider>;
}

export function useFollowRefresh() {
  const ctx = useContext(FollowRefreshContext);
  if (!ctx) throw new Error("useFollowRefresh must be used within FollowRefreshProvider");
  return ctx;
}
