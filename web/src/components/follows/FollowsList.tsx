"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, m, useMotionValue, useSpring } from "framer-motion";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, ChevronDown, Folder, FolderPlus, ListCollapse, Play, RotateCw, Users, VideoOff, X } from "lucide-react";
import { createPortal } from "react-dom";

import styles from "./FollowsList.module.css";
import { useFollow, type FollowListItem, type FollowedStreamer, type Platform as FollowPlatform } from "@/state/follow/FollowProvider";
import { useImageProxy } from "@/hooks/useImageProxy";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { useActiveRoom } from "@/components/follows/useActiveRoom";
import { useMultiview } from "@/state/multiview/MultiviewProvider";
import { MultiviewSlotPicker, type SlotPickerAnchor } from "@/components/player/multiview/MultiviewSlotPicker";
import { useFollowRefresh } from "@/state/follow/FollowRefreshProvider";
import { invoke } from "@tauri-apps/api/core";

export function normalizeFollowKey(key: string) {
  const [p, id] = String(key || "").split(":");
  return `${String(p || "").toUpperCase()}:${String(id || "")}`;
}

type DragData =
  | { kind: "top-streamer"; key: string; platform: string; id: string }
  | { kind: "top-folder"; folderId: string }
  | { kind: "child-streamer"; key: string; sourceFolderId: string; platform: string; id: string };

// 只与同 Kind 的条目做碰撞：顶层文件夹↔文件夹、主播↔主播；子行↔同文件夹的兄弟行。
// over 变化驱动 SortableContext 的兄弟让位动画；跨文件夹投递去向仍由
// elementFromPoint 的文件夹悬停检测决定，不走碰撞结果
const sameKindClosestCenter: CollisionDetection = (args) => {
  const data = args.active.data.current as DragData | undefined;
  let containers = args.droppableContainers;
  if (data && (data.kind === "top-streamer" || data.kind === "top-folder")) {
    const kind = data.kind;
    containers = containers.filter((c) => (c.data.current as DragData | undefined)?.kind === kind);
  } else if (data?.kind === "child-streamer") {
    const sourceFolderId = data.sourceFolderId;
    containers = containers.filter((c) => {
      const d = c.data.current as DragData | undefined;
      return d?.kind === "child-streamer" && d.sourceFolderId === sourceFolderId;
    });
  }
  return closestCenter({ ...args, droppableContainers: containers });
};

/** 头像右下角状态徽标：LIVE=绿底实心▶，OFFLINE=灰底摄像机关闭（形态区分），UNKNOWN=素圆点。
 *  compact：30px 级小头像用（搜索弹窗等），不依赖本模块 .resultAvatar 后代选择器 */
