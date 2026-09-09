"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { ChevronDown, Folder, Play, RotateCw, Users } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import styles from "./FollowsHomePage.module.css";
import { useFollow, type FollowedStreamer, type Platform as FollowPlatform } from "@/state/follow/FollowProvider";
import { useFollowRefresh } from "@/state/follow/FollowRefreshProvider";
import { useImageProxy } from "@/hooks/useImageProxy";
import { useCardHoverPreview } from "@/hooks/useCardHoverPreview";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { useMultiview } from "@/state/multiview/MultiviewProvider";
import { MultiviewSlotPicker, type SlotPickerAnchor } from "@/components/player/multiview/MultiviewSlotPicker";
import { SmoothImage } from "@/components/common/SmoothImage";
import { PlatformIcon } from "@/components/common/PlatformIcon";
import { appendHuyaCoverParams } from "@/platforms/huya/coverParams";
import { FOLLOW_REFRESH_COMPLETED_EVENT } from "@/components/follows/followRefreshEvents";
import { HoverStreamPreview } from "@/components/follows/HoverStreamPreview";
import { FollowsStatsPanel } from "@/components/follows/FollowsStatsPanel";
import { useWatchHistory } from "@/state/watchHistory/WatchHistoryProvider";

const IMAGE_TICK_MS = 60_000;
const HOVER_PREVIEW_DELAY_MS = 550;

function platformLabel(p: FollowPlatform) {
  if (p === "DOUYU") return "斗鱼";
  if (p === "HUYA") return "虎牙";
  if (p === "DOUYIN") return "抖音";
  if (p === "BILIBILI") return "B站";
  return p;
}

function normalizeFollowKey(key: string) {
  const [p, id] = String(key || "").split(":");
  return `${String(p || "").toUpperCase()}:${String(id || "")}`;
}

function cardKey(platform: FollowPlatform, id: string) {
  return `${platform}:${id}`;
}

