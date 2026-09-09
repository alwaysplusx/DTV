"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "uuid";

import "xgplayer/dist/index.min.css";
import "../player.css";
import "./multiview.css";

import type { DanmakuMessage, DanmuOverlayInstance, RustGetStreamUrlPayload } from "@/components/player/types";
import type { DanmuKeywordBlockPreferences, DanmuUserSettings } from "@/components/player/constants";
import {
  applyDanmuFontFamilyForOS,
  DANMU_BLOCK_KEYWORDS_CHANGED_EVENT,
  loadDanmuKeywordBlockPreferences,
  loadDanmuPreferences,
  loadStoredVolume,
  persistDanmuPreferences,
  sanitizeDanmuArea,
  sanitizeDanmuOpacity
} from "@/components/player/constants";
import { arrangeControlClusters } from "@/components/player/controlLayout";
import { getLineOptionsForPlatform, resolveStoredLine } from "@/components/player/lineOptions";
import { POSITIONS } from "xgplayer/es/plugin/plugin.js";
import { Platform } from "@/platforms/common/types";
import { getDouyuStreamConfig } from "@/platforms/douyu/playerHelper";
import { fetchAndPrepareDouyinStreamConfig } from "@/platforms/douyin/playerHelper";
import { getHuyaStreamConfig } from "@/platforms/huya/playerHelper";
import { getBilibiliStreamConfig } from "@/platforms/bilibili/playerHelper";
import { useImageProxy } from "@/hooks/useImageProxy";
import { useWheelVolume } from "@/components/player/useWheelVolume";
import { useWatchTracker } from "@/hooks/useWatchTracker";
import { AnimatePresence, m } from "framer-motion";
import { useFollow, type Platform as FollowPlatform } from "@/state/follow/FollowProvider";

const qualityOptions = ["原画", "高清", "标清"] as const;

type UnifiedRustDanmakuPayload = {
  room_id?: string;
  user: string;
  content: string;
  user_level: number;
  fans_club_level: number;
  color?: string | null;
};

const DOUYU_COLORS: Record<number, string> = {
  1: '#FFFFFF',
  2: '#70C150',
  3: '#E04AC0',
  4: '#D4A113',
  5: '#8A5BE9',
  6: '#FF314E',
  7: '#FF314E'
};

function douyuColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  return DOUYU_COLORS[parseInt(color, 10)];
}

function isOfflineMessage(msg: string) {
  const s = (msg || "").toLowerCase();
  return s.includes("未开播") || s.includes("主播未开播") || s.includes("房间不存在");
}

