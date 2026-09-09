"use client";

import React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "framer-motion";

import { useVolumeToast } from "@/state/volumeToast/VolumeToastProvider";
import { useMultiview } from "@/state/multiview/MultiviewProvider";
import styles from "./VolumeToast.module.css";

function VolumeIcon({ muted, level }: { muted: boolean; level: number }) {
  if (muted || level === 0) {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="currentColor" />
        <line x1="22" y1="9" x2="16" y2="15" />
        <line x1="16" y1="9" x2="22" y2="15" />
      </svg>
    );
  }
  if (level < 0.34) {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="currentColor" />
        <path d="M15 9a4 4 0 0 1 0 6" />
      </svg>
    );
  }
  if (level < 0.67) {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="currentColor" />
        <path d="M15 9a4 4 0 0 1 0 6" />
        <path d="M18 6a8 8 0 0 1 0 12" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="currentColor" />
      <path d="M15 9a4 4 0 0 1 0 6" />
      <path d="M18 6a8 8 0 0 1 0 12" />
      <path d="M21 3a12 12 0 0 1 0 18" />
    </svg>
  );
}

export function VolumeToastHost() {
  const { state } = useVolumeToast();
  const { playerSurfaceRect } = useMultiview();

  if (typeof document === "undefined") return null;
  const portalTarget = document.body;
  if (!portalTarget) return null;

  const percent = Math.max(0, Math.min(100, Math.round(state.volume * 100)));

  // 定位策略：以"直播画面"的 viewport 矩形中点为锚（侧边栏存在时也不漂移）；
  // surfaceRect 暂未就绪则回退到 window viewport 中心。
  const centerX = playerSurfaceRect ? playerSurfaceRect.left + playerSurfaceRect.width / 2 : window.innerWidth / 2;
  const centerY = playerSurfaceRect ? playerSurfaceRect.top + playerSurfaceRect.height / 2 : window.innerHeight / 2;

  return createPortal(
    <AnimatePresence>
      {state.visible ? (
        <m.div
          className={styles.panel}
          role="status"
          aria-live="polite"
          aria-label={`音量 ${percent}%`}
          style={{ left: centerX, top: centerY }}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          data-tauri-drag-region="false"
        >
          <div className={styles.icon} aria-hidden="true">
            <VolumeIcon muted={state.muted} level={state.volume} />
          </div>
          <div className={styles.number} aria-hidden="true">{percent}%</div>
        </m.div>
      ) : null}
    </AnimatePresence>,
    portalTarget
  );
}
