"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { Volume2, VolumeX } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import "xgplayer/dist/index.min.css";

import styles from "./HoverStreamPreview.module.css";
import { getDouyuStreamConfig } from "@/platforms/douyu/playerHelper";
import { getHuyaStreamConfig } from "@/platforms/huya/playerHelper";
import { getBilibiliStreamConfig } from "@/platforms/bilibili/playerHelper";
import { fetchAndPrepareDouyinStreamConfig } from "@/platforms/douyin/playerHelper";
import { loadStoredVolume } from "@/components/player/constants";

const PREVIEW_QUALITY = "标清";

let hevcBrandPatched = false;

function supportsMseType(mime: string) {
  try {
    return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function" && MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
}

async function patchHevcIfNeeded() {
  const hev1 = 'video/mp4; codecs="hev1.1.6.L93.B0"';
  const hvc1 = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
  if (hevcBrandPatched || supportsMseType(hev1) || !supportsMseType(hvc1)) return;
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
    }
  } catch {
    // ignore
  }
}

type PreviewStream = {
  url: string | null;
  type: string | undefined;
  session: string | null;
};

async function fetchPreviewStream(platform: string, roomId: string): Promise<PreviewStream> {
  const session = uuidv4();
  if (platform === "DOUYU") {
    const cfg = await getDouyuStreamConfig(roomId, PREVIEW_QUALITY, null, session);
    return { url: cfg.streamUrl, type: cfg.streamType, session: cfg.proxySession };
  }
  if (platform === "HUYA") {
    const cfg = await getHuyaStreamConfig(roomId, PREVIEW_QUALITY, null, session);
    return { url: cfg.streamUrl, type: cfg.streamType, session: cfg.proxySession };
  }
  if (platform === "BILIBILI") {
    const cookie = typeof localStorage !== "undefined" ? localStorage.getItem("bilibili_cookie") || undefined : undefined;
    const cfg = await getBilibiliStreamConfig(roomId, PREVIEW_QUALITY, cookie, session);
    return { url: cfg.streamUrl, type: cfg.streamType, session: cfg.proxySession };
  }
  // DOUYIN：直连 CDN flv，无代理 session 需要释放。多数房间仅原画，标清失败时回退
  let resp = await fetchAndPrepareDouyinStreamConfig(roomId, PREVIEW_QUALITY);
  if (!resp.streamUrl) resp = await fetchAndPrepareDouyinStreamConfig(roomId, "原画");
  return { url: resp.streamUrl, type: resp.streamType, session: null };
}

export function HoverStreamPreview({ platform, roomId }: { platform: string; roomId: string }) {
  const platformKey = platform.toUpperCase();
  const elRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const [state, setState] = useState<"loading" | "playing" | "fail">("loading");
  const [soundOn, setSoundOn] = useState(false);

  // 预览默认静音；点喇叭开声（沿用主播放器存的音量偏好）。换卡/重挂载回静音，避免下次悬停突然出声
  const toggleSound = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    const next = !soundOn;
    try {
      if (next) {
        const stored = loadStoredVolume();
        p.volume = typeof stored === "number" && stored > 0 ? stored : 0.6;
        p.muted = false;
      } else {
        p.muted = true;
        p.volume = 0;
      }
    } catch {
      // ignore
    }
    setSoundOn(next);
  }, [soundOn]);

  useEffect(() => {
    let cancelled = false;
    let player: any = null;
    let session: string | null = null;

    const start = async () => {
      setState("loading");
      setSoundOn(false);
      try {
        const cfg = await fetchPreviewStream(platformKey, roomId);
        session = cfg.session;
        if (cancelled) return;
        if (!cfg.url) {
          setState("fail");
          return;
        }

        const isHls = (cfg.type || "").toLowerCase() === "hls" || cfg.url!.toLowerCase().includes(".m3u8");
        const [{ default: PlayerCtor }, playerMod] = await Promise.all([
          import("xgplayer"),
          isHls ? import("xgplayer-hls.js") : import("xgplayer-flv")
        ]);
        if (cancelled) return;

        const container = elRef.current;
        if (!container) return;

        if (!isHls) await patchHevcIfNeeded();

        const PlayPlugin: any = (playerMod as any).default ?? playerMod;
        const opts: any = {
          el: container,
          url: cfg.url,
          autoplay: true,
          isLive: true,
          playsinline: true,
          muted: true,
          volume: 0,
          lang: "zh-cn",
          videoFillMode: "contain",
          controls: false,
          keyShortcut: false,
          width: "100%",
          height: "100%"
        };
        if (isHls) {
          opts.plugins = [PlayPlugin];
          opts.hls = { isLive: true, retryCount: 1, enableWorker: true, withCredentials: false };
        } else {
          opts.plugins = [PlayPlugin];
          opts.flv = {
            isLive: true,
            cors: true,
            autoCleanupSourceBuffer: true,
            enableWorker: true,
            stashInitialSize: 128,
            lazyLoad: true,
            lazyLoadMaxDuration: 30
          };
        }

        player = new (PlayerCtor as any)(opts);
        playerRef.current = player;
        player.muted = true;
        try {
          player.volume = 0;
        } catch {
          // ignore
        }
        player.on("error", () => {
          if (!cancelled) setState("fail");
        });
        if (cancelled) {
          try {
            player.destroy?.();
          } catch {
            // ignore
          }
          playerRef.current = null;
          return;
        }
        setState("playing");
      } catch {
        if (!cancelled) setState("fail");
      }
    };

    void start();

    return () => {
      cancelled = true;
      try {
        player?.destroy?.();
      } catch {
        // ignore
      }
      player = null;
      playerRef.current = null;
      if (session) {
        void invoke("stop_proxy", { session }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformKey, roomId]);

  return (
    <div className={`${styles.root}${state === "fail" ? ` ${styles.rootFail}` : ""}`}>
      {state !== "fail" ? (
        <div ref={elRef} className={styles.mount} aria-hidden="true" />
      ) : null}
      {state === "loading" ? (
        <div className={styles.spinnerWrap} aria-hidden="true">
          <span className={styles.spinner} />
        </div>
      ) : null}
      {state === "playing" ? (
        <button
          type="button"
          className={`${styles.soundBtn}${soundOn ? ` ${styles.soundBtnOn}` : ""}`}
          title={soundOn ? "预览静音" : "预览开声音"}
          aria-label={soundOn ? "预览静音" : "预览开声音"}
          aria-pressed={soundOn}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            toggleSound();
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {soundOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
      ) : null}
    </div>
  );
}
