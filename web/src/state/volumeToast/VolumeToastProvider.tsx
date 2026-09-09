"use client";

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type VolumeToastState = {
  visible: boolean;
  volume: number;
  muted: boolean;
};

export type VolumeToastContextValue = {
  state: VolumeToastState;
  show: (volume: number, muted?: boolean) => void;
  hide: () => void;
};

const initialState: VolumeToastState = { visible: false, volume: 0, muted: false };

const HIDEOUT_DELAY_MS = 900;

const VolumeToastContext = React.createContext<VolumeToastContextValue | null>(null);

export function useVolumeToast(): VolumeToastContextValue {
  const ctx = useContext(VolumeToastContext);
  if (!ctx) {
    throw new Error("useVolumeToast must be used within VolumeToastProvider");
  }
  return ctx;
}

export function VolumeToastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<VolumeToastState>(initialState);
  const hideTimerRef = useRef<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const show = useCallback((volume: number, muted = false) => {
    clearHideTimer();
    const v = Math.max(0, Math.min(1, volume));
    setState({ visible: true, volume: v, muted });
    hideTimerRef.current = window.setTimeout(() => {
      setState((prev) => ({ ...prev, visible: false }));
      hideTimerRef.current = null;
    }, HIDEOUT_DELAY_MS);
  }, [clearHideTimer]);

  const hide = useCallback(() => {
    clearHideTimer();
    setState((prev) => ({ ...prev, visible: false }));
  }, [clearHideTimer]);

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  const value = useMemo(() => ({ state, show, hide }), [state, show, hide]);

  return <VolumeToastContext.Provider value={value}>{children}</VolumeToastContext.Provider>;
}
