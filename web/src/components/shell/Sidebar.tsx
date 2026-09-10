"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import styles from "./Sidebar.module.css";
import { FollowsList } from "@/components/follows/FollowsList";
import { FollowsRail } from "@/components/follows/FollowsRail";
import { SettingsMenu } from "@/components/shell/SettingsMenu";
import { useTheme } from "@/state/theme/ThemeProvider";

// 收起时迷你条落定后再切换呈现：宽度动画时长须与 legacy-global 的 --sidebar-anim 同步
// （比动画时长略短，宽度几乎到 88 时即切，避免展开态内容压到最窄后仍停留一瞬）
const COLLAPSE_SWAP_MS = 250;
// 展开：竖列按钮「从上往下收起」前段总时长（远钮 160ms + 近钮延迟 80ms），之后横排按钮从左往右滑入
const EXPAND_IN_MS = 240;

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

  // 收起时的“迷你条呈现”比 isCollapsed 晚一拍：宽度动画先把展开面板裁到 88 再切到迷你条
  // （两面板常驻挂载，此处只切可见性），避免迷你条在仍宽的面板里居中漂移；
  // 展开则立即切回列表随宽度顺次露出
  const [railShown, setRailShown] = useState(isCollapsed);
  // 展开侧的对称节拍：false=竖列按钮正在「从上往下收起」，落定后翻 true 触发横排「从左往右滑入」；
  // 与稳态展开同值（横排位），故平时常驻 true 无副作用
  const [footerExpandIn, setFooterExpandIn] = useState(true);
  const railTimerRef = useRef<number | null>(null);
  const footerTimerRef = useRef<number | null>(null);
  const prevCollapsedRef = useRef(isCollapsed);
  useLayoutEffect(() => {
    if (railTimerRef.current) {
      window.clearTimeout(railTimerRef.current);
      railTimerRef.current = null;
    }
    if (footerTimerRef.current) {
      window.clearTimeout(footerTimerRef.current);
      footerTimerRef.current = null;
    }
    const becomingCollapsed = isCollapsed && !prevCollapsedRef.current;
    const becomingExpanded = !isCollapsed && prevCollapsedRef.current;
    prevCollapsedRef.current = isCollapsed;
    // 只有“宽度真会播放动画”才走节拍延迟：真全屏/启动回读/减少动效这些瞬移场景直接同步切，
    // 避免以 88px 停留一帧展开态左缘
    const reduce = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
    const willAnimate = animReadyRef.current && !reduce;
    if (!isCollapsed) {
      setRailShown(false);
      if (becomingExpanded && willAnimate) {
        footerTimerRef.current = window.setTimeout(() => {
          footerTimerRef.current = null;
          setFooterExpandIn(true);
        }, EXPAND_IN_MS);
      } else {
        setFooterExpandIn(true);
      }
      return;
    }
    if (willAnimate && becomingCollapsed) {
      railTimerRef.current = window.setTimeout(() => {
        railTimerRef.current = null;
        setRailShown(true);
      }, COLLAPSE_SWAP_MS);
    } else {
      setRailShown(true);
    }
    setFooterExpandIn(false);
  }, [isCollapsed, animReady]);

  useEffect(
    () => () => {
      if (railTimerRef.current) window.clearTimeout(railTimerRef.current);
      if (footerTimerRef.current) window.clearTimeout(footerTimerRef.current);
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

  // 三键簇四态：收起=左滑淡出→(250ms)竖列上浮；展开=竖列下沉淡出→(240ms)横排左→右滑入
  const footerPhase = isCollapsed
    ? railShown
      ? styles.footerRail
      : styles.footerCollapsing
    : footerExpandIn
      ? styles.footerExpandIn
      : styles.footerExpandOut;

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
        <div className={styles.sidebarStage}>
          {/* 两块面板常驻挂载、railShown 节拍只切可见性：切换折叠不卸载重挂，
              头像 <img> 不重建不闪（此前整块换挂是开合顿挫的主因） */}
          <div className={`${styles.listPane}${railShown ? ` ${styles.paneHidden}` : ""}`}>
            <FollowsList folded={isCollapsed} />
          </div>
          <div className={`${styles.railPane}${railShown ? "" : ` ${styles.paneHidden}`}`}>
            <FollowsRail active={railShown} />
          </div>
        </div>

        {/* 底部三键簇：锚点固定不动；主题/设置两枚滑块四态全用 transform 表达——
            收起：向左滑拢淡出 → 宽度落定后从下到上依次上浮进竖列；
            展开：竖列从上到下依次下沉淡出 → 面板变宽 → 横排从左往右依次滑入。
            滑块基准=横排位，竖列位在锚点列正上方（88px 迷你条水平居中） */}
        <div
          className={`${styles.footerCluster} ${isCollapsed ? styles.footerClusterRail : styles.footerClusterList} ${
            animReady ? styles.footerClusterAnim : ""
          } ${footerPhase}`}
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
          <div className={`${styles.footerSlideBtn} ${styles.footerSlideNear}`}>
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
          <div className={`${styles.footerSlideBtn} ${styles.footerSlideFar}`}>
            <SettingsMenu />
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