export function AvatarLiveBadge({ status, compact = false }: { status: FollowedStreamer["liveStatus"]; compact?: boolean }) {
  if (status === "UNKNOWN") {
    return <span className={`${styles.liveDot} ${styles.liveDotOnAvatar} ${styles.liveDotUnknown}`} aria-hidden="true" />;
  }
  const stateClass = status === "LIVE" ? styles.liveDotLive : styles.liveDotOffline;
  return (
    <span
      className={[
        styles.liveDot,
        styles.liveDotOnAvatar,
        styles.liveBadgeOnAvatar,
        compact ? styles.liveBadgeCompact : "",
        stateClass
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      {status === "LIVE" ? (
        <Play size={compact ? 7 : 9} fill="currentColor" strokeWidth={1} />
      ) : (
        <VideoOff size={compact ? 9 : 12} strokeWidth={2.6} />
      )}
    </span>
  );
}

export function FollowsList({ folded = false }: { folded?: boolean }) {
  const router = useRouter();
  const follow = useFollow();
  const { ensureProxyStarted, getAvatarSrc } = useImageProxy();
  const { refreshList, isRefreshing, progressCurrent, progressTotal } = useFollowRefresh();
  const playerOverlay = usePlayerOverlay();
  const activeRoom = useActiveRoom();
  const multiview = useMultiview();
  const activeStreamerKey = activeRoom ? `${activeRoom.platform}:${activeRoom.roomId}` : null;
  const [pickerAnchor, setPickerAnchor] = useState<SlotPickerAnchor | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const expandBtnRef = useRef<HTMLButtonElement | null>(null);

  const hoverOpacity = useMotionValue(0);
  const hoverYRaw = useMotionValue(0);
  const hoverHRaw = useMotionValue(38);
  const hoverY = useSpring(hoverYRaw, { stiffness: 520, damping: 44, mass: 0.7 });
  const hoverH = useSpring(hoverHRaw, { stiffness: 520, damping: 44, mass: 0.7 });

  const [showCheckIcon, setShowCheckIcon] = useState(false);
  const [isMac, setIsMac] = useState(false);

  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayAlignLeft, setOverlayAlignLeft] = useState(240);
  const [overlayDeleteMode, setOverlayDeleteMode] = useState(false);
  const [overlayFilter, setOverlayFilter] = useState<"ALL" | FollowPlatform>("ALL");
  const overlayAnchorCenterXRef = useRef<number | null>(null);
  const overlayPanelRef = useRef<HTMLDivElement | null>(null);

  const [folderNameModal, setFolderNameModal] = useState<{ open: boolean; mode: "create" | "rename"; folderId: string | null }>({ open: false, mode: "create", folderId: null });
  const [folderNameInput, setFolderNameInput] = useState("");
  const [folderMenu, setFolderMenu] = useState<{ open: boolean; x: number; y: number; folderId: string | null }>({ open: false, x: 0, y: 0, folderId: null });
  const [streamerMenu, setStreamerMenu] = useState<{ open: boolean; x: number; y: number; streamerKey: string | null }>({ open: false, x: 0, y: 0, streamerKey: null });
  const [folderDeleteConfirm, setFolderDeleteConfirm] = useState<{ open: boolean; folderId: string | null }>({ open: false, folderId: null });
  // 主列表项取关：两段式确认（第二次点击才生效，3 秒未确认自动复位）
  const [confirmUnfollowKey, setConfirmUnfollowKey] = useState<string | null>(null);
  const confirmUnfollowTimerRef = useRef<number | null>(null);
  const portalTarget = typeof document !== "undefined" ? document.body : null;

  const requestUnfollow = useCallback(
    (itemKey: string, platform: FollowPlatform, id: string) => {
      if (confirmUnfollowKey !== itemKey) {
        setConfirmUnfollowKey(itemKey);
        if (confirmUnfollowTimerRef.current != null) window.clearTimeout(confirmUnfollowTimerRef.current);
        confirmUnfollowTimerRef.current = window.setTimeout(() => {
          setConfirmUnfollowKey(null);
          confirmUnfollowTimerRef.current = null;
        }, 3000);
        return;
      }
      if (confirmUnfollowTimerRef.current != null) {
        window.clearTimeout(confirmUnfollowTimerRef.current);
        confirmUnfollowTimerRef.current = null;
      }
      setConfirmUnfollowKey(null);
      follow.unfollowStreamer(platform, id);
    },
    [confirmUnfollowKey, follow]
  );

  const listItems: FollowListItem[] = follow.listOrder;
  const allStreamers = follow.followedStreamers;
  const listItemsRef = useRef(listItems);
  const foldersRef = useRef(follow.folders);

  useEffect(() => {
    listItemsRef.current = listItems;
    foldersRef.current = follow.folders;
  }, [listItems, follow.folders]);

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

  const streamerByKey = useMemo(() => {
    const m = new Map<string, FollowedStreamer>();
    for (const s of allStreamers) m.set(`${s.platform}:${s.id}`, s);
    return m;
  }, [allStreamers]);

  const folderCounts = useCallback(
    (folderKeys: string[]) => {
      const seen = new Set<string>();
      let total = 0;
      let online = 0;
      for (const raw of folderKeys) {
        const key = normalizeFollowKey(raw);
        if (!key || seen.has(key)) continue;
        const s = streamerByKey.get(key);
        if (!s) continue;
        seen.add(key);
        total += 1;
        if (s.liveStatus === "LIVE") online += 1;
      }
      return { online, total };
    },
    [streamerByKey]
  );

  const onItemEnter = useCallback((el: HTMLElement) => {
    const root = listRef.current;
    if (!root) return;
    const rr = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    hoverYRaw.set(r.top - rr.top + root.scrollTop);
    hoverHRaw.set(r.height);
    hoverOpacity.set(1);
  }, [hoverHRaw, hoverOpacity, hoverYRaw]);

  // 手动刷新：调度与拉取都在 FollowRefreshProvider，这里只负责按钮态（转圈 → 对勾）
  const runManualRefresh = useCallback(async () => {
    const ran = await refreshList({ suppressNotifications: true });
    if (!ran) return;
    setShowCheckIcon(true);
    window.setTimeout(() => setShowCheckIcon(false), 1000);
  }, [refreshList]);

  const openOverlay = useCallback(() => {
    const btnRect = expandBtnRef.current?.getBoundingClientRect();
    const centerX = btnRect ? btnRect.left + btnRect.width / 2 : null;
    overlayAnchorCenterXRef.current = centerX;

    // Set an initial left; re-center precisely after panel is mounted/measured.
    const estimatedPanelWidth = 820;
    const requestedLeft = centerX != null ? Math.round(centerX - estimatedPanelWidth / 2) : 240;
    const fallbackMaxLeft = typeof window !== "undefined" ? Math.max(16, window.innerWidth - estimatedPanelWidth - 16) : requestedLeft;
    setOverlayAlignLeft(Math.max(16, Math.min(requestedLeft, fallbackMaxLeft)));
    setOverlayDeleteMode(false);
    setOverlayFilter("ALL");
    setOverlayOpen(true);
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlayOpen(false);
    setOverlayDeleteMode(false);
    // Escape / 背板关面板时，同步清掉大面板卡片可能挂起的槽位选择器
    setPickerAnchor(null);
  }, []);

  useEffect(() => {
    if (!overlayOpen) return;
    // Re-clamp left based on real panel width (align with old project behavior)
    const panelWidth = overlayPanelRef.current?.getBoundingClientRect().width ?? 0;
    if (typeof window !== "undefined" && panelWidth > 0) {
      const maxLeft = Math.max(16, window.innerWidth - panelWidth - 16);
      const centerX = overlayAnchorCenterXRef.current;
      const desired = centerX != null ? Math.round(centerX - panelWidth / 2) : null;
      setOverlayAlignLeft((v) => Math.max(16, Math.min(desired ?? v, maxLeft)));
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOverlay, overlayOpen]);

  const openCreateFolderModal = useCallback(() => {
    const nextName = `新文件夹 ${follow.folders.length + 1}`;
    setFolderNameInput(nextName);
    setFolderNameModal({ open: true, mode: "create", folderId: null });
  }, [follow.folders.length]);

  const openRenameFolderModal = useCallback(
    (folderId: string) => {
      const folder = follow.folders.find((f) => f.id === folderId);
      setFolderNameInput(folder?.name ?? "");
      setFolderNameModal({ open: true, mode: "rename", folderId });
    },
    [follow.folders]
  );

  const submitFolderNameModal = useCallback(() => {
    const trimmed = folderNameInput.trim();
    if (!trimmed) return;

    if (folderNameModal.mode === "create") {
      follow.createFolder(trimmed);
    } else if (folderNameModal.folderId) {
      follow.renameFolder(folderNameModal.folderId, trimmed);
    }
    setFolderNameModal({ open: false, mode: "create", folderId: null });
  }, [follow, folderNameInput, folderNameModal.folderId, folderNameModal.mode]);

  /* —— dnd-kit 拖拽状态（顶层排序 + 跨文件夹投递） —— */
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const activeDragRef = useRef<DragData | null>(null);
  const dragOverFolderIdRef = useRef<string | null>(null);
  const orderChangedRef = useRef(false);
  const didDragRef = useRef(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const topItemIds = useMemo(
    () => listItems.map((item) => (item.type === "folder" ? `f:${item.data.id}` : `s:${item.data.platform}:${item.data.id}`)),
    [listItems]
  );

  // 窗口失焦/隐藏时无法收到 pointerup：结清事务，防止悬挂的半次拖拽
  useEffect(() => {
    const abort = () => {
      if (!activeDragRef.current) return;
      if (orderChangedRef.current) follow.commitTransaction();
      else follow.rollbackTransaction();
      activeDragRef.current = null;
      dragOverFolderIdRef.current = null;
      orderChangedRef.current = false;
      setActiveDrag(null);
      setDragOverFolderId(null);
      document.body.style.userSelect = "";
    };
    const onBlur = () => abort();
    const onVis = () => {
      if (document.hidden) abort();
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [follow]);

  const handleStreamerClick = useCallback(
    (platform: FollowPlatform, id: string, sourceEl?: HTMLElement | null) => {
      if (didDragRef.current) return;
      if (multiview.isMultiview) {
        const rect = sourceEl?.getBoundingClientRect();
        if (!rect) return;
        const s = allStreamers.find((x) => x.platform === platform && x.id === id);
        setPickerAnchor({
          rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          slot: { platform: platform.toLowerCase(), roomId: id },
          streamer: s ? { nickname: s.nickname, avatarUrl: s.avatarUrl, platform: s.platform } : undefined
        });
        return;
      }
      playerOverlay.openPlayer({ platform: platform.toLowerCase(), roomId: id });
    },
    [allStreamers, multiview.isMultiview, playerOverlay]
  );

  const overlayPlatforms = useMemo(() => {
    const present = new Set<FollowPlatform>();
    for (const s of allStreamers) present.add(s.platform);
    const order: FollowPlatform[] = ["DOUYU", "HUYA", "DOUYIN", "BILIBILI"];
    return order.filter((p) => present.has(p));
  }, [allStreamers]);

  const overlayItems = useMemo(() => {
    const base = overlayFilter === "ALL" ? allStreamers : allStreamers.filter((s) => s.platform === overlayFilter);
    const rank = (status: FollowedStreamer["liveStatus"]) => {
      if (status === "LIVE") return 0;
      if (status === "UNKNOWN") return 1;
      return 2;
    };
    return base
      .map((s, idx) => ({ s, idx }))
      .sort((a, b) => {
        const diff = rank(a.s.liveStatus) - rank(b.s.liveStatus);
        if (diff !== 0) return diff;
        return a.idx - b.idx;
      })
      .map((x) => x.s);
  }, [allStreamers, overlayFilter]);

  const platformLabel = useCallback((p: "ALL" | FollowPlatform) => {
    if (p === "ALL") return "全部";
    if (p === "DOUYU") return "斗鱼";
    if (p === "HUYA") return "虎牙";
    if (p === "DOUYIN") return "抖音";
    if (p === "BILIBILI") return "B站";
    return p;
  }, []);

  // 文件夹悬停检测：elementFromPoint 命中指针下方元素（被拖行 pointer-events:none 穿透）
  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const data = event.active.data.current as DragData | undefined;
      if (data?.kind !== "top-streamer" && data?.kind !== "child-streamer") return;
      const activator = event.activatorEvent as PointerEvent;
      const px = activator.clientX + event.delta.x;
      const py = activator.clientY + event.delta.y;
      const el = document.elementFromPoint(px, py) as HTMLElement | null;
      const folderEl = el?.closest("[data-folder-id]") as HTMLElement | null;
      const folderId = folderEl?.getAttribute("data-folder-id") || null;
      const exists = folderId
        ? (foldersRef.current.find((f) => f.id === folderId)?.streamerIds.some((x) => normalizeFollowKey(x) === normalizeFollowKey(data.key)) ?? false)
        : false;
      const next = folderId && !exists ? folderId : null;
      if (next !== dragOverFolderIdRef.current) {
        dragOverFolderIdRef.current = next;
        setDragOverFolderId(next);
      }
    },
    []
  );

  // 顶层同 Kind 实时重排：文件夹只与文件夹换位、主播只与主播换位，天然防止主播越过文件夹
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const aData = event.active.data.current as DragData | undefined;
      if (aData?.kind !== "top-streamer" && aData?.kind !== "top-folder") return;
      if (!event.over || event.over.id === event.active.id) return;
      const oData = event.over.data.current as DragData | undefined;
      if (oData?.kind !== aData.kind) return;
      const idOf = (it: FollowListItem) => (it.type === "folder" ? `f:${it.data.id}` : `s:${it.data.platform}:${it.data.id}`);
      const oldIndex = listItemsRef.current.findIndex((it) => idOf(it) === event.active.id);
      const newIndex = listItemsRef.current.findIndex((it) => idOf(it) === event.over!.id);
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
      follow.updateListOrder(arrayMove(listItemsRef.current, oldIndex, newIndex));
      orderChangedRef.current = true;
    },
    [follow]
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      follow.beginTransaction();
      const data = event.active.data.current as DragData | undefined;
      activeDragRef.current = data ?? null;
      orderChangedRef.current = false;
      dragOverFolderIdRef.current = null;
      setActiveDrag(data ?? null);
      setDragOverFolderId(null);
      document.body.style.userSelect = "none";
    },
    [follow]
  );

  const finishDrag = useCallback(
    (committed: boolean) => {
      if (committed) follow.commitTransaction();
      else follow.rollbackTransaction();
      activeDragRef.current = null;
      dragOverFolderIdRef.current = null;
      orderChangedRef.current = false;
      setActiveDrag(null);
      setDragOverFolderId(null);
      document.body.style.userSelect = "";
      didDragRef.current = true;
      window.setTimeout(() => {
        didDragRef.current = false;
      }, 0);
    },
    [follow]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const data = event.active.data.current as DragData | undefined;
      const activator = event.activatorEvent as PointerEvent;
      const px = activator.clientX + event.delta.x;
      const py = activator.clientY + event.delta.y;
      if (data?.kind === "child-streamer") {
        // 松手位置仍在源文件夹内 → 回滚（微移不代表要移出）
        const srcEl = document.querySelector(`[data-folder-id="${data.sourceFolderId}"]`) as HTMLElement | null;
        const r = srcEl?.getBoundingClientRect();
        const insideSource = !!r && px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
        if (insideSource) {
          finishDrag(false);
          return;
        }
        if (dragOverFolderIdRef.current && dragOverFolderIdRef.current !== data.sourceFolderId) {
          follow.moveStreamerToFolder(data.key, dragOverFolderIdRef.current);
          finishDrag(true);
          return;
        }
        // 移出到顶层
        follow.removeStreamerFromFolderByKey(data.key, data.sourceFolderId);
        finishDrag(true);
        return;
      }
      if (data?.kind === "top-streamer" && dragOverFolderIdRef.current) {
        // 顶层主播投递进文件夹（悬停高亮来自 onDragMove 的 elementFromPoint 检测）
        follow.moveStreamerToFolder(data.key, dragOverFolderIdRef.current);
        finishDrag(true);
        return;
      }
      finishDrag(orderChangedRef.current);
    },
    [finishDrag, follow]
  );

  const handleDragCancel = useCallback(() => finishDrag(false), [finishDrag]);

  // 行的视觉主体（不含拖拽 wrapper）：ref/listeners 由 TopSortableRow / ChildSortableRow 注入
  const renderStreamerBody = (
    s: FollowedStreamer,
    itemKey: string,
    opts: { fromFolder?: boolean; isActive?: boolean; isDragging?: boolean; onEnter?: (el: HTMLElement) => void; onLeave?: () => void }
  ) => {
    const dragKey = `${s.platform}:${s.id}`;
    const avatarSrc = getAvatarSrc(s.platform, s.avatarUrl);
    const inFolder = !!opts.fromFolder;
    const isActive = !!opts.isActive;
    const isLive = s.liveStatus === "LIVE";
    const itemClass = `${styles.streamerItem}${inFolder ? ` ${styles.streamerItemInFolder}` : ""}${isActive ? ` ${styles.streamerItemActive}` : ""}${opts.isDragging ? ` ${styles.streamerItemDragging}` : ""}`;
    const avatarClass = `${styles.avatar}${isActive ? ` ${styles.avatarActive}` : ""}`;
    const nameClass = `${styles.name}${isLive ? ` ${styles.nameLive}` : ""}`;
    return (
      <div
        className={itemClass}
        role="button"
        tabIndex={0}
        data-active={isActive ? "true" : undefined}
        aria-current={isActive ? "true" : undefined}
        onClick={(e) => handleStreamerClick(s.platform, s.id, e.currentTarget)}
        onContextMenu={(e) => {
          e.preventDefault();
          setStreamerMenu({ open: true, x: e.clientX, y: e.clientY, streamerKey: dragKey });
        }}
      >
        <span className={styles.avatarWrap} aria-hidden="true">
          <span className={avatarClass}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {avatarSrc ? (
              <img className={styles.avatarImg} src={avatarSrc} alt={s.nickname} loading="lazy" decoding="async" draggable={false} />
            ) : (
              <span className={styles.avatarFallback}>{(s.nickname || "?").slice(0, 1)}</span>
            )}
          </span>
          <AvatarLiveBadge status={s.liveStatus} />
        </span>
        <div className={styles.meta}>
          <div className={nameClass} title={s.nickname}>
            {s.nickname}
          </div>
          <div className={styles.sub} title={s.roomTitle || ""}>
            {s.roomTitle || "暂无直播标题"}
          </div>
        </div>
        {!activeDrag ? (
          <button
            type="button"
            data-slot="button"
            className={`${styles.itemRemoveBtn}${confirmUnfollowKey === itemKey ? ` ${styles.itemRemoveBtnConfirm}` : ""}`}
            title={confirmUnfollowKey === itemKey ? "再次点击确认取消关注" : "取消关注"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              requestUnfollow(itemKey, s.platform, s.id);
            }}
          >
            {confirmUnfollowKey === itemKey ? (
              <span className={styles.itemRemoveBtnLabel}>确认</span>
            ) : (
              <X size={12} strokeWidth={2.5} />
            )}
          </button>
        ) : null}
      </div>
    );
  };

  function clearHoverHighlight() {
    hoverOpacity.set(0);
  }

  return (
    <div className={styles.followList} data-collapsed={folded ? "true" : undefined}>
      <div className={styles.listHeader} ref={headerRef} data-tauri-drag-region>
        <div className={styles.headerLeft} data-tauri-drag-region>
          {!isMac ? (
            <span className={`${styles.actionBtn} ${styles.headerStaticIcon}`} aria-hidden="true">
              <Users size={18} />
            </span>
          ) : null}
          <h3 className={styles.headerTitle} aria-label="关注列表" data-tauri-drag-region>
            <span className={styles.headerLabel} data-tauri-drag-region />
          </h3>
        </div>
        <div className={styles.headerActions} data-tauri-drag-region="false">
          {!isRefreshing ? (
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.refreshBtn}`}
              data-tauri-drag-region="false"
              title="刷新列表"
              onClick={() => void runManualRefresh()}
            >
              {showCheckIcon ? <Check size={18} /> : <RotateCw size={18} />}
            </button>
          ) : (
            <span className={styles.progressWithSpinner} aria-live="polite">
              <span className={styles.spinner} aria-hidden="true" />
              <span>
                {progressCurrent}/{progressTotal}
              </span>
            </span>
          )}

          <button
            type="button"
            className={`${styles.actionBtn} ${styles.folderBtn}`}
            data-tauri-drag-region="false"
            title="新建文件夹"
            onClick={openCreateFolderModal}
          >
            <FolderPlus size={18} />
          </button>

          <button
            type="button"
            className={`${styles.actionBtn} ${styles.expandBtn}`}
            data-tauri-drag-region="false"
            title="展开关注列表"
            ref={expandBtnRef}
            onClick={openOverlay}
          >
            <ListCollapse size={18} />
          </button>
        </div>
      </div>

      <div
        className={styles.listContent}
        ref={listRef}
        onScroll={() => hoverOpacity.set(0)}
        onMouseLeave={() => hoverOpacity.set(0)}
      >
        <m.div
          className={styles.hoverHighlight}
          style={{ opacity: hoverOpacity, y: hoverY, height: hoverH }}
        />

        <div className={`${styles.streamersList} ${activeDrag ? styles.draggingList : ""}`}>
          {listItems.length === 0 ? (
            <div style={{ padding: 18, color: "var(--secondary-text)", fontWeight: 800, textAlign: "center" }}>
              暂无关注主播
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={sameKindClosestCenter}
              onDragStart={handleDragStart}
              onDragMove={handleDragMove}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext items={topItemIds} strategy={rectSortingStrategy}>
                <AnimatePresence initial={false}>
                  {listItems.map((item) => {
                    if (item.type === "streamer") {
                      const key = `${item.data.platform}:${item.data.id}`;
                      const latest = streamerByKey.get(key) ?? item.data;
                      return (
                        <TopSortableRow key={key} id={`s:${key}`} data={{ kind: "top-streamer", key, platform: item.data.platform, id: item.data.id }}>
                          {(api) =>
                            renderStreamerBody(latest, key, { isActive: activeStreamerKey === key, isDragging: api.isDragging })
                          }
                        </TopSortableRow>
                      );
                    }

                    const folder = item.data;
                    const expanded = folder.expanded !== false;
                    const counts = folderCounts(folder.streamerIds);
                    const childDraggingThis = activeDrag?.kind === "child-streamer" && activeDrag.sourceFolderId === folder.id;
                    return (
                      <FolderSortable
                        key={`folder_${folder.id}`}
                        folderId={folder.id}
                        expanded={expanded}
                        dragOver={dragOverFolderId === folder.id}
                        childDragging={childDraggingThis}
                        onHeaderClick={() => {
                          if (didDragRef.current) return;
                          follow.toggleFolderExpanded(folder.id);
                        }}
                        onHeaderContextMenu={(e) => {
                          e.preventDefault();
                          setFolderMenu({ open: true, x: e.clientX, y: e.clientY, folderId: folder.id });
                        }}
                        clearHoverHighlight={clearHoverHighlight}
                        header={
                          <>
                            <Folder size={16} className={`${styles.folderIcon} ${expanded ? styles.folderIconExpanded : ""}`} />
                            <span className={styles.folderName} title={folder.name}>
                              {folder.name}
                            </span>
                            <span className={styles.folderCount}>
                              {counts.online}/{counts.total}
                            </span>
                            <m.span
                              className={styles.expandIcon}
                              animate={{ rotate: expanded ? 180 : 0 }}
                              transition={{ duration: 0.2, ease: [0.25, 0.8, 0.4, 1] }}
                              aria-hidden="true"
                            >
                              <ChevronDown size={12} />
                            </m.span>
                          </>
                        }
                      >
                        <SortableContext
                          items={[...folder.streamerIds]
                            .sort((a, b) => {
                              const sa = streamerByKey.get(normalizeFollowKey(a));
                              const sb = streamerByKey.get(normalizeFollowKey(b));
                              return (sa?.liveStatus === "LIVE" ? 0 : 1) - (sb?.liveStatus === "LIVE" ? 0 : 1);
                            })
                            .map((k) => `c:${folder.id}:${k}`)}
                          strategy={rectSortingStrategy}
                        >
                          <FolderChildren
                            expanded={expanded}
                            folderId={folder.id}
                            streamerKeys={folder.streamerIds}
                            normalizeKey={normalizeFollowKey}
                            streamerByKey={streamerByKey}
                            overflowVisible={childDraggingThis}
                            render={(s, itemKey, handlers) => {
                              const cKey = `${s.platform}:${s.id}`;
                              return (
                                <ChildSortableRow
                                  key={itemKey}
                                  id={`c:${folder.id}:${cKey}`}
                                  data={{ kind: "child-streamer", key: cKey, sourceFolderId: folder.id, platform: s.platform, id: s.id }}
                                  motionProps={{
                                    onMouseEnter: (e) => handlers.onEnter(e.currentTarget),
                                    onMouseLeave: () => handlers.onLeave()
                                  }}
                                >
                                  {(api) =>
                                    renderStreamerBody(s, itemKey, {
                                      fromFolder: true,
                                      isActive: activeStreamerKey === cKey,
                                      isDragging: api.isDragging,
                                      onEnter: handlers.onEnter,
                                      onLeave: handlers.onLeave
                                    })
                                  }
                                </ChildSortableRow>
                              );
                            }}
                          />
                        </SortableContext>
                      </FolderSortable>
                    );
                  })}
                </AnimatePresence>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

      {portalTarget
        ? createPortal(
            <AnimatePresence>
              {overlayOpen ? (
                <m.div
                  className={styles.overlayBackdrop}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) closeOverlay();
                  }}
                >
                  <div className={styles.followOverlayAnchor}>
                    <m.div
                      className={styles.followOverlayPanel}
                      ref={overlayPanelRef}
                      initial={{ opacity: 0, scale: 0.96, y: 16 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.96, y: 16 }}
                      transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                <button type="button" className={styles.followOverlayCloseBtn} title="关闭" onClick={closeOverlay}>
                  <X size={18} />
                </button>

                <div className={styles.followOverlayHeader}>
                  <div className={styles.followOverlayFilters}>
                    <button
                      type="button"
                      className={`${styles.filterChip} ${overlayFilter === "ALL" ? styles.filterChipActive : ""}`}
                      onClick={() => setOverlayFilter("ALL")}
                    >
                      {platformLabel("ALL")}
                    </button>
                    {overlayPlatforms.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`${styles.filterChip} ${overlayFilter === p ? styles.filterChipActive : ""}`}
                        onClick={() => setOverlayFilter(p)}
                      >
                        {platformLabel(p)}
                      </button>
                    ))}
                  </div>
                  <div className={styles.followOverlayActions}>
                    <button
                      type="button"
                      className={`${styles.overlayTextBtn} ${overlayDeleteMode ? styles.overlayTextBtnActive : ""}`}
                      onClick={() => setOverlayDeleteMode((v) => !v)}
                    >
                      {overlayDeleteMode ? "完成" : "管理"}
                    </button>
                    <button
                      type="button"
                      className={`${styles.overlayTextBtn} ${isRefreshing ? styles.overlayTextBtnRefreshing : ""}`}
                      disabled={isRefreshing}
                      onClick={() => void runManualRefresh()}
                    >
                      <span>刷新</span>
                      <span className={styles.overlaySpinner} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div className={styles.followOverlayContent}>
                  {overlayItems.length === 0 ? (
                    <div className={styles.followOverlayEmpty}>
                      <div className={styles.emptyTitle}>暂无关注主播</div>
                      <div className={styles.emptyText}>当前筛选下暂无关注主播</div>
                    </div>
                  ) : (
                    <div className={styles.followOverlayGrid}>
                      {overlayItems.map((s) => {
                        const avatarSrc = getAvatarSrc(s.platform, s.avatarUrl);
                        const liveText = s.liveStatus === "LIVE" ? "直播中" : s.liveStatus === "OFFLINE" ? "离线" : "未知";
                        const roomTitle = s.roomTitle || "暂无直播标题";
                        const isActive = activeStreamerKey === `${s.platform}:${s.id}`;
                        const cardClass = `${styles.followOverlayCard}${overlayDeleteMode ? ` ${styles.followOverlayCardManage}` : ""}${isActive ? ` ${styles.followOverlayCardActive}` : ""}`;
                        return (
                          <div
                            key={`${s.platform}:${s.id}`}
                            className={cardClass}
                            data-active={isActive ? "true" : undefined}
                            aria-current={isActive ? "true" : undefined}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => {
                              if (overlayDeleteMode) return;
                              if (multiview.isMultiview) {
                                // 多屏：与主列表一致弹槽位选择器替换指定窗口；面板保持开启，便于连续替换另一格
                                handleStreamerClick(s.platform, s.id, e.currentTarget);
                                return;
                              }
                              playerOverlay.openPlayer({ platform: s.platform.toLowerCase(), roomId: s.id });
                              closeOverlay();
                            }}
                          >
                            {overlayDeleteMode ? (
                              <button
                                type="button"
                                className={styles.followOverlayRemoveBtn}
                                title="删除"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  follow.unfollowStreamer(s.platform, s.id);
                                }}
                              >
                                ×
                              </button>
                            ) : null}
                            <div className={styles.followOverlayCardTop}>
                              <div className={styles.resultAvatar}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                {avatarSrc ? <img className={styles.resultAvatarImg} src={avatarSrc} alt={s.nickname} /> : <div className={styles.resultAvatarFallback}>{(s.nickname || "?").slice(0, 1)}</div>}
                                <AvatarLiveBadge status={s.liveStatus} />
                              </div>
                              <div className={styles.resultMain}>
                                <div className={styles.resultName} title={s.nickname}>
                                  {s.nickname}
                                </div>
                              <div className={styles.resultTitle} title={`${platformLabel(s.platform)} · ${liveText} · ${roomTitle}`}>
                                {platformLabel(s.platform)} · {liveText} · {roomTitle}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    </div>
                  )}
                </div>
                    </m.div>
                  </div>
                </m.div>
              ) : null}
            </AnimatePresence>,
            portalTarget
          )
        : null}

      {portalTarget
        ? createPortal(
            <AnimatePresence>
              {folderNameModal.open ? (
                <m.div
                  className={styles.modalBackdrop}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onMouseDown={() => setFolderNameModal({ open: false, mode: "create", folderId: null })}
                >
                  <m.div
                    className={styles.modalPanel}
                    initial={{ opacity: 0, scale: 0.98, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: 8 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
              <div className={styles.modalHeader}>
                <div className={styles.modalTitle}>{folderNameModal.mode === "create" ? "新建文件夹" : "重命名文件夹"}</div>
                <button type="button" className={styles.miniBtn} title="关闭" onClick={() => setFolderNameModal({ open: false, mode: "create", folderId: null })}>
                  <X size={14} />
                </button>
              </div>
              <div className={styles.modalBody}>
                <input
                  className={styles.textInput}
                  value={folderNameInput}
                  autoFocus
                  placeholder="输入文件夹名称"
                  onChange={(e) => setFolderNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitFolderNameModal();
                    if (e.key === "Escape") setFolderNameModal({ open: false, mode: "create", folderId: null });
                  }}
                />
              </div>
              <div className={styles.modalFooter}>
                <button type="button" className={styles.secondaryBtn} onClick={() => setFolderNameModal({ open: false, mode: "create", folderId: null })}>
                  取消
                </button>
                <button type="button" className={styles.primaryBtn} onClick={submitFolderNameModal}>
                  确定
                </button>
              </div>
                  </m.div>
                </m.div>
              ) : null}
            </AnimatePresence>,
            portalTarget
          )
        : null}

      <AnimatePresence>
        {folderMenu.open ? (
          <m.div
            className={styles.menuBackdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={() => setFolderMenu((m) => ({ ...m, open: false }))}
          >
            <m.div
              className={styles.contextMenu}
              style={{ left: folderMenu.x, top: folderMenu.y }}
              initial={{ opacity: 0, scale: 0.98, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 4 }}
              transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  if (folderMenu.folderId) openRenameFolderModal(folderMenu.folderId);
                  setFolderMenu((m) => ({ ...m, open: false }));
                }}
              >
                重命名
              </button>
              <button
                type="button"
                className={`${styles.menuItem} ${styles.menuDanger}`}
                onClick={() => {
                  setFolderDeleteConfirm({ open: true, folderId: folderMenu.folderId });
                  setFolderMenu((m) => ({ ...m, open: false }));
                }}
              >
                删除
              </button>
            </m.div>
          </m.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {streamerMenu.open ? (
          <m.div
            className={styles.menuBackdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={() => setStreamerMenu((m) => ({ ...m, open: false }))}
          >
            <m.div
              className={styles.contextMenu}
              style={{ left: streamerMenu.x, top: streamerMenu.y }}
              initial={{ opacity: 0, scale: 0.98, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 4 }}
              transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  if (streamerMenu.streamerKey) {
                    void invoke("open_stats_window_cmd", { streamer: streamerMenu.streamerKey }).catch(() => {});
                  }
                  setStreamerMenu((m) => ({ ...m, open: false }));
                }}
              >
                查看观看统计
              </button>
              <button
                type="button"
                className={`${styles.menuItem} ${styles.menuDanger}`}
                onClick={() => {
                  const key = streamerMenu.streamerKey ?? "";
                  const [platform, id] = key.split(":");
                  if (platform && id) follow.unfollowStreamer(platform as FollowPlatform, id);
                  setStreamerMenu((m) => ({ ...m, open: false }));
                }}
              >
                取消关注
              </button>
            </m.div>
          </m.div>
        ) : null}
      </AnimatePresence>

      {portalTarget
        ? createPortal(
            <AnimatePresence>
              {folderDeleteConfirm.open ? (
                <m.div
                  className={styles.modalBackdrop}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onMouseDown={() => setFolderDeleteConfirm({ open: false, folderId: null })}
                >
                  <m.div
                    className={styles.modalPanel}
                    initial={{ opacity: 0, scale: 0.98, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: 8 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
              <div className={styles.modalHeader}>
                <div className={styles.modalTitle}>删除文件夹</div>
                <button type="button" className={styles.miniBtn} title="关闭" onClick={() => setFolderDeleteConfirm({ open: false, folderId: null })}>
                  <X size={14} />
                </button>
              </div>
              <div className={styles.modalBody} style={{ color: "var(--secondary-text)", fontWeight: 800 }}>
                删除后，文件夹里的主播会回到主列表。
              </div>
              <div className={styles.modalFooter}>
                <button type="button" className={styles.secondaryBtn} onClick={() => setFolderDeleteConfirm({ open: false, folderId: null })}>
                  取消
                </button>
                <button
                  type="button"
                  className={styles.dangerBtn}
                  onClick={() => {
                    if (folderDeleteConfirm.folderId) follow.deleteFolder(folderDeleteConfirm.folderId);
                    setFolderDeleteConfirm({ open: false, folderId: null });
                  }}
                >
                  删除
                </button>
              </div>
                  </m.div>
                </m.div>
              ) : null}
            </AnimatePresence>,
            portalTarget
          )
        : null}

      {/* 多屏状态下点击关注项：弹出 macOS 风格的"槽位选择器" */}
      <MultiviewSlotPicker
        anchor={pickerAnchor}
        onClose={() => setPickerAnchor(null)}
        onPick={(index, slot) => {
          multiview.assignSlot(index, slot);
          multiview.setAudioSlot(index);
        }}
      />
    </div>
  );
}

function FolderChildren({
  expanded,
  folderId,
  streamerKeys,
  normalizeKey,
  streamerByKey,
  overflowVisible = false,
  render
}: {
  expanded: boolean;
  folderId: string;
  streamerKeys: string[];
  normalizeKey: (key: string) => string;
  streamerByKey: Map<string, FollowedStreamer>;
  /** 源文件夹子行被拖出时放开裁剪，让头像能跟手拖出卡片（平时保持 hidden 供展开/收起动画裁剪） */
  overflowVisible?: boolean;
  render: (s: FollowedStreamer, itemKey: string, handlers: { onEnter: (el: HTMLElement) => void; onLeave: () => void }) => React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);

  const hoverOpacity = useMotionValue(0);
  const hoverYRaw = useMotionValue(0);
  const hoverHRaw = useMotionValue(38);
  const hoverY = useSpring(hoverYRaw, { stiffness: 520, damping: 44, mass: 0.7 });
  const hoverH = useSpring(hoverHRaw, { stiffness: 520, damping: 44, mass: 0.7 });

  const orderedStreamerKeys = useMemo(() => {
    const live: string[] = [];
    const rest: string[] = [];
    for (const key of streamerKeys) {
      const normKey = normalizeKey(key);
      const s = streamerByKey.get(normKey);
      if (s?.liveStatus === "LIVE") live.push(key);
      else rest.push(key);
    }
    return [...live, ...rest];
  }, [normalizeKey, streamerByKey, streamerKeys]);

  useLayoutEffect(() => {
    if (!expanded) {
      setHeight(0);
      hoverOpacity.set(0);
      return;
    }

    const el = innerRef.current;
    const panel = panelRef.current;
    if (!el || !panel) return;

    const update = () => {
      const s = window.getComputedStyle(panel);
      const padTop = Number.parseFloat(s.paddingTop || "0") || 0;
      const padBottom = Number.parseFloat(s.paddingBottom || "0") || 0;
      setHeight(el.scrollHeight + padTop + padBottom);
    };
    update();

    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, hoverOpacity]);

  const onEnter = useCallback((el: HTMLElement) => {
    const root = panelRef.current;
    if (!root) return;
    const rr = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    hoverYRaw.set(r.top - rr.top + root.scrollTop);
    hoverHRaw.set(r.height);
    hoverOpacity.set(1);
  }, [hoverHRaw, hoverOpacity, hoverYRaw]);

  const onLeave = useCallback(() => {
    hoverOpacity.set(0);
  }, [hoverOpacity]);

  return (
    <AnimatePresence initial={false}>
      {expanded ? (
        <m.div
          className={styles.folderContent}
          ref={panelRef}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height, opacity: 1 }}
          exit={{ height: 0, opacity: 0, transition: { type: "tween", duration: 0.24, ease: [0.64, 0, 0.78, 0.39] } }}
          transition={{ type: "tween", duration: 0.24, ease: [0.22, 0.61, 0.36, 1] }}
          style={{ overflow: overflowVisible ? "visible" : "hidden" }}
          onMouseLeave={onLeave}
        >
          <m.div
            className={styles.folderHoverHighlight}
            style={{ opacity: hoverOpacity, y: hoverY, height: hoverH }}
          />
          <div ref={innerRef} className={styles.folderItemsInner}>
            {orderedStreamerKeys.map((key) => {
              const normKey = normalizeKey(key);
              const s = streamerByKey.get(normKey);
              if (!s) return null;
              const itemKey = `${normKey}@folder:${folderId}`;
              return render(s, itemKey, { onEnter, onLeave });
            })}
          </div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

/* —— dnd-kit 包装组件 ——

   顶层行（主播/文件夹）与文件夹子行都走 useSortable：拖拽中的行跟随鼠标、
   兄弟行让位动画由库内 transform + transition 完成。子行仅在所属文件夹内排序；
   跨文件夹投递（悬停高亮 + 松手落位）由 onDragMove 的 elementFromPoint 检测 +
   onDragEnd 的源文件夹矩形判定决定。拖拽中的行必须 pointer-events:none，
   让 elementFromPoint 能穿透命中下方文件夹。 */

function TopSortableRow({
  id,
  data,
  children
}: {
  id: string;
  data: DragData;
  children: (api: { isDragging: boolean }) => React.ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, data });
  return (
    <m.div
      ref={setNodeRef}
      className={`${styles.listItemWrapper}${isDragging ? ` ${styles.listItemWrapperDragging}` : ""}`}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } }}
      transition={{ duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }}
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {children({ isDragging })}
    </m.div>
  );
}

function ChildSortableRow({
  id,
  data,
  motionProps,
  children
}: {
  id: string;
  data: DragData;
  motionProps: { onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void; onMouseLeave?: () => void };
  children: (api: { isDragging: boolean }) => React.ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, data });
  return (
    <m.div
      ref={setNodeRef}
      className={`${styles.listItemWrapper}${isDragging ? ` ${styles.listItemWrapperDragging}` : ""}`}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } }}
      transition={{ duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }}
      {...motionProps}
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {children({ isDragging })}
    </m.div>
  );
}

function FolderSortable({
  folderId,
  expanded,
  dragOver,
  childDragging,
  onHeaderClick,
  onHeaderContextMenu,
  clearHoverHighlight,
  header,
  children
}: {
  folderId: string;
  expanded: boolean;
  dragOver: boolean;
  childDragging?: boolean;
  onHeaderClick: () => void;
  onHeaderContextMenu: (e: React.MouseEvent) => void;
  clearHoverHighlight: () => void;
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: `f:${folderId}`,
    data: { kind: "top-folder", folderId }
  });
  return (
    <div
      ref={setNodeRef}
      data-folder-id={folderId}
      className={`${styles.folderItem}${expanded ? ` ${styles.folderItemExpanded}` : ""}${dragOver ? ` ${styles.folderItemDragOver}` : ""}${isDragging ? ` ${styles.folderItemDragging}` : ""}${childDragging ? ` ${styles.folderItemChildDragging}` : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onMouseEnter={clearHoverHighlight}
    >
      <div
        className={styles.folderHeader}
        ref={setActivatorNodeRef}
        {...listeners}
        role="button"
        tabIndex={0}
        onClick={onHeaderClick}
        onContextMenu={onHeaderContextMenu}
      >
        {header}
      </div>
      {children}
    </div>
  );
}
