"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Moon, Sun } from "lucide-react";
import styles from "./Sidebar.module.css";
import { FollowsList } from "@/components/follows/FollowsList";
import { SettingsMenu } from "@/components/shell/SettingsMenu";
import { useTheme } from "@/state/theme/ThemeProvider";

export function Sidebar({
  isCollapsed,
  isPlayerActive = false,
  onToggle
}: {
  isCollapsed: boolean;
  isPlayerActive?: boolean;
  onToggle: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { effectiveTheme, toggleLightDark } = useTheme();
  const isDark = effectiveTheme === "dark";

  // 仅在播放时拉手微可见
  const subtle = isPlayerActive;

  const el = (
    <aside
      className={styles.sidebarShell}
      style={{
        width: isCollapsed ? "var(--sidebar-collapsed-width)" : "var(--sidebar-width)",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        transition: "none",
        ...(isCollapsed ? { borderRight: "none" } : {})
      }}
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
      {!isCollapsed ? (
        <div className={styles.sidebarBody}>
          <FollowsList />
          <div className={styles.sidebarFooter}>
            <SettingsMenu />
            <button
              type="button"
              className={`${styles.themeToggle} ${isDark ? styles.themeToggleDark : styles.themeToggleLight}`}
              onClick={toggleLightDark}
              aria-label={isDark ? "切换到浅色" : "切换到深色"}
              title={isDark ? "切换到浅色" : "切换到深色"}
            >
              {isDark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );

  if (mounted) {
    return createPortal(el, document.body);
  }
  return null;
}