function supportsMseType(mime: string) {
  try {
    return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function" && MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
}

// HEVC codec brand patch 只需对每个页面做一次（模块级 flag，跨 PlayerCell 实例共享）
let hevcBrandPatched = false;

const DEFAULT_DANMU_SETTINGS: DanmuUserSettings = {
  color: "#ffffff",
  strokeColor: "#444444",
  fontSize: "20px",
  duration: 10000,
  area: 0.5,
  mode: "scroll",
  opacity: 1
};

export type PlayerCellStatus = "loading" | "playing" | "offline" | "error";

export type PlayerCellMeta = {
  title: string | null;
  anchorName: string | null;
  avatar: string | null;
  isLive: boolean | null;
};

export function PlayerCell({
  platform,
  roomId,
  /** 是否聚焦格（PIPS_1_3 大格）：决定音频是否开声，见布局文档“音频策略” */
  isFocus,
  /** 点击格子的回调（用于 1+3 槽位交换 / 选中态） */
  onCellClick,
  /** 关闭该格房间（外部不传即不渲染"关闭"按钮——多屏格顶栏目前不显示"关闭"，
      通过 popOut 流程或上层 MultiviewProvider.closeSlot 处理让出槽位） */
  onClose,
  /** 单格 CSS 全屏切换（其余格隐藏，本格占满网格） */
  onToggleZoom,
  isZoomed = false,
  /** 切换该格房间（顶栏药丸内"切换"按钮：复用全局 spotlight，选完结果替换本格） */
  onReplace,
  /** 弹出该格房间为独立窗口观看（与单屏 MainPlayer 顶栏"独立窗口"按钮同语义） */
  onPopOut,
  /** 状态回调（loading/offline/error/playing + 元信息） */
  onMetaChange,
  /** 格子尺寸缩小（小格）时隐藏重控制栏（画质/线路等），只保留核心控制 */
  compactControls = false,
  /** 多屏槽位 index（观看会话的归属标识） */
  multiviewSlot
}: {
  platform: Platform;
  roomId: string;
  isFocus?: boolean;
  onCellClick?: () => void;
  onClose?: () => void;
  onToggleZoom?: () => void;
  isZoomed?: boolean;
  /** 切换该格房间 */
  onReplace?: () => void;
  /** 弹出该格房间为独立窗口观看 */
  onPopOut?: () => void;
  onMetaChange?: (meta: PlayerCellMeta & { status: PlayerCellStatus }) => void;
  compactControls?: boolean;
  multiviewSlot?: number | null;
}) {
  const { ensureProxyStarted, getAvatarSrc } = useImageProxy();

  const cellRef = useRef<HTMLDivElement | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const playbackKindRef = useRef<null | "hls" | "flv">(null);
  const danmuOverlayRef = useRef<DanmuOverlayInstance | null>(null);
  const unlistenRef = useRef<null | (() => void)>(null);

  // 滚轮调音量（TODO #2，按格生效）：悬停本格时调本格音量。
  // 非焦点格 keepMuted=true：保持"仅一格有声"音频策略，只调音量并让 UI 反映数值
  // 全局音量条 toast 仅在焦点格弹出，避免非焦点静默策略下误导（"音量变高却无声"）
  useWheelVolume(cellRef, playerRef, { keepMuted: !isFocus, showToast: !!isFocus });

  const disposedRef = useRef(false);
  const activeSessionIdRef = useRef(0);
  const sessionSeqRef = useRef(0);

  const refreshPluginRef = useRef<any>(null);
  const volumePluginRef = useRef<any>(null);
  const danmuTogglePluginRef = useRef<any>(null);
  const danmuSettingsPluginRef = useRef<any>(null);
  const danmuKeywordBlockPluginRef = useRef<any>(null);
  const qualityPluginRef = useRef<any>(null);
  const linePluginRef = useRef<any>(null);
  const mirrorFlipPluginRef = useRef<any>(null);

  const [status, setStatus] = useState<PlayerCellStatus>("loading");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [meta, setMeta] = useState<PlayerCellMeta>({ title: null, anchorName: null, avatar: null, isLive: null });

  // 多屏格顶栏：+ 关注 / ✓ 已关注（与单屏 MainPlayer 顶栏一致：纯图标 + framer-motion spring 旋转）
  const follow = useFollow();
  const followPlatform: FollowPlatform | null = useMemo(() => {
    if (platform === Platform.DOUYU) return "DOUYU";
    if (platform === Platform.HUYA) return "HUYA";
    if (platform === Platform.BILIBILI) return "BILIBILI";
    if (platform === Platform.DOUYIN) return "DOUYIN";
    return null;
  }, [platform]);
  const isFollowed = !!followPlatform && follow.isFollowed(followPlatform, roomId);
  const toggleFollow = useCallback(() => {
    if (!followPlatform) return;
    if (follow.isFollowed(followPlatform, roomId)) {
      follow.unfollowStreamer(followPlatform, roomId);
    } else {
      follow.followStreamer({
        id: roomId,
        platform: followPlatform,
        nickname: meta.anchorName || roomId,
        avatarUrl: meta.avatar || "",
        roomTitle: meta.title || "",
        currentRoomId: roomId,
        liveStatus: "UNKNOWN"
      });
    }
  }, [follow, followPlatform, meta.anchorName, meta.avatar, meta.title, roomId]);

  // 观看时长统计：每格一份会话，played 锁存在首次 status==="playing"
  useWatchTracker({
    platform,
    roomId,
    played: status === "playing",
    meta,
    multiviewSlot: multiviewSlot ?? null
  });
  const [isMirrorFlipped, setIsMirrorFlipped] = useState(false);
  const isMirrorFlippedRef = useRef(isMirrorFlipped);
  useEffect(() => {
    isMirrorFlippedRef.current = isMirrorFlipped;
  }, [isMirrorFlipped]);

  const [currentQuality, setCurrentQuality] = useState<string>(() => {
    if (typeof window === "undefined") return "原画";
    try {
      const saved = window.localStorage.getItem(`${platform}_preferred_quality`);
      if (saved && (qualityOptions as readonly string[]).includes(saved)) return saved;
    } catch {
      // ignore
    }
    return "原画";
  });
  const [currentLine, setCurrentLine] = useState<string | null>(() =>
    typeof window === "undefined" ? null : resolveStoredLine(platform)
  );
  const currentQualityRef = useRef(currentQuality);
  const currentLineRef = useRef(currentLine);
  currentQualityRef.current = currentQuality;
  currentLineRef.current = currentLine;

  const [isDanmuEnabled, setIsDanmuEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = loadDanmuPreferences();
    return stored?.enabled ?? true;
  });
  const [danmuSettings, setDanmuSettings] = useState<DanmuUserSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_DANMU_SETTINGS;
    const stored = loadDanmuPreferences();
    return stored?.settings ?? DEFAULT_DANMU_SETTINGS;
  });
  const [danmuKeywordBlock, setDanmuKeywordBlock] = useState<DanmuKeywordBlockPreferences>(() => {
    if (typeof window === "undefined") return { enabled: true, keywords: [] };
    const loaded = loadDanmuKeywordBlockPreferences();
    return loaded ? { enabled: true, keywords: loaded.keywords } : { enabled: true, keywords: [] };
  });
  const danmuKeywordBlockRef = useRef<{ keywordsLower: string[] }>({ keywordsLower: [] });
  useEffect(() => {
    danmuKeywordBlockRef.current = {
      keywordsLower: (danmuKeywordBlock.keywords ?? []).map((k) => String(k || "").trim().toLowerCase()).filter(Boolean)
    };
  }, [danmuKeywordBlock.keywords]);

  const isDanmuEnabledRef = useRef(isDanmuEnabled);
  useEffect(() => {
    isDanmuEnabledRef.current = isDanmuEnabled;
  }, [isDanmuEnabled]);

  // 全局关键词屏蔽列表变化时同步（与其他格共享同一 localStorage 键）
  useEffect(() => {
    const onKeywordsChanged = () => {
      const next = loadDanmuKeywordBlockPreferences();
      setDanmuKeywordBlock((prev) => {
        const nextKeywords = next?.keywords ?? [];
        const prevKeywords = prev.keywords ?? [];
        if (prevKeywords.length === nextKeywords.length && prevKeywords.every((k, i) => k === nextKeywords[i])) {
          return prev;
        }
        return { enabled: true, keywords: nextKeywords };
      });
    };
    window.addEventListener(DANMU_BLOCK_KEYWORDS_CHANGED_EVENT, onKeywordsChanged as EventListener);
    return () => window.removeEventListener(DANMU_BLOCK_KEYWORDS_CHANGED_EVENT, onKeywordsChanged as EventListener);
  }, []);

  useEffect(() => {
    if (platform === Platform.BILIBILI || platform === Platform.HUYA) {
      void ensureProxyStarted();
    }
  }, [ensureProxyStarted, platform]);

  const isSessionActive = useCallback((sessionId: number) => {
    return !disposedRef.current && activeSessionIdRef.current === sessionId;
  }, []);

  const notifyMeta = useCallback(
    (patch: Partial<PlayerCellMeta & { status: PlayerCellStatus }>) => {
      setMeta((prev) => {
        const next = { ...prev, ...patch } as PlayerCellMeta & { status: PlayerCellStatus };
        onMetaChange?.(next);
        return next;
      });
      if (patch.status) setStatus(patch.status);
    },
    [onMetaChange]
  );

  const destroyPlayer = useCallback(() => {
    try {
      unlistenRef.current?.();
    } catch {
      // ignore
    }
    unlistenRef.current = null;

    try {
      danmuOverlayRef.current?.clear?.();
      danmuOverlayRef.current?.stop?.();
    } catch {
      // ignore
    }
    danmuOverlayRef.current = null;

    try {
      playerRef.current?.destroy();
    } catch {
      // ignore
    }
    playerRef.current = null;
    playbackKindRef.current = null;

    refreshPluginRef.current = null;
    volumePluginRef.current = null;
    danmuTogglePluginRef.current = null;
    danmuSettingsPluginRef.current = null;
    qualityPluginRef.current = null;
    linePluginRef.current = null;
    mirrorFlipPluginRef.current = null;
  }, []);

  /** 只停本格房间对应的弹幕后端（多实例语义；其他格不受影响） */
  const stopOwnDanmakuBackend = useCallback(async () => {
    const roomIdToStop = danmakuBackendRoomIdRef.current;
    if (!roomIdToStop) return;
    try {
      if (platform === Platform.DOUYU) await invoke("stop_danmaku_listener", { roomId: roomIdToStop });
      else if (platform === Platform.DOUYIN) await invoke("stop_douyin_danmu_listener", { roomId: roomIdToStop });
      else if (platform === Platform.HUYA) await invoke("stop_huya_danmaku_listener", { roomId: roomIdToStop });
      else if (platform === Platform.BILIBILI) await invoke("stop_bilibili_danmaku_listener", { roomId: roomIdToStop });
    } catch {
      // ignore
    }
  }, [platform]);

  /** 只停本格会话的 FLV 代理（session=roomId；共享服务器，其他格不受影响） */
  const stopOwnProxy = useCallback(async () => {
    if (!danmakuBackendRoomIdRef.current) return;
    const session = danmakuBackendRoomIdRef.current;
    try {
      // 仅当本格代理确实占用过该 session 才停；斗鱼/虎牙代理会话共用同一 session key
      await invoke("stop_proxy", { session });
    } catch {
      // ignore
    }
  }, []);

  // 抖音：后端监听用 webRid 启动，事件按真实 room_id 过滤 —— 记录两者
  const danmakuBackendRoomIdRef = useRef<string | null>(null);

  const startDanmaku = useCallback(
    async (
      sessionId: number,
      overlay: DanmuOverlayInstance | null,
      platformToStart: Platform,
      roomIdToStart: string,
      roomIdToFilter?: string
    ) => {
      try {
        unlistenRef.current?.();
      } catch {
        // ignore
      }
      unlistenRef.current = null;

      if (!roomIdToStart) return;
      if (!isSessionActive(sessionId)) return;

      try {
        try {
          overlay?.clear?.();
        } catch {
          // ignore
        }
        // 先停本房间旧实例（同房间重载场景），不动其他房间
        await stopOwnDanmakuBackend();
        if (!isSessionActive(sessionId)) return;

        if (platformToStart === Platform.DOUYU) {
          await invoke("start_danmaku_listener", { roomId: roomIdToStart });
        } else if (platformToStart === Platform.DOUYIN) {
          const payload: RustGetStreamUrlPayload = { args: { room_id_str: roomIdToStart }, platform: Platform.DOUYIN };
          await invoke("start_douyin_danmu_listener", { payload });
        } else if (platformToStart === Platform.HUYA) {
          await invoke("start_huya_danmaku_listener", { payload: { args: { room_id_str: roomIdToStart } } });
        } else if (platformToStart === Platform.BILIBILI) {
          const cookie = typeof localStorage !== "undefined" ? localStorage.getItem("bilibili_cookie") : null;
          await invoke("start_bilibili_danmaku_listener", {
            payload: { args: { room_id_str: roomIdToStart } },
            cookie: cookie || null
          });
        }
      } catch (e) {
        console.warn("[PlayerCell] start danmaku backend failed:", e);
        return;
      }

      const effectiveFilterRoomId = roomIdToFilter || roomIdToStart;
      const unlisten = await listen<UnifiedRustDanmakuPayload>("danmaku-message", (event: TauriEvent<UnifiedRustDanmakuPayload>) => {
        if (!isSessionActive(sessionId)) return;
        const p = event.payload;
        if (!p) return;
        // 多屏关键：按 room_id 过滤，只渲染本格房间的弹幕
        if (p.room_id && p.room_id !== effectiveFilterRoomId) return;

        const msg: DanmakuMessage = {
          id: uuidv4(),
          nickname: p.user || "未知用户",
          content: p.content || "",
          level: String(p.user_level || 0),
          badgeLevel: p.fans_club_level > 0 ? String(p.fans_club_level) : undefined,
          room_id: p.room_id || effectiveFilterRoomId,
          color: douyuColor(p.color)
        };

        const contentLower = (msg.content || "").toLowerCase();
        const block = danmuKeywordBlockRef.current;
        if (block.keywordsLower.length > 0) {
          for (const kw of block.keywordsLower) {
            if (kw && contentLower.includes(kw)) return;
          }
        }

        if (isDanmuEnabledRef.current && overlay?.sendComment) {
          try {
            overlay.sendComment({
              id: msg.id,
              txt: msg.content,
              duration: 12000,
              mode: "scroll",
              sender: msg.nickname,
              style: { color: msg.color || "#FFFFFF" }
            });
          } catch {
            // ignore
          }
        }
      });

      unlistenRef.current = unlisten;
    },
    [isSessionActive, stopOwnDanmakuBackend]
  );

  const mountPlayer = useCallback(
    async (sessionId: number, url: string, streamType: string | undefined) => {
      if (!isSessionActive(sessionId)) return;
      let attempts = 0;
      while (!playerContainerRef.current && attempts < 10) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        attempts++;
      }
      if (!playerContainerRef.current) {
        console.error("[PlayerCell] Player container ref is not available after waiting");
        throw new Error("播放器容器初始化失败");
      }
      if (!isSessionActive(sessionId)) return;

      const isHlsPlayback = (streamType || "").toLowerCase() === "hls" || url.toLowerCase().includes(".m3u8");

      const [{ default: PlayerCtor }, flvMod, hlsMod, overlayMod, pluginsMod] = await Promise.all([
        import("xgplayer"),
        import("xgplayer-flv"),
        import("xgplayer-hls.js"),
        import("@/components/player/danmuOverlay"),
        import("@/components/player/plugins")
      ]);

      const FlvPlugin: any = (flvMod as any).default ?? flvMod;
      const HlsPlugin: any = (hlsMod as any).default ?? hlsMod;
      const { createDanmuOverlay, applyDanmuOverlayPreferences, syncDanmuEnabledState } = overlayMod as any;
      const { DanmuSettingsControl, DanmuToggleControl, LineControl, MirrorFlipControl, QualityControl, RefreshControl, VolumeControl } =
        pluginsMod as any;

      const playerOptions: any = {
        el: playerContainerRef.current,
        url,
        autoplay: true,
        isLive: true,
        playsinline: true,
        lang: "zh-cn",
        videoFillMode: "contain",
        closeVideoClick: true,
        closeVideoTouch: true,
        keyShortcut: false, // 多屏下快捷键只给聚焦格（避免多格同时响应）
        width: "100%",
        height: "100%",
        volume: false as unknown as number,
        playbackRate: false, // 直播无倍速，与单屏一致（MainPlayer 同样显式关闭）
        controls: { mode: "normal" }
      };

      if (isHlsPlayback) {
        const hlsFetchOptions: RequestInit = {
          referrer: "https://live.bilibili.com/",
          referrerPolicy: "no-referrer-when-downgrade",
          credentials: "omit",
          mode: "cors"
        };
        playerOptions.plugins = [HlsPlugin];
        playerOptions.useHlsPlugin = true;
        playerOptions.hls = {
          isLive: true,
          retryCount: 3,
          retryDelay: 2000,
          enableWorker: true,
          withCredentials: false,
          lowLatencyMode: false,
          fetchOptions: hlsFetchOptions,
          xhrSetup: (xhr: XMLHttpRequest) => {
            try {
              xhr.withCredentials = false;
              xhr.setRequestHeader("Referer", "https://live.bilibili.com/");
              xhr.setRequestHeader("Origin", "https://live.bilibili.com");
            } catch {
              // ignore
            }
          }
        };
      } else {
        const hev1 = 'video/mp4; codecs="hev1.1.6.L93.B0"';
        const hvc1 = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
        if (!hevcBrandPatched && !supportsMseType(hev1) && supportsMseType(hvc1)) {
          try {
            const mod: any = await import("xgplayer-transmuxer/es/codec/hevc.js");
            const HEVC: any = mod?.HEVC;
            const orig = HEVC?.parseHEVCDecoderConfigurationRecord;
            if (HEVC && typeof orig === "function") {
              HEVC.parseHEVCDecoderConfigurationRecord = function (data: any, hvcC?: any) {
                const ret = orig.call(this, data, hvcC);
                if (ret && typeof ret.codec === "string" && ret.codec.startsWith("hev1")) {
                  ret.codec = `hvc1${ret.codec.slice(4)}`;
                }
                return ret;
              };
              hevcBrandPatched = true;
              console.info("[PlayerCell] Patched HEVC codec brand: hev1 -> hvc1.");
            }
          } catch (e) {
            console.warn("[PlayerCell] Failed to patch HEVC codec brand:", e);
          }
        }

        playerOptions.plugins = [FlvPlugin];
        playerOptions.flv = {
          isLive: true,
          cors: true,
          autoCleanupSourceBuffer: true,
          enableWorker: true,
          stashInitialSize: 128,
          lazyLoad: true,
          lazyLoadMaxDuration: 30,
          deferLoadAfterSourceOpen: true
        };
      }

      const player = new (PlayerCtor as any)(playerOptions);
      playerRef.current = player;
      if (!isSessionActive(sessionId)) {
        try {
          player.destroy?.();
        } catch {
          // ignore
        }
        playerRef.current = null;
        return;
      }
      playbackKindRef.current = isHlsPlayback ? "hls" : "flv";

      try {
        const storedPlayerVolume = loadStoredVolume();
        if (storedPlayerVolume !== null) {
          player.volume = storedPlayerVolume;
          player.muted = storedPlayerVolume === 0 ? true : player.muted;
        }
        // 多屏音频策略（一期）：仅聚焦格开声，非聚焦格默认静音
        if (!isFocus) {
          player.muted = true;
        }
      } catch {
        // ignore
      }

      refreshPluginRef.current = player.registerPlugin?.(RefreshControl, {
        position: POSITIONS.CONTROLS_LEFT,
        index: 2,
        onClick: () => void reloadStreamRef.current?.("refresh")
      });

      volumePluginRef.current = player.registerPlugin?.(VolumeControl, {
        position: POSITIONS.CONTROLS_LEFT,
        index: 3
      });

      danmuTogglePluginRef.current = player.registerPlugin?.(DanmuToggleControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 4,
        getState: () => isDanmuEnabled,
        onToggle: (enabled: boolean) => setIsDanmuEnabled(enabled)
      });

      if (!compactControls) {
        danmuSettingsPluginRef.current = player.registerPlugin?.(DanmuSettingsControl, {
          position: POSITIONS.CONTROLS_RIGHT,
          index: 4.2,
          getSettings: () => danmuSettings,
          onChange: (partial: Partial<DanmuUserSettings>) => {
            setDanmuSettings((prev) => {
              const next: DanmuUserSettings = { ...prev, ...partial };
              next.area = sanitizeDanmuArea(next.area);
              next.opacity = sanitizeDanmuOpacity(next.opacity);
              if (typeof next.strokeColor !== "string") next.strokeColor = "#444444";
              return next;
            });
          }
        });

        qualityPluginRef.current = player.registerPlugin?.(QualityControl, {
          position: POSITIONS.CONTROLS_RIGHT,
          index: 5,
          options: [...qualityOptions],
          getCurrent: () => currentQualityRef.current,
          onSelect: (value: string) => {
            if (value === currentQualityRef.current) return;
            setCurrentQuality(value);
            try {
              window.localStorage.setItem(`${platform}_preferred_quality`, value);
            } catch {
              // ignore
            }
          }
        });

        const lineOptions = getLineOptionsForPlatform(platform);
        if (lineOptions.length > 0) {
          linePluginRef.current = player.registerPlugin?.(LineControl, {
            position: POSITIONS.CONTROLS_RIGHT,
            index: 5.2,
            options: [...lineOptions],
            getCurrentKey: () => currentLineRef.current ?? lineOptions[0]?.key ?? "",
            getCurrentLabel: () => lineOptions.find((o) => o.key === currentLineRef.current)?.label ?? "线路",
            onSelect: (lineKey: string) => {
              if (lineKey === currentLineRef.current) return;
              setCurrentLine(lineKey);
              try {
                window.localStorage.setItem(`${platform}_preferred_line`, lineKey);
              } catch {
                // ignore
              }
            }
          });
        }
      }

      mirrorFlipPluginRef.current = player.registerPlugin?.(MirrorFlipControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 4.1,
        getState: () => isMirrorFlippedRef.current,
        onToggle: (flipped: boolean) => setIsMirrorFlipped(flipped)
      });

      arrangeControlClusters(player);

      // danmu overlay（每格独立）
      const overlay = createDanmuOverlay(player, danmuSettings, isDanmuEnabled) as DanmuOverlayInstance | null;
      danmuOverlayRef.current = overlay;
      try {
        applyDanmuOverlayPreferences?.(overlay, danmuSettings, isDanmuEnabled, player.root as any);
        syncDanmuEnabledState?.(overlay, danmuSettings, isDanmuEnabled, player.root as any);
      } catch {
        // ignore
      }

      const backendRoomId = danmakuBackendRoomIdRef.current || roomId;
      await startDanmaku(sessionId, overlay, platform, backendRoomId, backendRoomId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compactControls, danmuSettings, isDanmuEnabled, isFocus, isSessionActive, platform, roomId, startDanmaku]
  );

  const reloadStreamRef = useRef<null | ((trigger: "refresh" | "quality" | "line") => Promise<void>)>(null);
  const qualityReloadArmedRef = useRef(false);
  const reloadInFlightRef = useRef(false);
  const pendingReloadRef = useRef<null | { trigger: "refresh" | "quality" | "line" }>(null);

  const reloadStream = useCallback(
    async (_trigger: "refresh" | "quality" | "line") => {
      if (reloadInFlightRef.current) {
        pendingReloadRef.current = { trigger: _trigger };
        return;
      }
      reloadInFlightRef.current = true;
      const sessionId = ++sessionSeqRef.current;
      activeSessionIdRef.current = sessionId;

      notifyMeta({ status: "loading" });
      setStreamError(null);

      await stopOwnDanmakuBackend();
      if (!isSessionActive(sessionId)) return;

      try {
        await applyDanmuFontFamilyForOS();
      } catch {
        // ignore
      }

      try {
        let streamUrl: string;
        let streamType: string | undefined;
        let metaPatch: Partial<PlayerCellMeta> = {};

        if (platform === Platform.DOUYU) {
          try {
            const info = await invoke<any>("fetch_douyu_room_info", { roomId });
            metaPatch = { title: info?.room_name ?? null, anchorName: info?.nickname ?? null, avatar: info?.avatar_url ?? null };
          } catch {
            // ignore meta fetch failures
          }
          const cfg = await getDouyuStreamConfig(roomId, currentQualityRef.current, currentLineRef.current, roomId);
          streamUrl = cfg.streamUrl;
          streamType = cfg.streamType;
          danmakuBackendRoomIdRef.current = roomId;
        } else if (platform === Platform.DOUYIN) {
          const resp = await fetchAndPrepareDouyinStreamConfig(roomId, currentQualityRef.current);
          metaPatch = {
            title: resp.title ?? null,
            anchorName: resp.anchorName ?? null,
            avatar: resp.avatar ?? null,
            isLive: resp.isLive
          };
          if (!resp.streamUrl) throw new Error(resp.initialError || "主播未开播或无法获取直播流");
          streamUrl = resp.streamUrl;
          streamType = resp.streamType;
          // 抖音后端用 webRid 启动监听，事件按 normalizedRoomId 过滤
          danmakuBackendRoomIdRef.current = resp.webRid || roomId;
        } else if (platform === Platform.HUYA) {
          const cfg = await getHuyaStreamConfig(roomId, currentQualityRef.current, currentLineRef.current, roomId);
          metaPatch = {
            title: cfg.title ?? null,
            anchorName: cfg.anchorName ?? null,
            avatar: cfg.avatar ?? null,
            isLive: typeof cfg.isLive === "boolean" ? cfg.isLive : null
          };
          streamUrl = cfg.streamUrl;
          streamType = cfg.streamType;
          danmakuBackendRoomIdRef.current = roomId;
        } else {
          const cookie = typeof localStorage !== "undefined" ? localStorage.getItem("bilibili_cookie") : null;
          try {
            const info = await invoke<any>("fetch_bilibili_streamer_info", {
              payload: { platform, args: { room_id_str: roomId } },
              cookie: cookie || null
            });
            metaPatch = { title: info?.title ?? null, anchorName: info?.anchor_name ?? null, avatar: info?.avatar ?? null };
          } catch {
            // ignore meta fetch failures
          }
          const cfg = await getBilibiliStreamConfig(roomId, currentQualityRef.current, cookie || undefined);
          streamUrl = cfg.streamUrl;
          streamType = cfg.streamType;
          danmakuBackendRoomIdRef.current = roomId;
        }

        if (!isSessionActive(sessionId)) return;
        notifyMeta({ ...metaPatch, status: "playing" });

        const nextIsHls = (streamType || "").toLowerCase() === "hls" || streamUrl.toLowerCase().includes(".m3u8");
        const nextKind: "hls" | "flv" = nextIsHls ? "hls" : "flv";
        const player = playerRef.current;
        const canSoftSwitch =
          !!player &&
          !!danmuOverlayRef.current &&
          typeof player.switchURL === "function" &&
          !!playbackKindRef.current &&
          playbackKindRef.current === nextKind;
        if (canSoftSwitch) {
          try {
            const ret = player.switchURL(streamUrl, { seamless: false });
            if (ret && typeof (ret as any).then === "function") await ret;
            if (isSessionActive(sessionId)) {
              playbackKindRef.current = nextKind;
              await startDanmaku(sessionId, danmuOverlayRef.current, platform, danmakuBackendRoomIdRef.current || roomId);
            }
          } catch {
            destroyPlayer();
            await mountPlayer(sessionId, streamUrl, streamType);
          }
        } else {
          destroyPlayer();
          await mountPlayer(sessionId, streamUrl, streamType);
        }
      } catch (e: any) {
        if (!isSessionActive(sessionId)) return;
        destroyPlayer();
        const msg = e?.message ? String(e.message) : String(e);
        setStreamError(msg);
        notifyMeta({ status: isOfflineMessage(msg) ? "offline" : "error" });
      } finally {
        if (isSessionActive(sessionId)) {
          // status already updated
        }
        reloadInFlightRef.current = false;
        const pending = pendingReloadRef.current;
        pendingReloadRef.current = null;
        if (pending) {
          // 必须经 reloadStreamRef 用最新闭包重放（同 MainPlayer）：否则快速换房/换清晰度时
          // 会用旧 roomId 的闭包重放，本格播放停留在上一个房间
          void reloadStreamRef.current?.(pending.trigger);
        }
      }
    },
    [destroyPlayer, isSessionActive, mountPlayer, notifyMeta, platform, roomId, startDanmaku, stopOwnDanmakuBackend]
  );

  useEffect(() => {
    reloadStreamRef.current = reloadStream;
  }, [reloadStream]);

  // 卸载：销毁播放器 + 停本格弹幕后端 + 停本格代理会话
  useEffect(() => {
    return () => {
      disposedRef.current = true;
      destroyPlayer();
      void stopOwnDanmakuBackend();
      void stopOwnProxy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    void reloadStream("refresh");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, roomId]);

  // 弹幕设置同步（overlay + 控件 + 持久化）
  useEffect(() => {
    import("@/components/player/danmuOverlay")
      .then((mod: any) => {
        mod.applyDanmuOverlayPreferences?.(danmuOverlayRef.current, danmuSettings, isDanmuEnabled, playerRef.current?.root as any);
        mod.syncDanmuEnabledState?.(danmuOverlayRef.current, danmuSettings, isDanmuEnabled, playerRef.current?.root as any);
      })
      .catch(() => {});

    try {
      persistDanmuPreferences({ enabled: isDanmuEnabled, settings: danmuSettings });
    } catch {
      // ignore
    }

    try {
      danmuTogglePluginRef.current?.setState?.(isDanmuEnabled);
      danmuSettingsPluginRef.current?.setSettings?.(danmuSettings);
    } catch {
      // ignore
    }
  }, [danmuSettings, isDanmuEnabled]);

  useEffect(() => {
    try {
      danmuKeywordBlockPluginRef.current?.setPreferences?.(danmuKeywordBlock);
    } catch {
      // ignore
    }
  }, [danmuKeywordBlock]);

  useEffect(() => {
    try {
      qualityPluginRef.current?.setOptions?.([...qualityOptions]);
      qualityPluginRef.current?.updateLabel?.(currentQuality);
    } catch {
      // ignore
    }
  }, [currentQuality]);

  useEffect(() => {
    try {
      mirrorFlipPluginRef.current?.setState?.(isMirrorFlipped);
    } catch {
      // ignore
    }
  }, [isMirrorFlipped]);

  // 画质/线路变化触发重载（首次跳过）
  useEffect(() => {
    if (!qualityReloadArmedRef.current) {
      qualityReloadArmedRef.current = true;
      return;
    }
    const id = window.setTimeout(() => void reloadStream("quality"), 80);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQuality, currentLine]);

  const displayTitle = meta.title || meta.anchorName || roomId;

  return (
    <div
      className={`mv-cell${isFocus ? " is-focus" : ""}${isMirrorFlipped ? " is-mirror-flipped" : ""}`}
      ref={cellRef}
      onPointerDown={(e) => {
        if (e.button === 0) onCellClick?.();
      }}
    >
      <div className="mv-cell-topbar">
        {onClose ? (
          <button
            type="button"
            className="mv-cell-close-btn"
            aria-label="关闭该格房间"
            title="关闭该格房间"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        ) : null}
        <div className="mv-cell-streamer" title={displayTitle}>
          <div className="mv-cell-avatar">
            {meta.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={getAvatarSrc(platform, meta.avatar)} alt={meta.anchorName ?? roomId} />
            ) : (
              <div className="mv-cell-avatarFallback">{(meta.anchorName || roomId || "D").charAt(0).toUpperCase()}</div>
            )}
          </div>
          <div className="mv-cell-meta">
            <div className="mv-cell-title">{displayTitle}</div>
            <div className="mv-cell-sub">
              {meta.anchorName || "未知主播"} · ID:{roomId}
            </div>
          </div>
          {followPlatform ? (
            <button
              type="button"
              className={`mv-cell-tool mv-cell-follow${isFollowed ? " is-active" : ""}`}
              title={isFollowed ? "取消关注" : "关注主播"}
              aria-label={isFollowed ? "取消关注" : "关注主播"}
              aria-pressed={isFollowed}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                toggleFollow();
              }}
            >
              <AnimatePresence initial={false} mode="popLayout">
                <m.span
                  key={isFollowed ? "check" : "plus"}
                  className="mv-cell-follow-glyph"
                  initial={isFollowed ? { rotate: -90, opacity: 0 } : { rotate: 90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={isFollowed ? { rotate: 90, opacity: 0 } : { rotate: -90, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 480, damping: 32, mass: 0.6 }}
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={isFollowed ? 2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
                    {isFollowed ? (
                      <path d="M5 12.5l4.2 4.2L19 7" />
                    ) : (
                      <>
                        <path d="M12 5v14" />
                        <path d="M5 12h14" />
                      </>
                    )}
                  </svg>
                </m.span>
              </AnimatePresence>
            </button>
          ) : null}
          {onPopOut ? (
            <button
              type="button"
              className="mv-cell-tool mv-cell-popout"
              title="弹出为独立窗口观看（沉浸无边框）"
              aria-label="独立窗口"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onPopOut();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 4h6v6" />
                <path d="M20 4 10 14" />
                <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
              </svg>
            </button>
          ) : null}
          {onReplace ? (
            <button
              type="button"
              className="mv-cell-tool mv-cell-replace"
              aria-label="切换该房间"
              title="切换该房间"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onReplace();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3 4 7l4 4" />
                <path d="M4 7h16" />
                <path d="m16 21 4-4-4-4" />
                <path d="M20 17H4" />
              </svg>
            </button>
          ) : null}
          {onToggleZoom ? (
            <button
              type="button"
              className="mv-cell-tool"
              aria-label={isZoomed ? "退出单格全屏" : "单格全屏"}
              title={isZoomed ? "退出单格全屏 (Esc)" : "单格全屏"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onToggleZoom();
              }}
            >
              {isZoomed ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              )}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mv-cell-video">
        <div ref={playerContainerRef} className="video-player" />

        {status === "loading" ? <div className="loading-player" style={{ position: "absolute", inset: 0, zIndex: 20 }} /> : null}

        {status === "offline" || status === "error" ? (
          <div className={status === "offline" ? "offline-player" : "error-player"} style={{ position: "absolute", inset: 0, zIndex: 20 }}>
            <div style={{ padding: 14, width: "min(360px, 90%)", margin: "0 auto", textAlign: "left" }}>
              <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>{status === "offline" ? "主播未开播" : "加载失败"}</div>
              <div style={{ color: "var(--secondary-text)", fontWeight: 600, whiteSpace: "pre-wrap", fontSize: 12 }}>{streamError}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="retry-btn" onClick={() => void reloadStream("refresh")}>
                  再试一次
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
