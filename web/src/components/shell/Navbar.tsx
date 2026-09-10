"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ChevronDown, LayoutGrid, Search, Users, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";

import styles from "./Navbar.module.css";
import type { SearchPlatform } from "@/services/search";
import { usePlayerUi } from "@/state/playerUi/PlayerUiProvider";
import { useFollow, type Platform as FollowPlatform } from "@/state/follow/FollowProvider";
import { Platform } from "@/platforms/common/types";
import { PlatformIcon } from "@/components/common/PlatformIcon";
import { useCustomCategories } from "@/state/customCategories/CustomCategoriesProvider";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { useSearchSpotlight } from "@/hooks/useSearchSpotlight";

type UiPlatform = "douyu" | "douyin" | "huya" | "bilibili" | "custom" | "follows";

const followsPlatform = { id: "follows" as const, name: "关注" };

const basePlatforms: Array<{ id: Exclude<UiPlatform, "custom" | "follows">; name: string }> = [
  { id: "douyu", name: "斗鱼" },
  { id: "huya", name: "虎牙" },
  { id: "douyin", name: "抖音" },
  { id: "bilibili", name: "B站" }
];

const customPlatform = { id: "custom" as const, name: "自定义" };

function WinCaptionMinimizeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 12h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function WinCaptionMaximizeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function WinCaptionRestoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 7.5h8a2 2 0 0 1 2 2v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="5.5" y="9.5" width="11" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function WinCaptionCloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 7l10 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M17 7L7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Navbar({
  theme,
  activePlatform,
  onPlatformChange
}: {
  theme: "light" | "dark";
  activePlatform: UiPlatform;
  onPlatformChange: (p: UiPlatform) => void;
}) {
  const pathname = usePathname();
  const [isWindows, setIsWindows] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const playerUi = usePlayerUi();
  const playerOverlay = usePlayerOverlay();
  const follow = useFollow();
  const custom = useCustomCategories();

  const showCustomTab = custom.hydrated && custom.entries.length > 0;
  const visiblePlatforms = useMemo(() => {
    // 关注页固定最前；有自定义分区时紧随其后（对齐老项目自定义置前的习惯）
    if (showCustomTab) return [followsPlatform, customPlatform, ...basePlatforms];
    return [followsPlatform, ...basePlatforms];
  }, [showCustomTab]);

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [highlight, setHighlight] = useState<{ width: number; x: number; opacity: number }>({ width: 0, x: 0, opacity: 0 });

  const highlightMotionWithOpacity = useMemo(
    () => ({
      width: highlight.width,
      x: highlight.x,
      opacity: highlight.opacity,
      scale: highlight.opacity ? 1 : 0.96
    }),
    [highlight]
  );

  // Spotlight 平台 chip 的滑动胶囊在 useSearchSpotlight 内部自管（spans 渲染也搬过去了），
  // 这里不再需要 ref 与 effect 联动。

  const isPlayerRoute = (pathname ?? "").startsWith("/player");
  const isPlayerOpen = isPlayerRoute || playerOverlay.isOpen;

  const openInMain = useCallback(
    (platform: string, roomId: string) => {
      playerOverlay.openPlayer({ platform, roomId });
    },
    [playerOverlay]
  );

  const openInStandalone = useCallback((platform: string, roomId: string) => {
    void (async () => {
      try {
        await invoke("open_player_window_cmd", { platform: String(platform).toLowerCase(), roomId });
      } catch {
        // ignore: 没装 tauri / 调用失败都不阻塞
      }
    })();
  }, []);

  const inlinePlatform: SearchPlatform | null = useMemo(() => {
    if (activePlatform === "bilibili") return "bilibili";
    if (activePlatform === "huya") return "huya";
    if (activePlatform === "douyu") return "douyu";
    return null; // custom / douyin：内联模式暂不搜索
  }, [activePlatform]);

  const spotlight = useSearchSpotlight({
    inlinePlatform,
    activePlatformLabel: activePlatform,
    onSelectInMain: openInMain,
    onSelectInStandalone: openInStandalone
  });

  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [playerSearchOpen, setPlayerSearchOpen] = useState(true);
  const navbarInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isPlayerOpen) {
      setPlayerSearchOpen(false);
      spotlight.actions.close();
      setIsSearchFocused(false);
    } else {
      setPlayerSearchOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlayerOpen]);

  const openPlayerSearch = useCallback(() => {
    setPlayerSearchOpen(true);
    window.requestAnimationFrame(() => {
      navbarInputRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const osMod: any = await import("@tauri-apps/plugin-os");
        const p = typeof osMod?.platform === "function" ? await osMod.platform() : "";
        if (cancelled) return;
        const platform = String(p).toLowerCase();
        setIsWindows(platform === "windows" || platform === "linux");
      } catch {
        // non-tauri env: ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isWindows) return;
    let cancelled = false;
    let unlisten: null | (() => void) = null;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        try {
          const max = await win.isMaximized();
          if (!cancelled) setIsMaximized(!!max);
        } catch {
          // ignore
        }
        try {
          unlisten = await win.onResized(async () => {
            try {
              const max = await win.isMaximized();
              setIsMaximized(!!max);
            } catch {
              // ignore
            }
          });
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
      try {
        unlisten?.();
      } catch {
        // ignore
      }
    };
  }, [isWindows]);

  const minimizeWindow = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch {
      // ignore
    }
  }, []);

  const toggleMaximizeWindow = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const max = await win.isMaximized();
      if (max) await win.unmaximize();
      else await win.maximize();
      setIsMaximized(!max);
    } catch {
      // ignore
    }
  }, []);

  const closeWindow = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {
      // ignore
    }
  }, []);

  const updateHighlight = useCallback(() => {
    const el = tabRefs.current[activePlatform];
    const container = containerRef.current;
    if (!el || !container) {
      setHighlight((prev) => ({ ...prev, opacity: 0 }));
      return;
    }
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setHighlight({ width: r.width, x: r.left - c.left, opacity: 1 });
  }, [activePlatform]);

  useLayoutEffect(() => {
    updateHighlight();
  }, [updateHighlight, visiblePlatforms.length]);

  useEffect(() => {
    const onResize = () => updateHighlight();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateHighlight]);

  const island = playerUi.island;
  const islandDisplayName = island.anchorName || island.roomId || "";
  const islandDisplayTitle = island.title || "";

  const islandIsFollowed = useMemo(() => {
    if (!island.visible || !island.platform || !island.roomId) return false;
    const fp: FollowPlatform =
      island.platform === Platform.DOUYU
        ? "DOUYU"
        : island.platform === Platform.DOUYIN
          ? "DOUYIN"
          : island.platform === Platform.HUYA
            ? "HUYA"
            : "BILIBILI";
    return follow.isFollowed(fp, island.roomId);
  }, [follow, island.platform, island.roomId, island.visible]);

  return (
    <nav className={`${styles.navbar} ${theme === "dark" ? styles.navbarDark : ""}`} data-tauri-drag-region>
      <div className={styles.platformTabsWrap} data-tauri-drag-region>
        <div className={styles.platformTabs} ref={containerRef} data-tauri-drag-region>
          <m.div
            className={styles.platformHighlight}
            initial={false}
            animate={highlightMotionWithOpacity}
            transition={{ type: "spring", stiffness: 420, damping: 36, mass: 0.85 }}
          />
          {visiblePlatforms.map((p) => (
            <button
              // eslint-disable-next-line react/no-unknown-property
              data-tauri-drag-region="false"
              key={p.id}
              type="button"
              className={`${styles.platformTab} ${activePlatform === p.id ? styles.platformTabActive : ""}`}
              ref={(node) => {
                tabRefs.current[p.id] = node;
              }}
              onClick={() => onPlatformChange(p.id)}
            >
              {p.id === "custom" ? (
                <LayoutGrid size={16} />
              ) : p.id === "follows" ? (
                <Users size={16} />
              ) : (
                <>
                  <PlatformIcon platform={p.id} size={15} />
                  {p.name}
                </>
              )}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isPlayerRoute && island.visible && island.roomId && (playerUi.danmuPanel.collapsed || !playerUi.danmuPanel.available) ? (
          <m.div
            className={styles.playerIsland}
            data-tauri-drag-region="false"
            initial={{ opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } }}
            exit={{ opacity: 0, y: -8, scale: 0.99, transition: { duration: 0.12 } }}
          >
            <div className={styles.playerIslandLeft}>
              {island.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={styles.playerIslandAvatar} src={island.avatarUrl} alt={islandDisplayName} />
              ) : (
                <div className={`${styles.playerIslandAvatar} ${styles.playerIslandAvatarFallback}`}>
                  {(islandDisplayName || "?").slice(0, 1)}
                </div>
              )}
              <div className={styles.playerIslandMeta}>
                <div className={styles.playerIslandName} title={islandDisplayName}>
                  {islandDisplayName}
                </div>
                <div className={styles.playerIslandTitle} title={islandDisplayTitle}>
                  {islandDisplayTitle}
                </div>
              </div>
            </div>
            <m.button
              type="button"
              className={`${styles.playerIslandFollow} ${islandIsFollowed ? styles.playerIslandFollowed : ""}`}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.7 }}
              onClick={() => {
                if (!island.platform || !island.roomId) return;
                const fp: FollowPlatform =
                  island.platform === Platform.DOUYU
                    ? "DOUYU"
                    : island.platform === Platform.DOUYIN
                      ? "DOUYIN"
                      : island.platform === Platform.HUYA
                        ? "HUYA"
                        : "BILIBILI";
                if (follow.isFollowed(fp, island.roomId)) follow.unfollowStreamer(fp, island.roomId);
                else {
                  follow.followStreamer({
                    id: island.roomId,
                    platform: fp,
                    nickname: islandDisplayName || island.roomId,
                    avatarUrl: island.avatarUrl || "",
                    roomTitle: island.title || "",
                    currentRoomId: island.roomId,
                    liveStatus: "UNKNOWN"
                  });
                }
              }}
            >
              {islandIsFollowed ? "取关" : "关注"}
            </m.button>
            <button
              type="button"
              className={styles.playerIslandExpand}
              title={playerUi.danmuPanel.available ? "展开弹幕" : "当前窗口过窄，无法展开弹幕列表"}
              disabled={!playerUi.danmuPanel.available}
              onClick={() => playerUi.requestShowDanmuPanel()}
            >
              <ChevronDown size={14} />
            </button>
          </m.div>
        ) : null}
      </AnimatePresence>

      <div className={styles.actions} data-tauri-drag-region>
        <div className={styles.searchContainer} data-tauri-drag-region="false">
          {isPlayerRoute && !playerSearchOpen ? (
            <m.button
              type="button"
              className={styles.searchIconBtn}
              aria-label="打开搜索"
              title="搜索"
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.96 }}
              transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}
              onClick={openPlayerSearch}
            >
              <Search size={16} />
            </m.button>
          ) : null}

          <m.div
            className={`${styles.searchShell} ${isSearchFocused ? styles.searchShellFocused : ""}`}
            initial={false}
            animate={isPlayerRoute ? { width: playerSearchOpen ? 320 : 36, opacity: playerSearchOpen ? 1 : 0 } : undefined}
            transition={isPlayerRoute ? { type: "spring", stiffness: 520, damping: 44, mass: 0.7 } : undefined}
            style={isPlayerRoute ? { maxWidth: "36vw", overflow: "hidden", display: playerSearchOpen ? "inline-flex" : "none" } : undefined}
          >
            <input
              ref={navbarInputRef}
              value={spotlight.state.query}
              onChange={(e) => spotlight.state.setQuery(e.target.value)}
              placeholder={spotlight.actions.placeholder}
              className={styles.searchInput}
              onFocus={() => {
                setIsSearchFocused(true);
                if (!spotlight.state.isOpen) spotlight.actions.open(navbarInputRef.current);
              }}
              onBlur={() => setIsSearchFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  spotlight.actions.submitNumeric(openInMain);
                }
              }}
            />
            {spotlight.state.query ? (
              <button
                type="button"
                className={styles.searchIconBtn}
                aria-label="清除搜索"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  spotlight.state.setQuery("");
                }}
              >
                <X size={14} />
              </button>
            ) : null}
            <button
              type="button"
              className={styles.searchIconBtn}
              aria-label="搜索"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (!spotlight.state.isOpen) spotlight.actions.open(navbarInputRef.current);
                else spotlight.actions.submitNumeric(openInMain);
              }}
            >
              <Search size={15} />
            </button>
          </m.div>
        </div>

        {isWindows ? (
          <div className={styles.winControls} data-tauri-drag-region="false" aria-label="Window controls">
            <button type="button" className={styles.winBtn} title="最小化" onClick={() => void minimizeWindow()}>
              <WinCaptionMinimizeIcon />
            </button>
            <button type="button" className={styles.winBtn} title={isMaximized ? "还原" : "最大化"} onClick={() => void toggleMaximizeWindow()}>
              {isMaximized ? <WinCaptionRestoreIcon /> : <WinCaptionMaximizeIcon />}
            </button>
            <button type="button" className={`${styles.winBtn} ${styles.winBtnClose}`} title="关闭" onClick={() => void closeWindow()}>
              <WinCaptionCloseIcon />
            </button>
          </div>
        ) : null}
      </div>

      {/* Spotlight 浮层（状态在 useSearchSpotlight 内统一管理） */}
      {spotlight.renderSpotlight()}
    </nav>
  );
}
