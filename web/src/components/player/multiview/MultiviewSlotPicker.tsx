"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "framer-motion";

import styles from "./MultiviewSlotPicker.module.css";

import { useMultiview } from "@/state/multiview/MultiviewProvider";
import {
  getLayoutDef,
  type MultiviewSlot
} from "@/components/player/multiview/layouts";
import type { FollowedStreamer } from "@/state/follow/FollowProvider";

export type SlotPickerAnchor = {
  rect: { top: number; left: number; right: number; bottom: number; width: number; height: number };
  slot: NonNullable<MultiviewSlot>;
  streamer?: Pick<FollowedStreamer, "nickname" | "avatarUrl" | "platform">;
};

const PANEL_PADDING = 8;
const GAP = 8;
const PANEL_MIN_WIDTH = 240;

type Position = { top: number; left: number; placement: "right" | "left" };

function fitInsideViewport(
  desired: Position,
  panelW: number,
  panelH: number
): Position {
  if (typeof window === "undefined") return desired;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;
  let left = desired.left;
  let top = desired.top;
  if (left + panelW > vw - margin) left = vw - margin - panelW;
  if (left < margin) left = margin;
  if (top + panelH > vh - margin) top = vh - margin - panelH;
  if (top < margin) top = margin;
  return { top, left, placement: desired.placement };
}

export function MultiviewSlotPicker({
  anchor,
  onClose,
  onPick
}: {
  anchor: SlotPickerAnchor | null;
  onClose: () => void;
  onPick: (index: number, slot: NonNullable<MultiviewSlot>) => void;
}) {
  const multiview = useMultiview();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const layout = useMemo(() => getLayoutDef(multiview.layoutId), [multiview.layoutId]);
  const slots = multiview.slots;
  const audioSlot = multiview.audioSlot;

  // 面板尺寸自适应：cells 多时收窄 PIPS；少时拉宽
  const desiredWidth = useMemo(() => {
    if (layout.id === "SPLIT_2") return 280;
    if (layout.vertical) return 240;
    if (layout.id === "PIPS_1_3") return 360;
    return 320;
  }, [layout.id, layout.vertical]);

  const desiredHeight = useMemo(() => {
    if (layout.vertical) {
      return layout.cells * 64 + 56;
    }
    if (layout.id === "PIPS_1_3") return 280;
    return 200;
  }, [layout]);

  const position = useMemo<Position | null>(() => {
    if (!anchor) return null;
    const panelW = desiredWidth;
    const panelH = desiredHeight;
    const rightCandidate = anchor.rect.right + GAP;
    const leftCandidate = anchor.rect.left - GAP - panelW;
    const fitsRight = rightCandidate + panelW <= (typeof window !== "undefined" ? window.innerWidth : 0) - PANEL_PADDING;
    const placement: "right" | "left" = fitsRight ? "right" : leftCandidate >= PANEL_PADDING ? "left" : "right";
    const desired: Position = placement === "right"
      ? {
          left: rightCandidate,
          top: Math.max(PANEL_PADDING, anchor.rect.top + anchor.rect.height / 2 - panelH / 2),
          placement
        }
      : {
          left: leftCandidate,
          top: Math.max(PANEL_PADDING, anchor.rect.top + anchor.rect.height / 2 - panelH / 2),
          placement
        };
    return fitInsideViewport(desired, panelW, panelH);
  }, [anchor, desiredWidth, desiredHeight]);

  useEffect(() => {
    if (!anchor) return;
    const onMove = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const r = panel.getBoundingClientRect();
      if (
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom
      ) {
        return;
      }
      // 允许点击 Panel 内部事件外层接管
      if (e.target instanceof Node && panel.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("mousedown", onMove);
    return () => window.removeEventListener("mousedown", onMove);
  }, [anchor, onClose]);

  const portalTarget = typeof document !== "undefined" ? document.body : null;
  if (!portalTarget) return null;

  const pickSlot = (index: number) => {
    if (!anchor) return;
    onPick(index, anchor.slot);
    onClose();
  };

  const gridStyle: React.CSSProperties = useMemo(
    () => ({
      gridTemplateColumns: layout.gridTemplateColumns,
      gridTemplateRows: layout.gridTemplateRows
    }),
    [layout]
  );

  const streamerKey = anchor
    ? `${anchor.streamer?.platform ?? anchor.slot.platform.toUpperCase()}:${anchor.slot.roomId}`
    : null;
  const streamerNickname = anchor?.streamer?.nickname ?? "未关注房间";

  return createPortal(
    <AnimatePresence>
      {anchor && position ? (
        <m.div
          ref={panelRef}
          className={styles.panel}
          role="dialog"
          aria-label="选择多屏槽位"
          style={{
            position: "fixed",
            top: position.top,
            left: position.left,
            width: desiredWidth,
            minWidth: PANEL_MIN_WIDTH
          }}
          initial={{ opacity: 0, scale: 0.96, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 6 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className={styles.header}>
            <div className={styles.title}>
              <span className={styles.titleLabel}>替换到：</span>
              <span className={styles.titleName} title={streamerNickname}>{streamerNickname}</span>
            </div>
            <div className={styles.subtle}>{layout.label}</div>
          </div>
          <div className={styles.grid} style={gridStyle}>
            {Array.from({ length: layout.cells }, (_, index) => {
              const slot = slots[index] ?? null;
              const isFocusSlot = layout.id === "PIPS_1_3" && index === layout.focusSlot;
              const isAudio = index === audioSlot;
              const isTarget = !!(streamerKey && slot && `${slot.platform.toUpperCase()}:${slot.roomId}` === streamerKey);
              const className = [
                styles.cell,
                isFocusSlot ? styles.cellFocus : "",
                isAudio ? styles.cellAudio : "",
                slot ? styles.cellFilled : styles.cellEmpty
              ].filter(Boolean).join(" ");
              return (
                <button
                  key={`slot_${index}`}
                  type="button"
                  role="button"
                  aria-label={`槽位 ${index + 1}`}
                  className={className}
                  style={isFocusSlot ? { gridRow: `span ${layout.focusSpanRows ?? 1}` } : undefined}
                  onClick={() => pickSlot(index)}
                >
                  {slot ? (
                    <div className={styles.cellFilledInner}>
                      <div className={`${styles.cellName} ${isTarget ? styles.cellNameReplace : ""}`} title={slotLabel(slot)}>
                        {slotLabel(slot)}
                      </div>
                      {isTarget ? <div className={styles.cellTargetTag}>将替换此格</div> : null}
                      {isAudio ? <div className={styles.cellAudioBadge}>声</div> : null}
                    </div>
                  ) : (
                    <div className={styles.cellEmptyInner}>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      <span>空槽</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          <div className={styles.footer}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              取消
            </button>
          </div>
        </m.div>
      ) : null}
    </AnimatePresence>,
    portalTarget
  );
}

function slotLabel(slot: NonNullable<MultiviewSlot>): string {
  return `${slot.platform.toUpperCase()} · ${slot.roomId}`;
}
