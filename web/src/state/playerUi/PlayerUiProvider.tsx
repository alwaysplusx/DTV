"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { Platform } from "@/platforms/common/types";

export type PlayerIslandState = {
  visible: boolean;
  platform: Platform | null;
  roomId: string | null;
  anchorName: string | null;
  title: string | null;
  avatarUrl: string | null;
};

export type DanmuPanelState = {
  available: boolean;
  collapsed: boolean;
};

type PlayerUiContextValue = {
  island: PlayerIslandState;
  setIsland: (next: Partial<PlayerIslandState>) => void;
  clearIsland: () => void;
  isFullscreen: boolean;
  setFullscreen: (next: boolean) => void;
  isAlwaysOnTop: boolean;
  toggleAlwaysOnTop: () => void;
  danmuPanel: DanmuPanelState;
  setDanmuPanel: (next: DanmuPanelState) => void;
  registerDanmuPanelSetter: (setter: ((visible: boolean) => void) | null) => void;
  requestShowDanmuPanel: () => void;
};

const PlayerUiContext = createContext<PlayerUiContextValue | null>(null);

const emptyIsland: PlayerIslandState = {
  visible: false,
  platform: null,
  roomId: null,
  anchorName: null,
  title: null,
  avatarUrl: null
};

const emptyDanmuPanel: DanmuPanelState = {
  available: false,
  collapsed: true
};

export function PlayerUiProvider({ children }: { children: React.ReactNode }) {
  const [island, setIslandState] = useState<PlayerIslandState>(emptyIsland);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [danmuPanel, setDanmuPanelState] = useState<DanmuPanelState>(emptyDanmuPanel);
  const danmuSetterRef = useRef<((visible: boolean) => void) | null>(null);

  const setIsland = useCallback((next: Partial<PlayerIslandState>) => {
    setIslandState((prev) => ({ ...prev, ...next, visible: true }));
  }, []);

  const clearIsland = useCallback(() => {
    setIslandState(emptyIsland);
  }, []);

  const registerDanmuPanelSetter = useCallback((setter: ((visible: boolean) => void) | null) => {
    danmuSetterRef.current = setter;
  }, []);

  const requestShowDanmuPanel = useCallback(() => {
    danmuSetterRef.current?.(true);
  }, []);

  const toggleAlwaysOnTop = useCallback(() => setIsAlwaysOnTop(v => !v), []);

  const setDanmuPanel = useCallback((next: DanmuPanelState) => {
    setDanmuPanelState(next);
  }, []);

  // 同步到 OS 窗口（应用级；窗口整会话存活，无需卸载重置）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;
        await getCurrentWindow().setAlwaysOnTop(isAlwaysOnTop);
      } catch {
        /* 非 Tauri：忽略 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAlwaysOnTop]);

  const value = useMemo<PlayerUiContextValue>(() => {
    return {
      island,
      setIsland,
      clearIsland,
      isFullscreen,
      setFullscreen: setIsFullscreen,
      isAlwaysOnTop,
      toggleAlwaysOnTop,
      danmuPanel,
      setDanmuPanel,
      registerDanmuPanelSetter,
      requestShowDanmuPanel
    };
  }, [clearIsland, danmuPanel, island, isFullscreen, isAlwaysOnTop, registerDanmuPanelSetter, requestShowDanmuPanel, setDanmuPanel, setIsland, toggleAlwaysOnTop]);

  return <PlayerUiContext.Provider value={value}>{children}</PlayerUiContext.Provider>;
}

export function usePlayerUi() {
  const ctx = useContext(PlayerUiContext);
  if (!ctx) throw new Error("usePlayerUi must be used within PlayerUiProvider");
  return ctx;
}
