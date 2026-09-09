"use client";

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useFollow, type FollowedStreamer } from "@/state/follow/FollowProvider";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { FOLLOW_REFRESH_COMPLETED_EVENT, type FollowRefreshCompletedDetail } from "@/components/follows/followRefreshEvents";
import { logger } from "@/utils/logger";

export function useLiveNotifications() {
  const follow = useFollow();
  const playerOverlay = usePlayerOverlay();
  const liveKeysRef = useRef<Set<string> | null>(null);
  const trackedKeysRef = useRef<Set<string> | null>(null);
  const permissionRequestedRef = useRef(false);

  // 点击开播通知 → 前置窗口（Rust 侧处理）+ 打开该主播单屏播放
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        unlisten = await listen<{ platform: string; roomId: string }>("live_notif_click", (e) => {
          const { platform, roomId } = e.payload ?? {};
          if (!platform || !roomId) return;
          playerOverlay.openPlayer({ platform: platform.toLowerCase(), roomId });
        });
      } catch {
        // 非 Tauri 环境或权限缺失：忽略
      }
      if (cancelled) {
        unlisten?.();
        unlisten = undefined;
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [playerOverlay]);

  // 开播检测基线：hydration 时用本地快照播种（LIVE 集合 + 在列主播全集），首次进入只记录不通知
  useEffect(() => {
    if (!follow.hydrated) return;
    if (liveKeysRef.current !== null) return;

    const liveKeys = new Set<string>();
    const trackedKeys = new Set<string>();
    for (const s of follow.followedStreamers) {
      trackedKeys.add(streamerKey(s));
      if (s.liveStatus === "LIVE") liveKeys.add(streamerKey(s));
    }
    liveKeysRef.current = liveKeys;
    trackedKeysRef.current = trackedKeys;
  }, [follow.followedStreamers, follow.hydrated]);

  // 开播检测：以「刷新批次完成」事件为准（事件携带本轮终态，避免与 React 异步 flush 的时序竞态）。
  // 手动刷新 notify=false：只吸收基线不弹通知 —— 用户正盯着列表，桌面 toast 冗余。
  // 新关注/重新关注的主播（上一批不在列）直接吸收，避免「关注了正在直播的人」被误报开播。
  useEffect(() => {
    const onRefreshCompleted = (e: Event) => {
      const detail = (e as CustomEvent<FollowRefreshCompletedDetail>).detail;
      const streamers = Array.isArray(detail?.streamers) ? detail.streamers : [];

      const prevLiveKeys = liveKeysRef.current;
      const prevTrackedKeys = trackedKeysRef.current;

      const nextLiveKeys = new Set<string>();
      const nextTrackedKeys = new Set<string>();
      for (const s of streamers) {
        const key = streamerKey(s);
        nextTrackedKeys.add(key);
        if (s.liveStatus === "LIVE") nextLiveKeys.add(key);
      }
      liveKeysRef.current = nextLiveKeys;
      trackedKeysRef.current = nextTrackedKeys;

      if (!detail?.notify || !prevLiveKeys || !prevTrackedKeys) return;

      const newLiveEntries = streamers.filter((s) => {
        if (s.liveStatus !== "LIVE") return false;
        const key = streamerKey(s);
        return !prevLiveKeys.has(key) && prevTrackedKeys.has(key);
      });

      if (newLiveEntries.length > 0) {
        logger.info(`[LiveNotifications] 检测到新开播 ${newLiveEntries.length} 个：${newLiveEntries.map((s) => s.nickname || s.id).join("、")}`);
        void notifyLiveStreamers(newLiveEntries, permissionRequestedRef);
      }
    };

    window.addEventListener(FOLLOW_REFRESH_COMPLETED_EVENT, onRefreshCompleted as EventListener);
    return () => window.removeEventListener(FOLLOW_REFRESH_COMPLETED_EVENT, onRefreshCompleted as EventListener);
  }, []);
}

function streamerKey(s: FollowedStreamer): string {
  return `${s.platform}:${s.id}`;
}

async function notifyLiveStreamers(
  streamers: FollowedStreamer[],
  permissionRequestedRef: React.MutableRefObject<boolean>
) {
  try {
    const notif: any = await import("@tauri-apps/plugin-notification");
    if (!notif) return;

    if (!permissionRequestedRef.current) {
      permissionRequestedRef.current = true;
      let granted = false;
      try {
        granted = await notif.isPermissionGranted();
      } catch {
        granted = false;
      }
      if (!granted) {
        try {
          const perm = await notif.requestPermission();
          granted = perm === "granted";
        } catch {
          granted = false;
        }
      }
      if (!granted) return;
    }

    // 批量通知（逐条发送），避免短时间多变更时一次性轰炸
    for (const s of streamers) {
      try {
        // Rust 侧 Windows 走 long-duration toast（约 25-30s），其余平台回退通知插件
        await invoke("send_live_notification_cmd", {
          title: `${s.nickname || "主播"} 开播了`,
          body: s.roomTitle || "已进入直播间",
          platform: s.platform.toLowerCase(),
          roomId: s.id
        });
      } catch (e) {
        // 单条失败不影响其他
        logger.warn(`[LiveNotifications] 通知发送失败 ${s.nickname || s.id}:`, e instanceof Error ? e.message : String(e));
      }
    }
  } catch {
    // 非 Tauri 环境或插件未注册：静默忽略
  }
}
