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
import { PinIcon } from "@/components/player/PinIcon";

type UiPlatform = "douyu" | "douyin" | "huya" | "bilibili" | "custom";

function normalizePathname(pathname: string) {
  const raw = String(pathname || "/");
  if (raw === "/") return "/";
  return raw.replace(/\/+$/, "");
}

function getActivePlatform(pathname: string): UiPlatform {
  const p = normalizePathname(pathname);
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
  return (
    <PlayerOverlayProvider>
      <AppShellInner>{children}</AppShellInner>
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
  const [hydrated, setHydrated] = useState(false);
  const [isWindows, setIsWindows] = useState(false);
  const [isRoutePending, startRouteTransition] = useTransition();

  const normalizedPathname = useMemo(() => normalizePathname(pathname ?? "/"), [pathname]);
  const activePlatform = useMemo(() => getActivePlatform(normalizedPathname), [normalizedPathname]);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

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

  // 进入全屏自动折叠关注栏，退出全屏自动展开
  const prevFullscreenRef = useRef(isPlayerFullscreen);
  useEffect(() => {
    if (isPlayerFullscreen && !prevFullscreenRef.current) {
      setIsSidebarCollapsed(true);
    } else if (!isPlayerFullscreen && prevFullscreenRef.current) {
      setIsSidebarCollapsed(false);
    }
    prevFullscreenRef.current = isPlayerFullscreen;
  }, [isPlayerFullscreen]);

  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("dtv_sidebar_collapsed", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);
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
    if (!custom.hydrated) return;

    // 自定义分区：无数据则不显示（避免进入空白页）
    if (normalizedPathname.startsWith("/custom") && custom.entries.length === 0) {
      router.replace("/");
      return;
    }

    // 仅在本次启动首次落到首页时：如果订阅了分区，默认进入自定义分区页
    if (custom.entries.length > 0 && normalizedPathname === "/") {
      try {
        const key = "dtv_initial_route_custom_v1";
        if (window.sessionStorage.getItem(key) === "1") return;
        window.sessionStorage.setItem(key, "1");
      } catch {
        // ignore
      }
      router.replace("/custom/");
    }
  }, [custom.entries.length, custom.hydrated, normalizedPathname, router]);

  const navigatePlatform = useCallback(
    (p: UiPlatform) => {
      const map: Record<UiPlatform, string> = {
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

  return (
    <div
      className={styles.appShell}
      style={{ paddingLeft: isSidebarCollapsed ? "var(--sidebar-collapsed-width)" : "var(--sidebar-width)" }}
    >
      <Sidebar isCollapsed={isSidebarCollapsed} isPlayerActive={playerActive} onToggle={toggleSidebar} />

      {/* macOS 交通灯旁常驻药丸：应用级窗口置顶，全视图常驻（不随 idle 隐藏）。
          portal 到 body + z-index:10001，与侧边栏把手同一模式，逃逸所有层叠上下文，
          稳居侧边栏(100)/播放覆盖层(500)/CSS 全屏播放器(9999) 之上。
          hydrated gate 避免 SSR/客户端 portalTarget 不一致的 hydration mismatch。 */}
      {hydrated && portalTarget && !isWindows
        ? createPortal(
            <button
              type="button"
              className={`player-pin-pill${isAlwaysOnTop ? " is-active" : ""}`}
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
}
