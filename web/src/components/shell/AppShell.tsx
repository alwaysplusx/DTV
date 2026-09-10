"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, m } from "framer-motion";
import { Spinner } from "@heroui/react";
import { createPortal } from "react-dom";


import styles from "./AppShell.module.css";
import { Sidebar } from "@/components/shell/Sidebar";
import { Navbar } from "@/components/shell/Navbar";
import { useTheme } from "@/state/theme/ThemeProvider";
import { usePlayerUi } from "@/state/playerUi/PlayerUiProvider";
import { useCustomCategories } from "@/state/customCategories/CustomCategoriesProvider";
import { PlayerOverlayHost, PlayerOverlayProvider, usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { MultiviewProvider } from "@/state/multiview/MultiviewProvider";
import { VolumeToastProvider } from "@/state/volumeToast/VolumeToastProvider";
import { VolumeToastHost } from "@/components/player/VolumeToast";
import { PinIcon } from "@/components/player/PinIcon";
import { useLiveNotifications } from "@/hooks/useLiveNotifications";
import { FollowRefreshProvider } from "@/state/follow/FollowRefreshProvider";
import { useFollow } from "@/state/follow/FollowProvider";
import { probeSidebarToggle } from "@/utils/sidebarPerfProbe";

type UiPlatform = "douyu" | "douyin" | "huya" | "bilibili" | "custom" | "follows";

function normalizePathname(pathname: string) {
  const raw = String(pathname || "/");
  if (raw === "/") return "/";
  return raw.replace(/\/+$/, "");
}

function getActivePlatform(pathname: string): UiPlatform {
  const p = normalizePathname(pathname);
  if (p.startsWith("/follows")) return "follows";
  if (p.startsWith("/custom")) return "custom";
  if (p.startsWith("/douyin")) return "douyin";
  if (p.startsWith("/huya")) return "huya";
  if (p.startsWith("/bilibili")) return "bilibili";
  return "douyu";
}

function isPlayerPath(pathname: string) {
  return normalizePathname(pathname).startsWith("/player");
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // 「运行日志」「独立直播间」「观看统计」等独立窗口页面：无侧栏/导航/播放器外壳，
  // 也不挂刷新引擎与开播通知（只属于主窗口，避免多窗口重复跑）
  if (
    pathname?.startsWith("/logs") ||
    pathname?.startsWith("/player-window") ||
    pathname?.startsWith("/stats")
  ) {
    return <>{children}</>;
  }

  return (
    <PlayerOverlayProvider>
      <MultiviewProvider>
        <VolumeToastProvider>
          <AppShellInner>{children}</AppShellInner>
          <VolumeToastHost />
        </VolumeToastProvider>
      </MultiviewProvider>
    </PlayerOverlayProvider>
  );
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { effectiveTheme } = useTheme();
  const { isFullscreen: isPlayerFullscreen, isAlwaysOnTop, toggleAlwaysOnTop } = usePlayerUi();
  const playerOverlay = usePlayerOverlay();
  const custom = useCustomCategories();
  const followState = useFollow();
  const followHydrated = followState.hydrated;
  const followedCount = followState.followedStreamers.length;
  useLiveNotifications();
  const [hydrated, setHydrated] = useState(false);
  const [isWindows, setIsWindows] = useState(false);
  const [isRoutePending, startRouteTransition] = useTransition();

  const normalizedPathname = useMemo(() => normalizePathname(pathname ?? "/"), [pathname]);
  const activePlatform = useMemo(() => getActivePlatform(normalizedPathname), [normalizedPathname]);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  // 首帧后再允许 padding 过渡：启动回读折叠偏好那一步保持即时，避免启动动画
  const [appShellAnim, setAppShellAnim] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAppShellAnim(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // 水合完成后从 localStorage 读取折叠偏好
  useEffect(() => {
    try {
      if (localStorage.getItem("dtv_sidebar_collapsed") === "1") {
        setIsSidebarCollapsed(true);
      }
    } catch {
      // ignore
    }
  }, []);

  // 进全屏收成折叠态（沉浸默认：dock 不常驻、仅左缘热区可唤出），退全屏还原进入前的折叠/展开偏好
  const prevFullscreenRef = useRef(isPlayerFullscreen);
  const collapsedBeforeFullscreenRef = useRef(isSidebarCollapsed);
  useEffect(() => {
    const nowFs = isPlayerFullscreen;
    const wasFs = prevFullscreenRef.current;
    if (nowFs && !wasFs) {
      collapsedBeforeFullscreenRef.current = isSidebarCollapsed;
      if (!isSidebarCollapsed) setIsSidebarCollapsed(true);
    } else if (!nowFs && wasFs) {
      setIsSidebarCollapsed(collapsedBeforeFullscreenRef.current);
    }
    prevFullscreenRef.current = nowFs;
  }, [isPlayerFullscreen, isSidebarCollapsed]);

  const toggleSidebar = useCallback(() => {
    // [TEMP-PERF-PROBE] 诊断侧栏开合卡顿用，定位后移除
    probeSidebarToggle(isSidebarCollapsed ? "expand" : "collapse");
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("dtv_sidebar_collapsed", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, [isSidebarCollapsed]);
  const [optimisticPlatform, setOptimisticPlatform] = useState<UiPlatform>(activePlatform);

  const playerActive = isPlayerPath(normalizedPathname) || playerOverlay.isOpen;
  const shouldHidePlayerChrome = playerActive && isPlayerFullscreen;
  const playerRoute = isPlayerPath(normalizedPathname);
  // 避免 `/huya` vs `/huya/` 这种规范化抖动导致的重复挂载/重复请求

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const osMod: any = await import("@tauri-apps/plugin-os");
        const p = typeof osMod?.platform === "function" ? await osMod.platform() : "";
        if (cancelled) return;
        const plat = String(p).toLowerCase();
        setIsWindows(plat === "windows" || plat === "linux");
      } catch {
        // non-tauri env: ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setOptimisticPlatform(activePlatform);
  }, [activePlatform]);

  useEffect(() => {
    if (!custom.hydrated || !followHydrated) return;

    // 自定义分区：无数据则不显示（避免进入空白页）
    if (normalizedPathname.startsWith("/custom") && custom.entries.length === 0) {
      router.replace("/");
      return;
    }

    // 仅在本次启动首次落到首页时重定向默认首页（之后手动回 / 不被弹走）：
    // 有关注主播进关注页；无关注停留斗鱼首页（/）
    if (normalizedPathname === "/") {
      try {
        const key = "dtv_initial_route_v2";
        if (window.sessionStorage.getItem(key) === "1") return;
        window.sessionStorage.setItem(key, "1");
      } catch {
        // ignore
      }
      if (followedCount > 0) router.replace("/follows/");
    }
  }, [custom.entries.length, custom.hydrated, followedCount, followHydrated, normalizedPathname, router]);

  const navigatePlatform = useCallback(
    (p: UiPlatform) => {
      const map: Record<UiPlatform, string> = {
        follows: "/follows/",
        douyu: "/",
        douyin: "/douyin/",
        huya: "/huya/",
        bilibili: "/bilibili/",
        custom: "/custom/"
      };

      const next = map[p];
      if (!next) return;

      setOptimisticPlatform(p);
      startRouteTransition(() => {
        if (isPlayerPath(pathname ?? "/")) router.replace(next);
        else router.push(next);
      });
    },
    [pathname, router]
  );

  useEffect(() => {
    if (!hydrated) return;
    // Preload route chunks so tab switching is instant after first paint.
    // Ignore errors (non-next runtime, prefetch not supported, etc.).
    try {
      void router.prefetch("/");
      void router.prefetch("/follows/");
      void router.prefetch("/douyin/");
      void router.prefetch("/huya/");
      void router.prefetch("/bilibili/");
      if (custom.hydrated && custom.entries.length > 0) void router.prefetch("/custom/");
    } catch {
      // ignore
    }
  }, [custom.entries.length, custom.hydrated, hydrated, router]);

  const showRoutePending = optimisticPlatform !== activePlatform || isRoutePending;
  const portalTarget = typeof document !== "undefined" ? document.body : null;

  // 刷新引擎挂在常驻外壳：不随侧栏折叠/路由切换卸载，开播通知因此与侧栏状态解耦
  const shellEl = (
    <div
      className={`${styles.appShell}${appShellAnim ? ` ${styles.appShellAnim}` : ""}`}
      style={{ paddingLeft: isSidebarCollapsed ? "var(--sidebar-collapsed-width)" : "var(--sidebar-width)" }}
    >
      <Sidebar isCollapsed={isSidebarCollapsed} isPlayerActive={playerActive} onToggle={toggleSidebar} immersive={shouldHidePlayerChrome} />

      {/* macOS 交通灯旁常驻药丸：应用级窗口置顶，全视图常驻（不随 idle 隐藏）。
          portal 到 body + z-index:10001，逃逸所有层叠上下文，
          稳居侧边栏(100)/播放覆盖层(500)/CSS 全屏播放器(9999) 之上。
          hydrated gate 避免 SSR/客户端 portalTarget 不一致的 hydration mismatch。
          折叠态淡出（player-pin-pill-hidden）：迷你条只有 88px，药丸紧贴灯组右缘会连成一串。 */}
      {hydrated && portalTarget && !isWindows
        ? createPortal(
            <button
              type="button"
              className={`player-pin-pill${isAlwaysOnTop ? " is-active" : ""}${
                isSidebarCollapsed ? " player-pin-pill-hidden" : ""
              }`}
              data-tauri-drag-region="false"
              aria-label={isAlwaysOnTop ? "取消窗口置顶" : "窗口置顶"}
              aria-pressed={isAlwaysOnTop}
              title={isAlwaysOnTop ? "取消窗口置顶" : "窗口置顶"}
              onClick={toggleAlwaysOnTop}
            >
              <PinIcon filled={isAlwaysOnTop} />
            </button>,
            portalTarget
          )
        : null}

      <div className={styles.appMain}>
        {!shouldHidePlayerChrome ? (
          <Navbar
            theme={effectiveTheme}
            activePlatform={optimisticPlatform}
            onPlatformChange={navigatePlatform}
          />
        ) : null}

        {hydrated ? (
          <m.main className={`${styles.appBody} ${playerRoute ? styles.appBodyPlayer : ""}`}>
            <div className={styles.appBodyContents}>
              <div className={styles.routeScope}>
                <div className={styles.routePendingWrap}>
                  <div
                    className={`${styles.routePendingContents} ${showRoutePending ? styles.routePendingContentsHidden : ""}`}
                    aria-hidden={showRoutePending}
                  >
                    <div className={styles.routeContents}>
                      {playerRoute ? (
                        <AnimatePresence mode="wait" initial={false}>
                          <m.div
                            key={normalizedPathname}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                            style={{ flex: 1, minHeight: 0 }}
                          >
                            {children}
                          </m.div>
                        </AnimatePresence>
                      ) : (
                        children
                      )}
                    </div>
                  </div>
                  {showRoutePending ? (
                    <div className={styles.routePendingOverlay} data-tauri-drag-region="false">
                      <button type="button" className={styles.routePendingButton} disabled aria-label="正在加载">
                        <Spinner size="lg" />
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </m.main>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <m.main
              key={normalizedPathname}
              className={`${styles.appBody} ${playerRoute ? styles.appBodyPlayer : ""}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            >
              {children}
            </m.main>
          </AnimatePresence>
        )}

        <PlayerOverlayHost />
      </div>
    </div>
  );

  return <FollowRefreshProvider>{shellEl}</FollowRefreshProvider>;
}
