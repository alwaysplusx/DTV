"use client";

import React, { useCallback, useContext, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MULTIVIEW_LAYOUT,
  getLayoutDef,
  loadStoredMultiviewLayout,
  persistMultiviewLayout,
  shrinkSlotsTo,
  type MultiviewLayoutId,
  type MultiviewSlot
} from "@/components/player/multiview/layouts";

export type PlayerSurfaceRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type MultiviewContextValue = {
  isMultiview: boolean;
  slots: MultiviewSlot[];
  layoutId: MultiviewLayoutId;
  audioSlot: number;
  zoomedSlot: number | null;

  /**
   * 当前播放面（直播画面）的 viewport 矩形。单屏期由 MainPlayer 上报（main-content 容器），
   * 多屏期由 MultiViewGrid 上报（mv-root 容器）。侧边栏全宽时亦跟随主画面，不跟 window viewport。
   */
  playerSurfaceRect: PlayerSurfaceRect | null;

  enter: (initialSlot?: MultiviewSlot) => void;
  exit: () => void;
  assignSlot: (index: number, slot: NonNullable<MultiviewSlot>) => void;
  closeSlot: (index: number) => void;
  selectLayout: (id: MultiviewLayoutId) => void;
  setAudioSlot: (index: number) => void;
  toggleZoom: (index: number) => void;
  setPlayerSurfaceRect: (rect: PlayerSurfaceRect | null) => void;
};

const MultiviewContext = React.createContext<MultiviewContextValue | null>(null);

export function useMultiview(): MultiviewContextValue {
  const ctx = useContext(MultiviewContext);
  if (!ctx) {
    throw new Error("useMultiview must be used within MultiviewProvider");
  }
  return ctx;
}

export function MultiviewProvider({ children }: { children: React.ReactNode }) {
  const initialLayout = useMemo<MultiviewLayoutId>(() => {
    if (typeof window === "undefined") return DEFAULT_MULTIVIEW_LAYOUT;
    return loadStoredMultiviewLayout();
  }, []);

  const [isMultiview, setIsMultiview] = useState(false);
  const [slots, setSlots] = useState<MultiviewSlot[]>(() =>
    shrinkSlotsTo([], getLayoutDef(initialLayout).cells)
  );
  const [layoutId, setLayoutId] = useState<MultiviewLayoutId>(initialLayout);
  const [audioSlot, setAudioSlotState] = useState(0);
  const [zoomedSlot, setZoomedSlot] = useState<number | null>(null);

  const [playerSurfaceRect, setPlayerSurfaceRectState] = useState<PlayerSurfaceRect | null>(null);

  const lastInitialSlotRef = useRef<MultiviewSlot | null>(null);

  const enter = useCallback((initialSlot?: MultiviewSlot) => {
    // 退出多屏后再次进入视为新会话：先按当前 layout 清空 slots，避免上次残留
    setSlots(shrinkSlotsTo([], getLayoutDef(layoutId).cells));
    setAudioSlotState(0);
    setZoomedSlot(null);
    if (initialSlot && initialSlot.roomId) {
      lastInitialSlotRef.current = initialSlot;
      const seed: NonNullable<MultiviewSlot> = {
        platform: String(initialSlot.platform).toLowerCase(),
        roomId: initialSlot.roomId
      };
      setSlots((prev) => {
        const next = [...prev];
        if (next.length > 0) {
          next[0] = seed;
        }
        return next;
      });
    }
    setIsMultiview(true);
  }, [layoutId]);

  const exit = useCallback(() => {
    // 退出多屏即关闭该会话：清空 slots，重置 audio/zoom 标记；保留 layout 偏好
    setSlots(shrinkSlotsTo([], getLayoutDef(layoutId).cells));
    setAudioSlotState(0);
    setZoomedSlot(null);
    setIsMultiview(false);
  }, [layoutId]);

  const assignSlot = useCallback((index: number, slot: NonNullable<MultiviewSlot>) => {
    setSlots((prev) => {
      const next = [...prev];
      for (let i = 0; i < next.length; i += 1) {
        if (i !== index && next[i] && next[i]!.platform === slot.platform && next[i]!.roomId === slot.roomId) {
          next[i] = null;
        }
      }
      next[index] = slot;
      return next;
    });
    setAudioSlotState(index);
  }, []);

  const closeSlot = useCallback(
    (index: number) => {
      setSlots((prev) => {
        const next = [...prev];
        next[index] = null;
        return next;
      });
      setZoomedSlot((z) => (z === index ? null : z));
      setAudioSlotState((a) => (a === index ? 0 : a));
    },
    []
  );

  const selectLayout = useCallback((id: MultiviewLayoutId) => {
    setLayoutId(id);
    persistMultiviewLayout(id);
    setSlots((prev) => shrinkSlotsTo(prev, getLayoutDef(id).cells));
    setZoomedSlot(null);
  }, []);

  const setAudioSlot = useCallback((index: number) => {
    setAudioSlotState(index);
  }, []);

  const toggleZoom = useCallback((index: number) => {
    setZoomedSlot((z) => (z === index ? null : index));
  }, []);

  const setPlayerSurfaceRect = useCallback((rect: PlayerSurfaceRect | null) => {
    // 等价检查：避免每次拿到"数值相同但引用不同"的 rect 时触发 React 重渲染，
    // 否则依赖 multiview 的 effect（MainPlayer / MultiViewGrid）会因 provider value 重生成
    // 而反复重跑，陷入无限循环（控制台报 "Maximum update depth exceeded"）。
    setPlayerSurfaceRectState((prev) => {
      if (!prev && !rect) return prev;
      if (prev && rect) {
        if (
          prev.top === rect.top &&
          prev.left === rect.left &&
          prev.width === rect.width &&
          prev.height === rect.height
        ) {
          return prev;
        }
      }
      return rect;
    });
  }, []);

  const value = useMemo<MultiviewContextValue>(
    () => ({
      isMultiview,
      slots,
      layoutId,
      audioSlot,
      zoomedSlot,
      playerSurfaceRect,
      enter,
      exit,
      assignSlot,
      closeSlot,
      selectLayout,
      setAudioSlot,
      toggleZoom,
      setPlayerSurfaceRect
    }),
    [
      isMultiview,
      slots,
      layoutId,
      audioSlot,
      zoomedSlot,
      playerSurfaceRect,
      enter,
      exit,
      assignSlot,
      closeSlot,
      selectLayout,
      setAudioSlot,
      toggleZoom,
      setPlayerSurfaceRect
    ]
  );

  return <MultiviewContext.Provider value={value}>{children}</MultiviewContext.Provider>;
}
