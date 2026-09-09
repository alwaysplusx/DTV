"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SCROLL_GATE_MS = 250;

/**
 * 卡片悬浮播放预览的触发状态机：
 * - 指针在卡上驻留 delayMs 才开播（避免扫过即连流）
 * - 移开立即取消
 * - 任意滚动/滚轮发生后 delayMs 内的驻留不触发（翻页误触防护）
 * 调用方持有返回的 target，只给命中的那张卡挂 <HoverStreamPreview>。
 */
export function useCardHoverPreview(delayMs = 550) {
  const [target, setTarget] = useState<{ platform: string; id: string } | null>(null);
  const hoverKeyRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastScrollAtRef = useRef(0);

  useEffect(() => {
    const bump = () => {
      lastScrollAtRef.current = performance.now();
    };
    window.addEventListener("wheel", bump, { capture: true, passive: true });
    document.addEventListener("scroll", bump, { capture: true, passive: true });
    return () => {
      window.removeEventListener("wheel", bump, true);
      document.removeEventListener("scroll", bump, true);
    };
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  const enter = useCallback(
    (platform: string, id: string) => {
      const key = `${platform}:${id}`;
      hoverKeyRef.current = key;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (hoverKeyRef.current === key && performance.now() - lastScrollAtRef.current > SCROLL_GATE_MS) {
          setTarget({ platform, id });
        }
      }, delayMs);
    },
    [clearTimer, delayMs]
  );

  const leave = useCallback(
    (platform: string, id: string) => {
      const key = `${platform}:${id}`;
      if (hoverKeyRef.current === key) hoverKeyRef.current = null;
      clearTimer();
      setTarget((prev) => (prev && `${prev.platform}:${prev.id}` === key ? null : prev));
    },
    [clearTimer]
  );

  const reset = useCallback(() => {
    hoverKeyRef.current = null;
    clearTimer();
    setTarget(null);
  }, [clearTimer]);

  return { target, enter, leave, reset };
}
