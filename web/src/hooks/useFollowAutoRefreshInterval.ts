"use client";

const STORAGE_KEY = "dtv_follow_autorefresh_interval_ms";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const CHANGED_EVENT = "dtv_follow_autorefresh_interval_changed";

export const FOLLOW_AUTOREFRESH_MIN_MS = 0;
export const FOLLOW_AUTOREFRESH_MAX_MS = 60 * 60 * 1000;
export const FOLLOW_AUTOREFRESH_DEFAULT_MS = DEFAULT_INTERVAL_MS;

export function getFollowAutoRefreshIntervalMs(): number {
  if (typeof window === "undefined") return DEFAULT_INTERVAL_MS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_INTERVAL_MS;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return DEFAULT_INTERVAL_MS;
    return v;
  } catch {
    return DEFAULT_INTERVAL_MS;
  }
}

export function setFollowAutoRefreshIntervalMs(ms: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(ms));
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: ms }));
  } catch {
    // ignore
  }
}

export function msToMinutes(ms: number): number {
  return Math.round(ms / 60000);
}

export function minutesToMs(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes < 0) return 0;
  return Math.round(minutes) * 60000;
}

export function formatFollowAutoRefreshInterval(ms: number): string {
  if (ms <= 0) return "关闭";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return `${hours} 小时`;
}
