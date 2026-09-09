"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import styles from "./Sidebar.module.css";
import { FollowsList } from "@/components/follows/FollowsList";
import { FollowsRail } from "@/components/follows/FollowsRail";
import { SettingsMenu } from "@/components/shell/SettingsMenu";
import { useTheme } from "@/state/theme/ThemeProvider";

// 收起时迷你条落定后再切换呈现：宽度动画时长须与 legacy-global 的 --sidebar-anim 同步
// （比动画时长略短，宽度几乎到 68 时即切，避免展开态内容压到最窄后仍停留一瞬）
const COLLAPSE_SWAP_MS = 250;

export function Sidebar({
  isCollapsed,
  isPlayerActive = false,
  immersive = false,
  onToggle
}: {
  isCollapsed: boolean;
  isPlayerActive?: boolean;
  /** 原生/CSS 全屏沉浸态：dock 不常驻画面，左缘极细热区为把手，悬停唤出（约定：把手全屏也要生效） */
  immersive?: boolean;
  onToggle: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [fsTarget, setFsTarget] = useState<HTMLElement | null>(null);
  const [dockPeek, setDockPeek] = useState(false);
  const dockPeekTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 首帧后再开宽度过渡：启动时回读“已折叠”那一步 width 突变保持即时，避免启动动画
  const [animReady, setAnimReady] = useState(false);
  const animReadyRef = useRef(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      animReadyRef.current = true;
      setAnimReady(true);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // 收起时的“迷你条呈现”比 isCollapsed 晚一拍：宽度动画先把展开面板裁到 68，再整块换成迷你条，
  // 避免迷你条在仍宽的面板里居中漂移；展开则立即切回列表随宽度顺次露出
  const [railShown, setRailShown] = useState(isCollapsed);
  const railTimerRef = useRef<number | null>(null);
  const prevCollapsedRef = useRef(isCollapsed);
  useLayoutEffect(() => {
    if (railTimerRef.current) {
      window.clearTimeout(railTimerRef.current);
      railTimerRef.current = null;
    }
    const becomingCollapsed = isCollapsed && !prevCollapsedRef.current;
    prevCollapsedRef.current = isCollapsed;
    if (!isCollapsed) {
      setRailShown(false);
      return;
    }
    // 只有“收起时宽度真会播放动画”才延迟切迷你条：真全屏/启动回读/减少动效这些瞬移场景直接同步切，
    // 避免以 68px 停留一帧展开态左缘
    const reduce = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
    const willAnimate = becomingCollapsed && animReadyRef.current && !reduce;
    if (willAnimate) {
      railTimerRef.current = window.setTimeout(() => {
        railTimerRef.current = null;
        setRailShown(true);
      }, COLLAPSE_SWAP_MS);
    } else {
      setRailShown(true);
    }
  }, [isCollapsed, animReady]);

  useEffect(
    () => () => {
      if (railTimerRef.current) window.clearTimeout(railTimerRef.current);
    },
    []
  );

  // 真全屏（Fullscreen API）的 top layer 只渲染全屏元素子树，body 上的侧栏整体不可见；
  // 全屏期间 portal 目标切到全屏元素内部，把手/热区/面板才能浮在画面上（903ad1f 约定）
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

  // 展开/收起切换后清掉 dock 悬停态，避免残留
  useEffect(() => {
    if (!isCollapsed) setDockPeek(false);
  }, [isCollapsed]);

  useEffect(
    () => () => {
      if (dockPeekTimerRef.current) window.clearTimeout(dockPeekTimerRef.current);
    },
    []
  );

  const { effectiveTheme, toggleLightDark } = useTheme();
  const isDark = effectiveTheme === "dark";

  // 仅在播放时拉手微可见
  const subtle = isPlayerActive;
  const dockImmersive = immersive && isCollapsed;

  const cancelDockPeek = () => {
    if (dockPeekTimerRef.current) {
      window.clearTimeout(dockPeekTimerRef.current);
      dockPeekTimerRef.current = null;
    }
  };
  const revealDockPeek = () => {
    cancelDockPeek();
    setDockPeek(true);
  };
  const hideDockPeekSoon = () => {
    cancelDockPeek();
    dockPeekTimerRef.current = window.setTimeout(() => setDockPeek(false), 200);
  };

  const asideClass = [
    styles.sidebarShell,
    animReady ? styles.anim : "",
    railShown && subtle ? styles.railSubtle : "",
    dockImmersive ? styles.immersiveDock : "",
    dockImmersive && dockPeek ? styles.immersiveDockPeek : ""
  ]
    .filter(Boolean)
    .join(" ");

  const el = (
    <>
      {/* 折叠沉浸态：dock 整体在画面外时，靠这条极细左缘热区悬停唤出 */}
      {dockImmersive && !dockPeek ? (
        <div
          className={styles.immersiveHot}
          onMouseEnter={revealDockPeek}
          onMouseLeave={hideDockPeekSoon}
          role="presentation"
          aria-hidden="true"
        />
      ) : null}
      <aside
        className={asideClass}
        style={{
          width: isCollapsed ? "var(--sidebar-collapsed-width)" : "var(--sidebar-width)",
          height: "100%",
          display: "flex",
          flexDirection: "column"
        }}
        onMouseEnter={dockImmersive ? revealDockPeek : undefined}
        onMouseLeave={dockImmersive ? hideDockPeekSoon : undefined}
      >
        <button
          type="button"
          className={`${styles.drawerHandle} ${subtle ? styles.drawerHandleSubtle : ""}`}
          onClick={onToggle}
          aria-label={isCollapsed ? "展开关注栏" : "收起关注栏"}
          title={isCollapsed ? "展开关注栏" : "收起关注栏"}
        >
          {isCollapsed ? <ChevronRight size={11} /> : <ChevronLeft size={11} />}
        </button>
        <div className={styles.sidebarStage}>
          {railShown ? (
            <div className={styles.railPane}>
              <FollowsRail />
            </div>
          ) : (
            <div className={styles.listPane}>
              <FollowsList folded={isCollapsed} />
            </div>
          )}
        </div>

        {/* 底部三键簇：折叠/展开锚点固定，主题与设置以锚点中心为圆心做 90° 圆周开合。
            竖列(收起)从上到下 设置→主题→折叠；横排(展开)从左到右 折叠→主题→设置，顺序两态一致。
            几何跟 isCollapsed 走（收起一开始就同步转场，不滞后于宽度动画）；
            仅迷你条与列表正文仍按 railShown 在宽度落定后切换 */}
        <div
          className={`${styles.footerCluster} ${isCollapsed ? styles.footerClusterRail : styles.footerClusterList} ${
            animReady ? styles.footerClusterAnim : ""
          }`}
        >
          <button
            type="button"
            className={`${styles.footerClusterBtn} ${styles.footerAnchor}`}
            onClick={onToggle}
            aria-label={isCollapsed ? "展开关注栏" : "收起关注栏"}
            title={isCollapsed ? "展开关注栏" : "收起关注栏"}
          >
            {isCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <div
            className={`${styles.footerArm} ${isCollapsed ? "" : styles.footerArmRow}`}
            style={{ ["--arm-r" as any]: "52px" }}
          >
            <div className={styles.footerArmBtn}>
              <div className={`${styles.footerArmFace} ${isCollapsed ? styles.footerArmFaceRail : ""}`}>
                <button
                  type="button"
                  className={styles.footerClusterBtn}
                  onClick={toggleLightDark}
                  aria-label={isDark ? "切换到浅色" : "切换到深色"}
                  title={isDark ? "切换到浅色" : "切换到深色"}
                >
                  {isDark ? <Sun size={18} /> : <Moon size={18} />}
                </button>
              </div>
            </div>
          </div>
          <div
            className={`${styles.footerArm} ${isCollapsed ? "" : styles.footerArmRow}`}
            style={{ ["--arm-r" as any]: "104px" }}
          >
            <div className={styles.footerArmBtn}>
              <div className={`${styles.footerArmFace} ${isCollapsed ? styles.footerArmFaceRail : ""}`}>
                <SettingsMenu />
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );

  if (mounted) {
    return createPortal(el, fsTarget ?? document.body);
  }
  return null;
}