function viewerNum(s?: string) {
  if (!s) return 0;
  const wan = s.match(/([\d.]+)\s*万/);
  if (wan) return Math.round(Number.parseFloat(wan[1]) * 10_000);
  const n = Number.parseInt(s.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

type LiveSection = {
  key: string;
  title: string;
  live: FollowedStreamer[];
  total: number;
};

type Derived = {
  /** 未分组的直播卡：不建节，直接铺在所有文件夹分节之上 */
  ungroupedLive: FollowedStreamer[];
  liveSections: LiveSection[];
  offline: FollowedStreamer[];
};

export function FollowsHomePage() {
  const router = useRouter();
  const follow = useFollow();
  const { refreshList, isRefreshing } = useFollowRefresh();
  const { proxify, ensureProxyStarted, getAvatarSrc, proxyReady } = useImageProxy();
  const playerOverlay = usePlayerOverlay();
  const multiview = useMultiview();

  const [offlineOpen, setOfflineOpen] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; streamer: FollowedStreamer } | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<SlotPickerAnchor | null>(null);

  const preview = useCardHoverPreview(HOVER_PREVIEW_DELAY_MS);

  const { listOrder, followedStreamers, hydrated } = follow;
  const { history: watchHistory } = useWatchHistory();
  const hasWatchStats = watchHistory.sessions.length > 0;

  useEffect(() => {
    if (followedStreamers.some((s) => s.platform === "BILIBILI" || s.platform === "HUYA")) {
      void ensureProxyStarted();
    }
  }, [followedStreamers, ensureProxyStarted]);

  // 每轮关注刷新完成后换新封面图（cache-bust）
  useEffect(() => {
    const onRefresh = () => setRefreshEpoch((e) => e + 1);
    window.addEventListener(FOLLOW_REFRESH_COMPLETED_EVENT, onRefresh);
    return () => window.removeEventListener(FOLLOW_REFRESH_COMPLETED_EVENT, onRefresh);
  }, []);

  // 页面可见时周期 re-GET 封面（同 URL 换 t，不打房间 API），让快照更接近实时
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) setRefreshEpoch((e) => e + 1);
    }, IMAGE_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const streamerByKey = useMemo(() => {
    const m = new Map<string, FollowedStreamer>();
    for (const s of followedStreamers) m.set(`${s.platform}:${s.id}`, s);
    return m;
  }, [followedStreamers]);

  const liveTotal = useMemo(() => followedStreamers.filter((s) => s.liveStatus === "LIVE").length, [followedStreamers]);

  const derived = useMemo<Derived>(() => {
    const foldered = new Set<string>();
    for (const item of listOrder) {
      if (item.type === "folder") {
        for (const raw of item.data.streamerIds) foldered.add(normalizeFollowKey(raw));
      }
    }

    const folders: { key: string; title: string; members: FollowedStreamer[] }[] = [];
    const ungrouped: FollowedStreamer[] = [];

    for (const item of listOrder) {
      if (item.type === "folder") {
        const members: FollowedStreamer[] = [];
        for (const rawKey of item.data.streamerIds) {
          const s = streamerByKey.get(normalizeFollowKey(rawKey));
          if (s) members.push(s);
        }
        folders.push({ key: `folder:${item.data.id}`, title: item.data.name, members });
      } else {
        const k = normalizeFollowKey(`${item.data.platform}:${item.data.id}`);
        if (foldered.has(k)) continue;
        ungrouped.push(streamerByKey.get(k) ?? item.data);
      }
    }

    // 未开播统一收进页面底部一个汇总条；直播区 = 未分组网格在上 + 文件夹分节在下
    const liveSections: LiveSection[] = [];
    const offline: FollowedStreamer[] = [];
    const seenOffline = new Set<string>();

    const collectOffline = (members: FollowedStreamer[]) => {
      for (const s of members) {
        if (s.liveStatus === "LIVE") continue;
        const key = `${s.platform}:${s.id}`;
        if (seenOffline.has(key)) continue;
        seenOffline.add(key);
        offline.push(s);
      }
    };

    for (const sec of folders) {
      const members = sec.members;
      const live = members.filter((s) => s.liveStatus === "LIVE");
      live.sort((a, b) => viewerNum(b.viewerCountStr) - viewerNum(a.viewerCountStr));
      collectOffline(members);
      if (live.length > 0) {
        liveSections.push({ key: sec.key, title: sec.title, live, total: members.length });
      }
    }

    const ungroupedLive = ungrouped.filter((s) => s.liveStatus === "LIVE");
    ungroupedLive.sort((a, b) => viewerNum(b.viewerCountStr) - viewerNum(a.viewerCountStr));
    collectOffline(ungrouped);

    return { ungroupedLive, liveSections, offline };
  }, [listOrder, streamerByKey]);

  const coverSrc = useCallback(
    (platform: FollowPlatform, url: string | undefined) => {
      const u = (url || "").trim();
      if (!u) return "";
      let out = u;
      if (platform === "HUYA" || platform === "BILIBILI") {
        if (!proxyReady) return ""; // 等代理就绪再渲染，避免 src 直连→代理闪切
        out = platform === "HUYA" ? appendHuyaCoverParams(u) : u;
        out = proxify(out);
      }
      return `${out}${out.includes("?") ? "&" : "?"}t=${refreshEpoch}`;
    },
    [proxify, proxyReady, refreshEpoch]
  );

  const runManualRefresh = useCallback(async () => {
    await refreshList({ suppressNotifications: true });
  }, [refreshList]);

  const openStreamer = useCallback(
    (s: FollowedStreamer, el?: HTMLElement | null) => {
      if (multiview.isMultiview) {
        const rect = el?.getBoundingClientRect();
        if (!rect) return;
        setPickerAnchor({
          rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          slot: { platform: s.platform.toLowerCase(), roomId: s.id },
          streamer: { nickname: s.nickname, avatarUrl: s.avatarUrl, platform: s.platform }
        });
        return;
      }
      playerOverlay.openPlayer({ platform: s.platform.toLowerCase(), roomId: s.id });
    },
    [multiview.isMultiview, playerOverlay]
  );

  const toggleOffline = useCallback(() => {
    setOfflineOpen((v) => !v);
  }, []);

  const avatarSrc = useCallback(
    (platform: FollowPlatform, url: string | undefined) => getAvatarSrc(platform, url),
    [getAvatarSrc]
  );

  const cardAvatar = (s: FollowedStreamer) => {
    const src = avatarSrc(s.platform, s.avatarUrl);
    return src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <SmoothImage src={src} alt={s.nickname} className={styles.cardAvatarImg} loading="lazy" />
    ) : (
      <div className={styles.cardAvatarFallback}>{(s.nickname || "?").slice(0, 1)}</div>
    );
  };

  const renderCard = (s: FollowedStreamer, idx: number) => {
    const cover = coverSrc(s.platform, s.coverUrl);
    const av = avatarSrc(s.platform, s.avatarUrl);
    const key = cardKey(s.platform, s.id);
    const isPreviewing = !!preview.target && preview.target.platform === s.platform && preview.target.id === s.id;
    return (
      <div
        key={key}
        className={styles.card}
        role="button"
        tabIndex={0}
        onClick={(e) => openStreamer(s, e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter") openStreamer(s, e.currentTarget);
        }}
        onMouseEnter={() => preview.enter(s.platform, s.id)}
        onMouseLeave={() => preview.leave(s.platform, s.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, streamer: s });
        }}
      >
        <div className={styles.cardInner}>
          <div className={styles.preview}>
            {cover ? (
              <SmoothImage src={cover} alt={s.roomTitle || s.nickname} className={styles.mediaImg} loading={idx < 12 ? "eager" : "lazy"} />
            ) : (
              <div className={styles.previewFallback}>
                {av ? <SmoothImage src={av} alt="" className={styles.previewFallbackImg} loading="lazy" /> : null}
              </div>
            )}
            <div className={styles.platformBadge}>
              <PlatformIcon platform={s.platform.toLowerCase()} size={12} />
              {platformLabel(s.platform)}
            </div>
            {s.viewerCountStr ? (
              <div className={styles.viewerBadge}>
                <span className={styles.viewerPill}>
                  <Users size={11} />
                  {s.viewerCountStr}
                </span>
              </div>
            ) : null}
            {!isPreviewing ? (
              <div className={styles.hoverOverlay}>
                <span className={styles.playButton}>
                  <Play size={18} />
                </span>
              </div>
            ) : null}
            {isPreviewing ? <HoverStreamPreview platform={s.platform} roomId={s.id} /> : null}
          </div>
          <div className={styles.footer}>
            <div className={styles.cardAvatar}>{cardAvatar(s)}</div>
            <div className={styles.textDetails}>
              <h3 className={styles.cardTitle} title={s.roomTitle || ""}>
                {s.roomTitle || "暂无直播标题"}
              </h3>
              <div className={styles.cardSub} title={s.nickname}>
                {s.nickname}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderOffline = (offline: FollowedStreamer[]) => {
    if (offline.length === 0) return null;
    return (
      <div className={styles.offlineBar}>
        <button type="button" className={styles.offlineToggle} onClick={toggleOffline}>
          <span className={styles.offlineDot} aria-hidden="true" />
          未开播 ({offline.length})
          <ChevronDown size={14} className={`${styles.offlineChevron} ${offlineOpen ? styles.offlineChevronOpen : ""}`} aria-hidden="true" />
        </button>
        {offlineOpen ? (
          <div className={styles.offlineList}>
            {offline.map((s) => {
              const src = avatarSrc(s.platform, s.avatarUrl);
              return (
                <button
                  key={`${s.platform}:${s.id}`}
                  type="button"
                  className={styles.offlineRow}
                  onClick={(e) => openStreamer(s, e.currentTarget)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, streamer: s });
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {src ? <img className={styles.offlineAvatar} src={src} alt={s.nickname} loading="lazy" /> : null}
                  <span className={styles.offlineName}>{s.nickname}</span>
                  <span className={styles.offlinePlatform}>{platformLabel(s.platform)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };

  if (!hydrated) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <span className={styles.spinner} aria-hidden="true" />
        </div>
      </div>
    );
  }

  const hasAny = followedStreamers.length > 0;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.headerTitle}>
            <Users size={16} />
            我的关注
          </h2>
          <div className={styles.headerSub}>
            {followedStreamers.length} 位 · <span className={styles.liveCount}>{liveTotal} 直播中</span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.refreshBtn}
            title="刷新列表"
            disabled={isRefreshing}
            onClick={() => void runManualRefresh()}
          >
            {isRefreshing ? <span className={styles.spinner} aria-hidden="true" /> : <RotateCw size={14} />}
          </button>
        </div>
      </div>

      {hasAny ? (
        <>
          <div className={styles.scrollArea}>
            {hasWatchStats ? <FollowsStatsPanel /> : null}
            {derived.ungroupedLive.length === 0 && derived.liveSections.length === 0 && derived.offline.length > 0 ? (
              <div className={styles.allOffline}>
                <div className={styles.emptyText}>当前没有正在直播的主播</div>
              </div>
            ) : null}

            {derived.ungroupedLive.length > 0 ? (
              <div className={styles.grid}>
                {derived.ungroupedLive.map((s, idx) => renderCard(s, idx))}
              </div>
            ) : null}

            {derived.liveSections.length > 0 ? (
              <div className={styles.sectionList}>
                {derived.liveSections.map((sec) => {
                  let idx = 0;
                  return (
                    <section key={sec.key} className={styles.section}>
                      <div className={styles.sectionHeader}>
                        <div className={styles.sectionTitle}>
                          <Folder size={14} />
                          <span className={styles.sectionName}>{sec.title}</span>
                        </div>
                        <span className={styles.sectionMeta}>
                          <span className={styles.liveCount}>{sec.live.length}</span>/{sec.total}
                        </span>
                      </div>
                      <div className={styles.grid}>
                        {sec.live.map((s) => renderCard(s, idx++))}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : null}

            {renderOffline(derived.offline)}
          </div>
        </>
      ) : (
        <>
          {hasWatchStats ? <FollowsStatsPanel /> : null}
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>暂无关注主播</div>
            <div className={styles.emptyText}>在直播间右上角点「关注」，或从顶部分区找到喜欢的主播</div>
            <button
              type="button"
              className={styles.emptyAction}
              onClick={() => router.push("/")}
              style={{ marginTop: 6 }}
            >
              去斗鱼逛逛
            </button>
          </div>
        </>
      )}

      <MultiviewSlotPicker
        anchor={pickerAnchor}
        onClose={() => setPickerAnchor(null)}
        onPick={(index, slot) => {
          multiview.assignSlot(index, slot);
          multiview.setAudioSlot(index);
        }}
      />

      {menu
        ? createPortal(
            <div className={styles.menuBackdrop} onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
              <div
                className={styles.contextMenu}
                style={{ left: menu.x, top: menu.y }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    void invoke("open_stats_window_cmd", { streamer: `${menu.streamer.platform}:${menu.streamer.id}` }).catch(() => {});
                    setMenu(null);
                  }}
                >
                  查看观看统计
                </button>
                <button
                  type="button"
                  className={`${styles.menuItem} ${styles.menuDanger}`}
                  onClick={() => {
                    follow.unfollowStreamer(menu.streamer.platform, menu.streamer.id);
                    setMenu(null);
                  }}
                >
                  取消关注
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
