"use client";

import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, Users } from "lucide-react";

import styles from "./FollowsRail.module.css";
import listStyles from "./FollowsList.module.css";
import { normalizeFollowKey } from "./FollowsList";
import { useFollow, type FollowedStreamer } from "@/state/follow/FollowProvider";
import { useImageProxy } from "@/hooks/useImageProxy";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { useActiveRoom } from "@/components/follows/useActiveRoom";
import { useMultiview } from "@/state/multiview/MultiviewProvider";
import { MultiviewSlotPicker, type SlotPickerAnchor } from "@/components/player/multiview/MultiviewSlotPicker";
import { HoverStreamPreview } from "@/components/follows/HoverStreamPreview";
import { useCardHoverPreview } from "@/hooks/useCardHoverPreview";

const HOVER_PREVIEW_DELAY_MS = 600;
/** 头部(44) + 16:9 视频(162) + 边框，定位时用来垂直居中/夹取 */
const PREVIEW_POPOVER_H = 210;

export function FollowsRail() {
  const follow = useFollow();
  const { ensureProxyStarted, getAvatarSrc } = useImageProxy();
  const playerOverlay = usePlayerOverlay();
  const multiview = useMultiview();
  const activeRoom = useActiveRoom();
  const activeStreamerKey = activeRoom ? `${activeRoom.platform}:${activeRoom.roomId}` : null;
  const [pickerAnchor, setPickerAnchor] = useState<SlotPickerAnchor | null>(null);
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const [isDragScrolling, setIsDragScrolling] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const dragScrollRef = useRef<{ startY: number; startScrollTop: number; dragging: boolean; pointerId: number } | null>(null);
  const suppressClickRef = useRef(false);

  // 解构使用：hook 返回的对象每次渲染都是新引用，直接依赖对象会让下面所有 callback 失稳
  const { target: previewTarget, enter: previewEnter, reset: previewReset } = useCardHoverPreview(HOVER_PREVIEW_DELAY_MS);
  const [previewPos, setPreviewPos] = useState<{ left: number; top: number } | null>(null);
  const previewHoldRef = useRef(false);
  const previewCloseTimerRef = useRef<number | null>(null);

  // 真全屏 top layer 只渲染全屏元素子树：悬浮预览与侧栏同规则，portal 目标跟随全屏元素
  const [fsTarget, setFsTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const sync = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      setFsTarget((doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) as HTMLElement | null);
    };
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  const closePreview = useCallback(() => {
    previewHoldRef.current = false;
    if (previewCloseTimerRef.current) {
      window.clearTimeout(previewCloseTimerRef.current);
      previewCloseTimerRef.current = null;
    }
    previewReset();
    setPreviewPos(null);
  }, [previewReset]);

  useEffect(() => () => closePreview(), [closePreview]);

  // 头像移开后宽限 140ms，指针挪进预览卡（点喇叭开声）则保持打开
  const schedulePreviewClose = useCallback(() => {
    if (previewCloseTimerRef.current) window.clearTimeout(previewCloseTimerRef.current);
    previewCloseTimerRef.current = window.setTimeout(() => {
      previewCloseTimerRef.current = null;
      if (!previewHoldRef.current) {
        previewReset();
        setPreviewPos(null);
      }
    }, 140);
  }, [previewReset]);

  const cancelPreviewClose = useCallback(() => {
    if (previewCloseTimerRef.current) {
      window.clearTimeout(previewCloseTimerRef.current);
      previewCloseTimerRef.current = null;
    }
  }, []);

  const onAvatarMouseEnter = useCallback(
    (s: FollowedStreamer, el: HTMLElement) => {
      // 只有会开预览的目标才取消待关闭（移到未开播头像上要放行上一个预览的宽限关闭）
      if (s.liveStatus !== "LIVE") return;
      cancelPreviewClose();
      const r = el.getBoundingClientRect();
      const top = Math.min(Math.max(r.top + r.height / 2 - PREVIEW_POPOVER_H / 2, 8), window.innerHeight - PREVIEW_POPOVER_H - 8);
      setPreviewPos({ left: r.right + 12, top });
      previewEnter(s.platform, s.id);
    },
    [cancelPreviewClose, previewEnter]
  );

  const onAvatarMouseLeave = useCallback(
    (s: FollowedStreamer) => {
      if (s.liveStatus !== "LIVE") return;
      schedulePreviewClose();
    },
    [schedulePreviewClose]
  );

  const allStreamers = follow.followedStreamers;

  useEffect(() => {
    if (allStreamers.some((s) => (s.platform === "BILIBILI" || s.platform === "HUYA") && !!s.avatarUrl)) {
      void ensureProxyStarted();
    }
  }, [allStreamers, ensureProxyStarted]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const osMod: any = await import("@tauri-apps/plugin-os");
        const p = typeof osMod?.platform === "function" ? await osMod.platform() : "";
        if (cancelled) return;
        const platform = String(p).toLowerCase();
        setIsMac(platform === "macos" || platform === "darwin");
      } catch {
        // non-tauri env: ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 按文件夹分组：folder → 一组，顶层未分组主播 → 合成一组（插在其首次出现的位置）。
  // 组内 live-first（原序 tie-break）；组间按组内最好状态排——含 LIVE 的组整体浮上来，
  // 稳定排序保证同档组保持 listOrder 相对顺序
  const railGroups = useMemo(() => {
    const byKey = new Map(allStreamers.map((s) => [`${s.platform}:${s.id}`, s]));
    const rank = (status: FollowedStreamer["liveStatus"]) => {
      if (status === "LIVE") return 0;
      if (status === "UNKNOWN") return 1;
      return 2;
    };
    const folderGroups: { key: string; members: FollowedStreamer[] }[] = [];
    const loose: FollowedStreamer[] = [];
    let looseAt = 0;
    let looseSeen = false;
    for (const item of follow.listOrder) {
      if (item.type === "streamer") {
        loose.push(byKey.get(`${item.data.platform}:${item.data.id}`) ?? item.data);
        if (!looseSeen) {
          looseSeen = true;
          looseAt = folderGroups.length;
        }
      } else {
        const members = item.data.streamerIds
          .map((raw) => byKey.get(normalizeFollowKey(raw)))
          .filter((s): s is FollowedStreamer => !!s);
        if (members.length > 0) folderGroups.push({ key: `folder-${item.data.id}`, members });
      }
    }
    const groups =
      loose.length > 0
        ? [...folderGroups.slice(0, looseAt), { key: "loose", members: loose }, ...folderGroups.slice(looseAt)]
        : folderGroups;
    return groups
      .map((g) => ({
        key: g.key,
        members: [...g.members].sort((a, b) => rank(a.liveStatus) - rank(b.liveStatus)),
        groupRank: g.members.reduce((min, s) => Math.min(min, rank(s.liveStatus)), 2)
      }))
      .sort((a, b) => a.groupRank - b.groupRank)
      .map(({ key, members }) => ({ key, members }));
  }, [follow.listOrder, allStreamers]);

  // UNKNOWN 状态不定（可能开播中），跟随直播组平铺，不折叠
  const liveGroups = useMemo(
    () =>
      railGroups
        .map((g) => ({ key: g.key, members: g.members.filter((s) => s.liveStatus !== "OFFLINE") }))
        .filter((g) => g.members.length > 0),
    [railGroups]
  );
  const offlineGroups = useMemo(
    () =>
      railGroups
        .map((g) => ({ key: g.key, members: g.members.filter((s) => s.liveStatus === "OFFLINE") }))
        .filter((g) => g.members.length > 0),
    [railGroups]
  );
  const offlineCount = useMemo(() => offlineGroups.reduce((n, g) => n + g.members.length, 0), [offlineGroups]);

  const handleClick = useCallback(
    (s: FollowedStreamer, sourceEl: HTMLElement) => {
      closePreview();
      if (multiview.isMultiview) {
        const rect = sourceEl.getBoundingClientRect();
        setPickerAnchor({
          rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          slot: { platform: s.platform.toLowerCase(), roomId: s.id },
          streamer: { nickname: s.nickname, avatarUrl: s.avatarUrl, platform: s.platform }
        });
        return;
      }
      playerOverlay.openPlayer({ platform: s.platform.toLowerCase(), roomId: s.id });
    },
    [closePreview, multiview.isMultiview, playerOverlay]
  );

  // 点击拖动滚动：5px 阈值内仍算点击（开播）；超过后才 capture 到滚动容器，
  // capture 后 click 目标变为容器本身，再以 suppressClickRef 兜底拦一次
  const onDragPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragScrollRef.current = { startY: e.clientY, startScrollTop: e.currentTarget.scrollTop, dragging: false, pointerId: e.pointerId };
  };

  const onDragPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragScrollRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dy = d.startY - e.clientY;
    if (!d.dragging) {
      if (Math.abs(dy) < 5) return;
      d.dragging = true;
      suppressClickRef.current = true;
      setIsDragScrolling(true);
      closePreview();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    e.currentTarget.scrollTop = d.startScrollTop + dy;
  };

  const endDragScroll = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragScrollRef.current;
    dragScrollRef.current = null;
    if (!d?.dragging) return;
    setIsDragScrolling(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const renderOfflineToggle = (expanded: boolean) => (
    <button
      type="button"
      className={styles.railOfflineToggle}
      onClick={() => setOfflineExpanded((v) => !v)}
      aria-expanded={expanded}
      title={expanded ? "收起未开播" : `未开播 (${offlineCount})`}
    >
      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      <span>{offlineCount}</span>
    </button>
  );

  // 组间加细分隔线（首组前不加）；组 key 恒定时分隔线位置稳定
  const renderGroups = (groups: { key: string; members: FollowedStreamer[] }[]) =>
    groups.map((grp, gi) => (
      <Fragment key={grp.key}>
        {gi > 0 ? <span className={styles.railGroupDivider} aria-hidden="true" /> : null}
        {grp.members.map(renderAvatar)}
      </Fragment>
    ));

  const renderAvatar = (s: FollowedStreamer) => {
    const itemKey = `${s.platform}:${s.id}`;
    const isActive = activeStreamerKey === itemKey;
    const liveDotClass = s.liveStatus === "LIVE" ? listStyles.liveDotLive : s.liveStatus === "UNKNOWN" ? listStyles.liveDotUnknown : listStyles.liveDotOffline;
    const avatarClass = `${listStyles.avatar}${isActive ? ` ${listStyles.avatarActive}` : ""} ${styles.railAvatar}`;
    const avatarSrc = getAvatarSrc(s.platform, s.avatarUrl);
    return (
      <button
        key={itemKey}
        type="button"
        className={styles.railAvatarBtn}
        title={`${s.nickname}${s.liveStatus === "LIVE" ? " · 直播中" : ""}`}
        aria-label={s.nickname}
        onClick={(e) => handleClick(s, e.currentTarget)}
        onMouseEnter={(e) => onAvatarMouseEnter(s, e.currentTarget)}
        onMouseLeave={() => onAvatarMouseLeave(s)}
      >
        <span className={`${listStyles.avatarWrap} ${styles.railAvatarWrap}`}>
          <span className={avatarClass}>
            {avatarSrc ? (
              <img className={listStyles.avatarImg} src={avatarSrc} alt="" loading="lazy" decoding="async" draggable={false} />
            ) : (
              <span className={listStyles.avatarFallback}>{(s.nickname || "?").slice(0, 1)}</span>
            )}
          </span>
          <span className={`${listStyles.liveDot} ${listStyles.liveDotOnAvatar} ${liveDotClass} ${styles.railLiveDot}`} />
        </span>
      </button>
    );
  };

  return (
    <div className={styles.railShell}>
      {/* 迷你表头：顶部 Users 复用底部按钮质感（railFooterBtn），上下成同组 */}
      <div className={styles.railHeader} data-tauri-drag-region title="关注列表">
        {!isMac ? (
          <span className={`${styles.railHeaderIcon} ${styles.railFooterBtn}`} aria-hidden="true">
            <Users size={18} />
          </span>
        ) : null}
      </div>
      <div
        className={`${styles.railScroll}${isDragScrolling ? ` ${styles.railScrollDragging}` : ""}`}
        aria-label="关注主播"
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={endDragScroll}
        onPointerCancel={endDragScroll}
        onScroll={closePreview}
        onClickCapture={(e) => {
          if (!suppressClickRef.current) return;
          suppressClickRef.current = false;
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        {railGroups.length === 0 ? null : (
          <>
            {renderGroups(liveGroups)}
            {offlineCount > 0 && !offlineExpanded ? renderOfflineToggle(false) : null}
            <AnimatePresence initial={false}>
              {offlineExpanded ? (
                <m.div
                  className={styles.railOfflineGroup}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } }}
                  transition={{ duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }}
                >
                  {renderGroups(offlineGroups)}
                </m.div>
              ) : null}
            </AnimatePresence>
            {offlineCount > 0 && offlineExpanded ? renderOfflineToggle(true) : null}
          </>
        )}
      </div>

      <MultiviewSlotPicker
        anchor={pickerAnchor}
        onClose={() => setPickerAnchor(null)}
        onPick={(index, slot) => {
          multiview.assignSlot(index, slot);
          multiview.setAudioSlot(index);
        }}
      />

      {(() => {
        const hoverTarget = previewTarget;
        if (!hoverTarget || !previewPos) return null;
        const s = allStreamers.find((x) => `${x.platform}:${x.id}` === `${hoverTarget.platform}:${hoverTarget.id}`);
        if (!s) return null;
        const portalTarget = fsTarget ?? (typeof document !== "undefined" ? document.body : null);
        if (!portalTarget) return null;
        const avatarSrc = getAvatarSrc(s.platform, s.avatarUrl);
        return createPortal(
          <m.div
            className={styles.railPreview}
            style={{ left: previewPos.left, top: previewPos.top }}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            role="button"
            aria-label={`预览 ${s.nickname}`}
            onMouseEnter={() => {
              previewHoldRef.current = true;
              cancelPreviewClose();
            }}
            onMouseLeave={() => closePreview()}
            onClick={(e) => handleClick(s, e.currentTarget)}
          >
            <div className={styles.railPreviewHeader}>
              {avatarSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={styles.railPreviewAvatar} src={avatarSrc} alt="" />
              ) : (
                <span className={styles.railPreviewAvatarFallback}>{(s.nickname || "?").slice(0, 1)}</span>
              )}
              <div className={styles.railPreviewMeta}>
                <div className={styles.railPreviewName}>
                  <span className={styles.railPreviewLiveDot} aria-hidden="true" />
                  <span className={styles.railPreviewNameText} title={s.nickname}>
                    {s.nickname}
                  </span>
                </div>
                <div className={styles.railPreviewTitle} title={s.roomTitle || ""}>
                  {s.roomTitle || "暂无直播标题"}
                </div>
              </div>
            </div>
            <div className={styles.railPreviewVideo}>
              <HoverStreamPreview platform={s.platform} roomId={s.id} />
            </div>
          </m.div>,
          portalTarget
        );
      })()}
    </div>
  );
}
