import DanmuJs from 'danmu.js';
import type Player from 'xgplayer';

import { DANMU_AREA_TOP_MARGIN, sanitizeDanmuArea, sanitizeDanmuOpacity } from './constants';
import type { DanmuOverlayInstance } from './types';
import type { DanmuUserSettings } from './constants';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const parseFontSizePx = (fontSize: string | undefined) => {
  const parsed = parseInt(String(fontSize ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : 20;
};

const computeChannelSize = (fontSizePx: number) => {
  // danmu.js uses virtual channels; channel size should roughly match bullet height.
  // Larger channelSize => fewer channels (better performance, less overlap risk).
  return clamp(Math.round(fontSizePx + 10), 28, 64);
};

const computeMaxBullets = (host: HTMLElement, settings: DanmuUserSettings) => {
  const height = host.offsetHeight || 0;
  const area = sanitizeDanmuArea(settings.area);
  const fontSizePx = parseFontSizePx(settings.fontSize);
  const channelSize = computeChannelSize(fontSizePx);
  const visibleHeight = Math.max(1, Math.floor(height * Math.max(0, area - DANMU_AREA_TOP_MARGIN)));
  const approxLines = Math.max(1, Math.floor(visibleHeight / channelSize));
  return approxLines * 4;
};

const computeAreaLines = (host: HTMLElement, settings: DanmuUserSettings) => {
  const height = host.offsetHeight || 0;
  if (height <= 0) return undefined;
  const area = sanitizeDanmuArea(settings.area);
  const fontSizePx = parseFontSizePx(settings.fontSize);
  const channelSize = computeChannelSize(fontSizePx);
  const visibleHeight = Math.max(1, Math.floor(height * Math.max(0, area - DANMU_AREA_TOP_MARGIN)));
  const approxLines = Math.max(1, Math.floor(visibleHeight / channelSize));
  return clamp(approxLines, 1, 60);
};

export const ensureDanmuOverlayHost = (player: Player): HTMLElement | null => {
  const root = player.root as HTMLElement | undefined;
  if (!root) {
    return null;
  }

  let host = root.querySelector('.player-danmu-overlay') as HTMLElement | null;
  if (!host) {
    host = document.createElement('div');
    host.className = 'player-danmu-overlay';
  }

  const videoContainer = root.querySelector('xg-video-container');
  if (videoContainer && host.parentElement !== videoContainer) {
    videoContainer.appendChild(host);
  } else if (!videoContainer && host.parentElement !== root) {
    root.appendChild(host);
  } else if (!host.parentElement) {
    root.appendChild(host);
  }

  return host;
};

export const applyDanmuOverlayPreferences = (
  overlay: DanmuOverlayInstance | null,
  danmuSettings: DanmuUserSettings,
  isDanmuEnabled: boolean,
  playerRoot?: HTMLElement | null,
) => {
  if (!overlay) {
    return;
  }
  const host = playerRoot?.querySelector('.player-danmu-overlay') as HTMLElement | null;
  const fontSizeValue = parseInt(danmuSettings.fontSize, 10);
  if (!Number.isNaN(fontSizeValue)) {
    try {
      overlay.setFontSize?.(fontSizeValue);
    } catch (error) {
      console.warn('[Player] Failed to apply danmu font size:', error);
    }
  }
  try {
    const areaValue = sanitizeDanmuArea(danmuSettings.area);
    overlay.setArea?.({ end: areaValue });
  } catch (error) {
    console.warn('[Player] Failed to apply danmu area:', error);
  }
  try {
    overlay.setAllDuration?.('scroll', danmuSettings.duration);
    overlay.setAllDuration?.('top', danmuSettings.duration);
    overlay.setAllDuration?.('bottom', danmuSettings.duration);
  } catch (error) {
    // Non-critical for players that do not support bulk duration updates
  }
  try {
    const normalizedOpacity = sanitizeDanmuOpacity(danmuSettings.opacity);
    const nextOpacity = isDanmuEnabled ? normalizedOpacity : 0;
    overlay.setOpacity?.(nextOpacity);
    host?.style.setProperty('--danmu-opacity', String(nextOpacity));
  } catch (error) {
    // Non-critical
  }
  try {
    host?.style.setProperty('--danmu-stroke-color', danmuSettings.strokeColor);
  } catch (error) {
    console.warn('[Player] Failed to apply danmu stroke color:', error);
  }
};

export const syncDanmuEnabledState = (
  overlay: DanmuOverlayInstance | null,
  danmuSettings: DanmuUserSettings,
  isDanmuEnabled: boolean,
  playerRoot?: HTMLElement | null,
) => {
  if (!overlay) {
    return;
  }
  const normalizedOpacity = sanitizeDanmuOpacity(danmuSettings.opacity);
  const targetOpacity = isDanmuEnabled ? normalizedOpacity : 0;
  try {
    if (isDanmuEnabled) {
      overlay.play?.();
      overlay.show?.('scroll');
      overlay.show?.('top');
      overlay.show?.('bottom');
    } else {
      overlay.pause?.();
    }
    overlay.setOpacity?.(targetOpacity);
    const host = playerRoot?.querySelector('.player-danmu-overlay') as HTMLElement | null;
    host?.style.setProperty('--danmu-opacity', String(targetOpacity));
  } catch (error) {
    console.warn('[Player] Failed updating danmu enabled state:', error);
  }
};

export const createDanmuOverlay = (
  player: Player | null,
  danmuSettings: DanmuUserSettings,
  isDanmuEnabled: boolean,
): DanmuOverlayInstance | null => {
  if (!player) {
    return null;
  }

  const overlayHost = ensureDanmuOverlayHost(player);
  if (!overlayHost) {
    return null;
  }

  overlayHost.innerHTML = '';
  overlayHost.style.setProperty('--danmu-stroke-color', danmuSettings.strokeColor);
  overlayHost.style.setProperty('--danmu-opacity', String(isDanmuEnabled ? sanitizeDanmuOpacity(danmuSettings.opacity) : 0));

  try {
    const media = (player as any).video || (player as any).media || undefined;

    let currentEnabled = isDanmuEnabled;
    let currentSettings: DanmuUserSettings = { ...danmuSettings };
    let currentOpacity = currentEnabled ? sanitizeDanmuOpacity(currentSettings.opacity) : 0;

    const initialFontSizePx = parseFontSizePx(currentSettings.fontSize);
    const initialChannelSize = computeChannelSize(initialFontSizePx);
    const initialAreaEnd = sanitizeDanmuArea(currentSettings.area);

    const danmu = new DanmuJs({
      container: overlayHost,
      containerStyle: { zIndex: 7 },
      player: media,
      comments: [],
      area: { start: DANMU_AREA_TOP_MARGIN, end: initialAreaEnd, lines: computeAreaLines(overlayHost, currentSettings) },
      channelSize: initialChannelSize,
      mouseControl: false,
      mouseEnterControl: true,
      mouseControlPause: false,
      // Increase horizontal gap slightly to reduce bursts; keeps no-overlap stable under load.
      bOffset: 800,
      chaseEffect: true,
      // Delay initialization until explicitly enabled to save CPU/GPU on startup.
      defaultOff: true,
    } as any);

    let started = false;
    const ensureStarted = () => {
      if (started) return;
      try {
        danmu.start();
        started = true;
      } catch (error) {
        console.warn('[Player] Failed to start danmu.js:', error);
      }
    };

    // —— 悬停弹幕显示发送者 ——
    // host 自身保持 pointer-events:none（不挡播放器交互），仅子弹元素在开启弹幕时放开命中，
    // danmu.js 的 mouseover 挂在 host 上、由子弹事件冒泡触发 bullet_hover。
    // 悬停的那一条 freezeComment 冻结（其余照常滚动），离开/隐藏时 restartComment 恢复。
    const tooltip = document.createElement('div');
    tooltip.className = 'danmu-sender-tooltip';
    let hoveredBullet: any = null;
    let followRafId = 0;
    let pointerX = 0;
    let pointerY = 0;

    const syncHostHoverability = () => {
      overlayHost.classList.toggle('danmu-hoverable', currentEnabled && currentOpacity > 0);
    };

    const stopFollowTooltip = () => {
      if (followRafId) {
        cancelAnimationFrame(followRafId);
        followRafId = 0;
      }
      if (hoveredBullet) {
        try {
          danmu.restartComment?.(hoveredBullet.id);
        } catch {
          // ignore
        }
      }
      hoveredBullet = null;
      tooltip.style.display = 'none';
    };

    const followTooltip = () => {
      followRafId = 0;
      const el = hoveredBullet?.el as HTMLElement | undefined;
      if (!el || !el.isConnected) {
        stopFollowTooltip();
        return;
      }
      const bulletRect = el.getBoundingClientRect();
      if (
        pointerX < bulletRect.left ||
        pointerX > bulletRect.right ||
        pointerY < bulletRect.top ||
        pointerY > bulletRect.bottom
      ) {
        stopFollowTooltip();
        return;
      }
      const hostRect = overlayHost.getBoundingClientRect();
      if (!tooltip.isConnected) {
        overlayHost.parentElement?.appendChild(tooltip);
      }
      tooltip.style.display = 'block';
      let left = bulletRect.left - hostRect.left;
      let top = bulletRect.top - hostRect.top - tooltip.offsetHeight - 6;
      if (top < 2) {
        top = bulletRect.bottom - hostRect.top + 6;
      }
      left = clamp(left, 2, Math.max(2, hostRect.width - tooltip.offsetWidth - 2));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      followRafId = requestAnimationFrame(followTooltip);
    };

    const handlePointerMove = (event: Event) => {
      const e = event as PointerEvent;
      pointerX = e.clientX;
      pointerY = e.clientY;
    };
    const handlePointerOut = (event: Event) => {
      const el = hoveredBullet?.el as HTMLElement | undefined;
      const target = event.target as Node | null;
      if (!el || !target) return;
      if (target !== el && !el.contains(target)) return;
      const related = (event as PointerEvent).relatedTarget as Node | null;
      if (related && el.contains(related)) return;
      stopFollowTooltip();
    };

    overlayHost.addEventListener('pointermove', handlePointerMove);
    overlayHost.addEventListener('pointerout', handlePointerOut);

    danmu.on?.('bullet_hover', ({ bullet, event }: any) => {
      if (!currentEnabled || currentOpacity <= 0) return;
      const sender = bullet?.options?.sender;
      if (typeof sender !== 'string' || !sender || !bullet?.el) return;
      if (hoveredBullet && hoveredBullet !== bullet) {
        try {
          danmu.restartComment?.(hoveredBullet.id);
        } catch {
          // ignore
        }
      }
      try {
        danmu.freezeComment?.(bullet.id);
      } catch {
        // ignore
      }
      const mouseEvent = event as PointerEvent | undefined;
      pointerX = mouseEvent?.clientX ?? 0;
      pointerY = mouseEvent?.clientY ?? 0;
      hoveredBullet = bullet;
      tooltip.textContent = sender;
      if (!followRafId) {
        followRafId = requestAnimationFrame(followTooltip);
      }
    });

    danmu.on?.('bullet_remove', ({ bullet }: any) => {
      if (hoveredBullet && bullet === hoveredBullet) {
        stopFollowTooltip();
      }
    });

    syncHostHoverability();

    const overlay: DanmuOverlayInstance = {
      sendComment: (comment) => {
        try {
          if (!currentEnabled || currentOpacity <= 0) {
            return;
          }

          ensureStarted();

          // 高密度时做轻量限流（优先保证不重叠/不卡顿）。
          try {
            const bullets = (danmu as any)?.state?.bullets;
            const bulletCount = Array.isArray(bullets) ? bullets.length : 0;
            const maxBullets = computeMaxBullets(overlayHost, currentSettings);
            if (bulletCount > maxBullets) {
              return;
            }
          } catch {
            // ignore density checks
          }

          const id = comment.id || `${Date.now()}_${Math.random().toString(16).slice(2)}`;
          const duration = clamp(Number(comment.duration ?? currentSettings.duration ?? 12000), 5000, 60000);
          const mode = comment.mode === 'top' || comment.mode === 'bottom' || comment.mode === 'scroll' ? comment.mode : 'scroll';
          const fontSizePx = parseFontSizePx(currentSettings.fontSize);
          const mergedStyle = {
            fontSize: `${fontSizePx}px`,
            color: comment.style?.color || currentSettings.color || '#ffffff',
            ...(comment.style ?? {}),
          };

          danmu.sendComment({ id, txt: comment.txt, duration, mode, sender: comment.sender, style: mergedStyle } as any);
        } catch (error) {
          console.warn('[Player] Failed emitting danmu.js comment:', error);
        }
      },
      clear: () => {
        try {
          const state: any = (danmu as any)?.state;
          if (state?.bullets && Array.isArray(state.bullets)) {
            state.bullets.splice(0, state.bullets.length);
          }
          if (state?.comments && Array.isArray(state.comments)) {
            state.comments.splice(0, state.comments.length);
          }
        } catch {
          // ignore internal state clearing
        }
        try {
          overlayHost.innerHTML = '';
        } catch {
          // ignore DOM clearing
        }
        stopFollowTooltip();
        tooltip.remove();
      },
      play: () => {
        currentEnabled = true;
        currentOpacity = sanitizeDanmuOpacity(currentSettings.opacity);
        syncHostHoverability();
        ensureStarted();
        try {
          danmu.play();
        } catch {}
      },
      pause: () => {
        currentEnabled = false;
        currentOpacity = 0;
        stopFollowTooltip();
        syncHostHoverability();
        try {
          danmu.pause();
        } catch {}
      },
      stop: () => {
        stopFollowTooltip();
        try {
          danmu.stop();
        } catch {}
      },
      start: () => {
        ensureStarted();
      },
      hide: (mode?: string) => {
        ensureStarted();
        try {
          danmu.hide?.(mode);
        } catch {}
      },
      show: (mode?: string) => {
        ensureStarted();
        try {
          danmu.show?.(mode);
        } catch {}
      },
      setOpacity: (opacity: number) => {
        const next = Math.max(0, Math.min(1, opacity));
        currentOpacity = currentEnabled ? next : 0;
        if (currentOpacity <= 0) {
          stopFollowTooltip();
        }
        syncHostHoverability();
        overlayHost.style.setProperty('--danmu-opacity', String(currentOpacity));
        try {
          danmu.setOpacity?.(currentOpacity);
        } catch {
          // ignore
        }
      },
      setFontSize: (size: number | string) => {
        const next = typeof size === 'string' ? parseInt(size, 10) : size;
        if (!Number.isFinite(next)) return;
        currentSettings = { ...currentSettings, fontSize: `${next}px` };
        try {
          danmu.setFontSize?.(next, computeChannelSize(next));
        } catch {
          // ignore
        }
        try {
          danmu.setArea?.({ start: DANMU_AREA_TOP_MARGIN, end: sanitizeDanmuArea(currentSettings.area), lines: computeAreaLines(overlayHost, currentSettings) });
        } catch {
          // ignore
        }
      },
      setAllDuration: (_mode: string, duration: number) => {
        if (!Number.isFinite(duration) || duration <= 0) return;
        currentSettings = { ...currentSettings, duration };
        try {
          danmu.setAllDuration?.('scroll', duration);
          danmu.setAllDuration?.('top', duration);
          danmu.setAllDuration?.('bottom', duration);
        } catch {
          // ignore
        }
      },
      setArea: (area) => {
        const end = sanitizeDanmuArea(area?.end ?? currentSettings.area);
        currentSettings = { ...currentSettings, area: end };
        try {
          danmu.setArea?.({ start: DANMU_AREA_TOP_MARGIN, end, lines: area?.lines ?? computeAreaLines(overlayHost, currentSettings) });
        } catch {
          // ignore
        }
      },
      setPlayRate: (mode: string, rate: number) => {
        try {
          (danmu as any).setPlayRate?.(mode, rate);
        } catch {
          // ignore
        }
      },
    };

    applyDanmuOverlayPreferences(overlay, danmuSettings, isDanmuEnabled, player.root as HTMLElement);
    syncDanmuEnabledState(overlay, danmuSettings, isDanmuEnabled, player.root as HTMLElement);

    if (isDanmuEnabled) {
      ensureStarted();
    }

    return overlay;
  } catch (error) {
    console.error('[Player] Failed to initialize danmu.js overlay:', error);
    return null;
  }
};
