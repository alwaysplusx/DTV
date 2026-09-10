"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import "./multiview.css";

import { PlayerCell } from "./PlayerCell";
import {
  getLayoutDef,
  MULTIVIEW_LAYOUTS,
  type MultiviewLayoutId,
  type MultiviewSlot
} from "./layouts";
import { Platform } from "@/platforms/common/types";
import { useMultiview } from "@/state/multiview/MultiviewProvider";
import { useSearchSpotlight } from "@/hooks/useSearchSpotlight";
import { usePlayerUi } from "@/state/playerUi/PlayerUiProvider";
import { PinIcon } from "@/components/player/PinIcon";

/** 小写 platform 字符串 -> 大写 Platform 枚举（PlayerCell 内部用枚举比较） */
function toPlatformEnum(p: string): Platform {
  const key = String(p || "").toLowerCase();
  if (key === "douyin") return Platform.DOUYIN;
  if (key === "huya") return Platform.HUYA;
  if (key === "bilibili") return Platform.BILIBILI;
  return Platform.DOUYU;
}

export function MultiViewGrid() {
  const multiview = useMultiview();
  const { isAlwaysOnTop, toggleAlwaysOnTop } = usePlayerUi();

  const layoutId = multiview.layoutId;
  const slots = multiview.slots;
  const audioSlot = multiview.audioSlot;
  const zoomedSlot = multiview.zoomedSlot;

  const layoutDef = useMemo(() => getLayoutDef(layoutId), [layoutId]);

  // 顶栏/空格搜索走 spotlight（加到第一个空槽）；格顶栏"切换"也走 spotlight，但替换指定格
  const [replaceSlot, setReplaceSlot] = useState<number | null>(null);
  const addToMultiview = useCallback(
    (nextPlatform: string, nextRoomId: string) => {
      const platform = String(nextPlatform).toLowerCase();
      const roomId = String(nextRoomId);
      // 替换模式：直接覆盖目标格（无论是否为空）
      if (replaceSlot !== null) {
        multiview.assignSlot(replaceSlot, { platform, roomId });
        setReplaceSlot(null);
        return;
      }
      const empty = slots.findIndex((s) => !s || !s.roomId);
      const target = empty >= 0 ? empty : audioSlot;
      multiview.assignSlot(target, { platform, roomId });
    },
    [audioSlot, multiview, replaceSlot, slots]
  );

  const mvSearch = useSearchSpotlight({
    inlinePlatform: false,
    activePlatformLabel: "any",
    onSelectInMain: addToMultiview
  });

  const openReplace = useCallback(
    (index: number) => {
      setReplaceSlot(index);
      mvSearch.actions.open();
    },
    [mvSearch.actions]
  );

  // spotlight 关闭时清掉"替换意图"——避免下次工具栏搜索自动变成替换模式
  useEffect(() => {
    if (!mvSearch.state.isOpen) setReplaceSlot(null);
  }, [mvSearch.state.isOpen]);

  const [chromeHidden, setChromeHidden] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  const [dropTargetSlot, setDropTargetSlot] = useState<number | null>(null);

  const selectLayout = useCallback(
    (id: MultiviewLayoutId) => {
      multiview.selectLayout(id);
    },
    [multiview]
  );

  // 悬停空闲 3s 隐藏工具条/格顶栏（移动即恢复）
  useEffect(() => {
    const armHide = () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => setChromeHidden(true), 3000);
    };
    setChromeHidden(false);
    armHide();
    const onMove = () => {
      setChromeHidden(false);
      armHide();
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousemove", onMove);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  // 上报 mv-root 的 viewport 矩形：让外部 toast / 调试用 UI 跟多屏整体中心对齐
  // 同 MainPlayer：deps 只用稳定的 setPlayerSurfaceRect，避免 Provider value 重生成触发 effect 重跑
  const mvRootRef = useRef<HTMLDivElement | null>(null);
  const setPlayerSurfaceRect = multiview.setPlayerSurfaceRect;
  useEffect(() => {
    const el = mvRootRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setPlayerSurfaceRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      });
    };
    // 不在 mount 时同步 update()：让 ResizeObserver 首次异步回调接管，避免 React 批处理循环
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      setPlayerSurfaceRect(null);
    };
  }, [setPlayerSurfaceRect]);

  const closeSlot = useCallback(
    (index: number) => {
      multiview.closeSlot(index);
    },
    [multiview]
  );

  const popOutCell = useCallback(
    (index: number) => {
      const slot = slots[index];
      if (!slot) return;
      // 先开独立窗口再关本槽：让出当前格子（多屏 4 格场景下用户弹走一个后还能继续填别的房间）
      void invoke("open_player_window_cmd", {
        platform: String(slot.platform).toLowerCase(),
        roomId: slot.roomId
      }).then(() => {
        multiview.closeSlot(index);
      });
    },
    [multiview, slots]
  );

  const assignSlot = useCallback(
    (index: number, slot: NonNullable<MultiviewSlot>) => {
      multiview.assignSlot(index, slot);
    },
    [multiview]
  );

  const handleCellClick = useCallback(
    (index: number) => {
      multiview.setAudioSlot(index);
      const def = layoutDef;
      // PIPS_1_3：点击小格 -> 与大格交换槽位（不重建播放器，DOM 顺序互换即移动容器）
      if (def.id === "PIPS_1_3" && typeof def.focusSlot === "number" && index !== def.focusSlot && zoomedSlot === null) {
        const focusIdx = def.focusSlot;
        const a = slots[focusIdx];
        const b = slots[index];
        if (!a || !b) return;
        multiview.assignSlot(focusIdx, b);
        multiview.assignSlot(index, a);
        // 交换后大格房间成为焦点，音频跟随大格
        multiview.setAudioSlot(focusIdx);
      }
    },
    [layoutDef, multiview, slots, zoomedSlot]
  );

  const gridStyle = useMemo(
    () => ({
      gridTemplateColumns: layoutDef.gridTemplateColumns,
      gridTemplateRows: layoutDef.gridTemplateRows
    }),
    [layoutDef]
  );

  // Escape：退单格全屏（spotlight 自己处理 Esc 关弹窗）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (zoomedSlot !== null) {
        multiview.toggleZoom(zoomedSlot);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [multiview, zoomedSlot]);

  // ── 关注栏拖入（HTML5 DnD：FollowsList 侧后续接入 dataTransfer） ──
  const onGridDragOver = useCallback((e: React.DragEvent) => {
    const types = e.dataTransfer?.types;
    if (types && Array.from(types).some((t) => t.includes("dtv") || t.includes("text/plain"))) {
      e.preventDefault();
    }
  }, []);

  const parseDragPayload = (e: React.DragEvent): NonNullable<MultiviewSlot> | null => {
    try {
      const raw = e.dataTransfer?.getData("application/x-dtv-follow") || e.dataTransfer?.getData("text/plain");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { platform?: string; roomId?: string; id?: string };
      const platform = String(parsed.platform || "").toLowerCase();
      const roomId = String(parsed.roomId || parsed.id || "");
      if (!roomId) return null;
      if (platform !== "douyu" && platform !== "douyin" && platform !== "huya" && platform !== "bilibili") return null;
      return { platform, roomId };
    } catch {
      return null;
    }
  };

  return (
    <div ref={mvRootRef} className={`mv-root${chromeHidden ? " mv-chrome-hidden" : ""}`} onDragOver={onGridDragOver}>
      <div className="mv-toolbar">
        <div className="mv-layout-picker" role="radiogroup" aria-label="多屏布局">
          {MULTIVIEW_LAYOUTS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={l.id === layoutId}
              className={`mv-layout-btn${l.id === layoutId ? " is-active" : ""}`}
              title={l.label}
              onClick={() => selectLayout(l.id)}
            >
              <LayoutIcon def={l} />
            </button>
          ))}
        </div>
        <div className="mv-toolbar-divider" />
        <button
          type="button"
          className="mv-icon-btn"
          title="搜索主播 / 房间"
          aria-label="搜索"
          onClick={(e) => mvSearch.actions.open(e.currentTarget)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </button>
        <button
          type="button"
          className={`mv-icon-btn ${isAlwaysOnTop ? " is-active" : ""}`}
          title={isAlwaysOnTop ? "取消窗口置顶" : "窗口置顶"}
          aria-label={isAlwaysOnTop ? "取消窗口置顶" : "窗口置顶"}
          aria-pressed={isAlwaysOnTop}
          onClick={toggleAlwaysOnTop}
        >
          <PinIcon filled={isAlwaysOnTop} />
        </button>
        <button type="button" className="mv-exit-btn" onClick={() => multiview.exit()} title="退出多屏模式" aria-label="退出多屏模式">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>

      {mvSearch.renderSpotlight()}

      <div className="mv-grid" style={gridStyle}>
        {Array.from({ length: layoutDef.cells }, (_, index) => {
          const slot = slots[index] ?? null;
          const isFocusSlot = layoutDef.id === "PIPS_1_3" && index === layoutDef.focusSlot;

          if (!slot) {
            return (
              <div
                key={`empty-${index}`}
                role="button"
                tabIndex={0}
                className={`mv-cell-empty${dropTargetSlot === index ? " is-drop-target" : ""}`}
                style={isFocusSlot ? { gridRow: `span ${layoutDef.focusSpanRows ?? 1}` } : undefined}
                onClick={(e) => mvSearch.actions.open(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    mvSearch.actions.open(e.currentTarget as HTMLElement);
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTargetSlot(index);
                }}
                onDragLeave={() => setDropTargetSlot((d) => (d === index ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropTargetSlot(null);
                  const payload = parseDragPayload(e);
                  if (payload) assignSlot(index, payload);
                }}
              >
                <div className="mv-cell-empty-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <line x1="12" y1="8" x2="12" y2="16" />
                    <line x1="8" y1="12" x2="16" y2="12" />
                  </svg>
                </div>
                <div className="mv-cell-empty-text">点击添加房间</div>
              </div>
            );
          }

          const cellKey = `${slot.platform}:${slot.roomId}`;
          const isZoomed = zoomedSlot === index;
          return (
            <div
              key={cellKey}
              className={`mv-cell-holder${isZoomed ? " mv-cell-holder--zoomed" : ""}`}
              style={
                isZoomed
                  ? { gridColumn: "1 / -1", gridRow: "1 / -1" }
                  : isFocusSlot
                    ? { gridRow: `span ${layoutDef.focusSpanRows ?? 1}` }
                    : undefined
              }
            >
              <PlayerCell
                platform={toPlatformEnum(slot.platform)}
                roomId={slot.roomId}
                isFocus={layoutDef.id === "PIPS_1_3" ? isFocusSlot : index === audioSlot}
                compactControls={!isFocusSlot && layoutDef.id === "PIPS_1_3"}
                onCellClick={() => handleCellClick(index)}
                onClose={() => closeSlot(index)}
                onToggleZoom={() => multiview.toggleZoom(index)}
                onReplace={() => openReplace(index)}
                onPopOut={() => popOutCell(index)}
                isZoomed={isZoomed}
                multiviewSlot={index}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 布局缩略图：按 cells/vertical/focusSpan 生成 mini grid */
function LayoutIcon({ def }: { def: (typeof MULTIVIEW_LAYOUTS)[number] }) {
  const items: React.ReactNode[] = [];
  const cols = def.vertical ? 1 : def.gridTemplateColumns.split(" ").length;
  const rows = def.vertical ? def.cells : def.gridTemplateRows.split(" ").length;

  if (def.id === "PIPS_1_3") {
    // 1+3：大格占满左列全部行（与 def.focusSpanRows 一致），三个副格堆在右列
    items.push(<i key="f" style={{ gridRow: `span ${def.focusSpanRows ?? 3}`, gridColumn: "span 1", opacity: 0.95 }} />);
    for (let i = 0; i < 3; i += 1) items.push(<i key={`s${i}`} />);
  } else {
    for (let i = 0; i < def.cells; i += 1) items.push(<i key={i} />);
  }

  return (
    <span
      className={`mv-layout-icon${def.vertical ? " is-vertical" : ""}`}
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
      aria-hidden
    >
      {items}
    </span>
  );
}
