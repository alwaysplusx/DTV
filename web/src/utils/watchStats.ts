import type { WatchEvent, WatchHistory, WatchSession } from "@/types/watchStats";

export type StreamerAggregate = {
  key: string;
  platform: string;
  roomId: string;
  anchorName: string | null;
  avatar: string | null;
  totalSeconds: number;
  playingSessions: number;
  visits: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
};

export type PlatformAggregate = {
  platform: string;
  totalSeconds: number;
  playingSessions: number;
  visits: number;
};

export type DayAggregate = {
  day: string; // YYYY-MM-DD（本地）
  totalSeconds: number;
  /** 净观看时长（墙钟）：同日多直播间重叠时段只算一次 */
  netSeconds: number;
  playingSessions: number;
  visits: number;
};

export function sessionStreamerKey(s: Pick<WatchSession, "platform" | "roomId">): string {
  return `${s.platform}:${s.roomId}`;
}

function toDayString(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function aggregateByStreamer(history: WatchHistory): StreamerAggregate[] {
  const map = new Map<string, StreamerAggregate>();
  for (const s of history.sessions) {
    const key = sessionStreamerKey(s);
    const isPlaying = s.reason === "playing";
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        platform: s.platform,
        roomId: s.roomId,
        anchorName: s.anchorName,
        avatar: s.avatar,
        totalSeconds: isPlaying ? s.seconds : 0,
        playingSessions: isPlaying ? 1 : 0,
        visits: 1,
        firstSeenAt: s.beganAt,
        lastSeenAt: s.endedAt,
      });
      continue;
    }
    existing.visits += 1;
    if (isPlaying) {
      existing.totalSeconds += s.seconds;
      existing.playingSessions += 1;
    }
    if (existing.firstSeenAt == null || s.beganAt < existing.firstSeenAt) {
      existing.firstSeenAt = s.beganAt;
    }
    if (existing.lastSeenAt == null || s.endedAt > existing.lastSeenAt) {
      existing.lastSeenAt = s.endedAt;
    }
    if (s.anchorName) existing.anchorName = s.anchorName;
    if (s.avatar) existing.avatar = s.avatar;
  }
  const list = [...map.values()];
  list.sort((a, b) => b.totalSeconds - a.totalSeconds || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  return list;
}

export function aggregateByPlatform(history: WatchHistory): PlatformAggregate[] {
  const map = new Map<string, PlatformAggregate>();
  for (const s of history.sessions) {
    const isPlaying = s.reason === "playing";
    const existing = map.get(s.platform);
    if (!existing) {
      map.set(s.platform, {
        platform: s.platform,
        totalSeconds: isPlaying ? s.seconds : 0,
        playingSessions: isPlaying ? 1 : 0,
        visits: 1,
      });
      continue;
    }
    existing.visits += 1;
    if (isPlaying) {
      existing.totalSeconds += s.seconds;
      existing.playingSessions += 1;
    }
  }
  const list = [...map.values()];
  list.sort((a, b) => b.totalSeconds - a.totalSeconds);
  return list;
}

/**
 * 净观看时间（墙钟口径）：多个直播间重叠播放的时段只算一次。
 * 会话的播放区间重建为 [endedAt - seconds*1000, endedAt]，裁剪到 [from,to] 后合并求并集。
 */
function netSecondsInWindow(sessions: WatchSession[], from: number, to: number): number {
  const intervals: Array<[number, number]> = [];
  for (const s of sessions) {
    if (s.reason !== "playing" || s.seconds <= 0) continue;
    const start = Math.max(from, s.endedAt - s.seconds * 1000);
    const end = Math.min(to, s.endedAt);
    if (start < end) intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [a, b] of intervals) {
    if (a > curEnd) {
      if (curStart >= 0) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) {
      curEnd = b;
    }
  }
  if (curStart >= 0) total += curEnd - curStart;
  return Math.round(total / 1000);
}

export function aggregateByDay(history: WatchHistory): DayAggregate[] {
  const byDay = new Map<
    string,
    { totalSeconds: number; playingSessions: number; visits: number; sessions: WatchSession[] }
  >();
  for (const s of history.sessions) {
    const day = toDayString(s.beganAt);
    const isPlaying = s.reason === "playing";
    const existing = byDay.get(day);
    if (!existing) {
      byDay.set(day, {
        totalSeconds: isPlaying ? s.seconds : 0,
        playingSessions: isPlaying ? 1 : 0,
        visits: 1,
        sessions: [s]
      });
      continue;
    }
    existing.visits += 1;
    if (isPlaying) {
      existing.totalSeconds += s.seconds;
      existing.playingSessions += 1;
    }
    existing.sessions.push(s);
  }
  const list: DayAggregate[] = [];
  for (const [day, d] of byDay) {
    const [y, m, dd] = day.split("-").map(Number);
    const dayStart = new Date(y, m - 1, dd).getTime();
    list.push({
      day,
      totalSeconds: d.totalSeconds,
      netSeconds: netSecondsInWindow(d.sessions, dayStart, dayStart + 24 * 3600 * 1000),
      playingSessions: d.playingSessions,
      visits: d.visits
    });
  }
  list.sort((a, b) => (a.day < b.day ? 1 : -1));
  return list;
}

/** 4 位数字以下用 "x分"，以上用 "x小时y分"。0 → "0分"。 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/* ── P4：时间窗聚合 ─────────────────────────────────────────── */

export type TimeGranularity = "hour" | "day" | "week" | "month";

export type RangeBucket = {
  /** 毫秒（该粒度起始时间，本地） */
  bucket: number;
  totalSeconds: number;
  sessions: number;
  label: string;
};

export type RangeAggregate = {
  from: number;
  to: number;
  granularity: TimeGranularity;
  buckets: RangeBucket[];
  totalSeconds: number;
  /** 净观看时长（墙钟）：区间内多直播间重叠时段只算一次 */
  netSeconds: number;
  playingSessions: number;
  visits: number;
  byStreamer: StreamerAggregate[];
  byStreamerBucket: Map<string, StreamerAggregate[]>;
};

/** 按区间聚合（from,to 毫秒，to 为 null → 到现在） */
export function aggregateByRange(
  history: WatchHistory,
  from: number,
  to: number | null
): RangeAggregate {
  const end = to ?? Date.now();
  const granularity = resolveGranularity(end - from);
  const sessions = filterSessionsInRange(history.sessions, from, end);

  const buckets = buildBuckets(sessions, from, end, granularity);
  const byStreamer = aggregateStreamersInRange(sessions);

  // 按 bucket 内主播聚合：某时间段（点选的直条）内每位主播合并为一条
  const byStreamerBucket = new Map<string, StreamerAggregate[]>();
  const sessionsByBucketLabel = new Map<string, WatchSession[]>();
  for (const session of sessions) {
    const bucketIndex = bucketIndexFor(session.beganAt, granularity, from);
    if (bucketIndex == null) continue;
    const bucket = buckets[bucketIndex];
    byStreamerBucket.set(bucket.label, []);
    const arr = sessionsByBucketLabel.get(bucket.label) ?? [];
    arr.push(session);
    sessionsByBucketLabel.set(bucket.label, arr);
  }
  for (const [label, ses] of sessionsByBucketLabel) {
    byStreamerBucket.set(label, aggregateStreamersInRange(ses));
  }

  let totalSeconds = 0;
  let playingSessions = 0;
  let visits = 0;
  for (const s of sessions) {
    visits += 1;
    if (s.reason === "playing") {
      totalSeconds += s.seconds;
      playingSessions += 1;
    }
  }

  return {
    from,
    to: end,
    granularity,
    buckets,
    totalSeconds,
    netSeconds: netSecondsInWindow(sessions, from, end),
    playingSessions,
    visits,
    byStreamer,
    byStreamerBucket
  };
}

function filterSessionsInRange(
  sessions: WatchSession[],
  from: number,
  to: number
): WatchSession[] {
  return sessions.filter((s) => s.beganAt >= from && s.endedAt <= to);
}

function resolveGranularity(rangeMs: number): TimeGranularity {
  const oneDay = 24 * 3600 * 1000;
  if (rangeMs <= oneDay) return "hour";
  if (rangeMs <= 30 * oneDay) return "day";
  if (rangeMs <= 365 * oneDay) return "week";
  return "month";
}

function bucketIndexFor(ms: number, granularity: TimeGranularity, from: number): number | null {
  if (ms < from) return null;
  const day = 24 * 3600 * 1000;
  const week = 7 * day;
  const monthApprox = 30 * day;
  const index =
    granularity === "hour" ? Math.floor((ms - from) / 3600_000) :
    granularity === "day" ? Math.floor((ms - from) / day) :
    granularity === "week" ? Math.floor((ms - from) / week) :
    Math.floor((ms - from) / monthApprox);
  return index;
}

function buildBuckets(
  sessions: WatchSession[],
  from: number,
  to: number,
  granularity: TimeGranularity
): RangeBucket[] {
  const bucketCount = resolveGranularityCount(to - from);
  const buckets: RangeBucket[] = [];
  const day = 24 * 3600 * 1000;
  const week = 7 * day;
  const monthApprox = 30 * day;

  for (let i = 0; i < bucketCount; i++) {
    let start: number;
    let label: string;
    if (granularity === "hour") {
      start = from + i * 3600_000;
      label = `${new Date(start).getHours()}:00`;
    } else if (granularity === "day") {
      start = from + i * day;
      const d = new Date(start);
      label = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    } else if (granularity === "week") {
      start = from + i * week;
      const d = new Date(start);
      label = `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")}`;
    } else {
      start = from + i * monthApprox;
      const d = new Date(start);
      label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    buckets.push({ bucket: start, totalSeconds: 0, sessions: 0, label });
  }

  for (const s of sessions) {
    const idx = bucketIndexFor(s.beganAt, granularity, from);
    if (idx != null && buckets[idx]) {
      if (s.reason === "playing") buckets[idx].totalSeconds += s.seconds;
      buckets[idx].sessions += 1;
    }
  }

  return buckets;
}

function resolveGranularityCount(rangeMs: number): number {
  const granularity = resolveGranularity(rangeMs);
  const day = 24 * 3600 * 1000;
  const week = 7 * day;
  const monthApprox = 30 * day;
  switch (granularity) {
    case "hour": return Math.max(1, Math.ceil(rangeMs / 3600_000));
    case "day": return Math.max(1, Math.ceil(rangeMs / day));
    case "week": return Math.max(1, Math.ceil(rangeMs / week));
    default: return Math.max(1, Math.ceil(rangeMs / monthApprox));
  }
}

function aggregateStreamersInRange(sessions: WatchSession[]): StreamerAggregate[] {
  const map = new Map<string, StreamerAggregate>();
  for (const s of sessions) {
    const key = sessionStreamerKey(s);
    const isPlaying = s.reason === "playing";
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        platform: s.platform,
        roomId: s.roomId,
        anchorName: s.anchorName,
        avatar: s.avatar,
        totalSeconds: isPlaying ? s.seconds : 0,
        playingSessions: isPlaying ? 1 : 0,
        visits: 1,
        firstSeenAt: s.beganAt,
        lastSeenAt: s.endedAt,
      });
      continue;
    }
    existing.visits += 1;
    if (isPlaying) {
      existing.totalSeconds += s.seconds;
      existing.playingSessions += 1;
    }
    if (existing.firstSeenAt == null || s.beganAt < existing.firstSeenAt) {
      existing.firstSeenAt = s.beganAt;
    }
    if (existing.lastSeenAt == null || s.endedAt > existing.lastSeenAt) {
      existing.lastSeenAt = s.endedAt;
    }
    if (s.anchorName) existing.anchorName = s.anchorName;
    if (s.avatar) existing.avatar = s.avatar;
  }
  const list = [...map.values()];
  list.sort((a, b) => b.totalSeconds - a.totalSeconds || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  return list;
}

/* ── 时间窗预设（今日 / 本周 / 本月 / 自定义） ────────────── */

export type RangePreset = "today" | "week" | "month" | "custom";

export function getRangeWindow(preset: RangePreset, customFrom?: string | null, customTo?: string | null) {
  const now = Date.now();
  if (preset === "today") {
    const start = startOfDay(now);
    return { from: start, to: now };
  }
  if (preset === "week") {
    const start = startOfDay(now - 6 * 24 * 3600 * 1000);
    return { from: start, to: now };
  }
  if (preset === "month") {
    const d = new Date(now);
    const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return { from: first, to: now };
  }
  // custom
  const from = customFrom ? parseLocalDate(customFrom) : startOfDay(now - 7 * 24 * 3600 * 1000);
  const to = customTo ? endOfDay(parseLocalDate(customTo)) : now;
  return { from, to };
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function endOfDay(ms: number): number {
  return startOfDay(ms) + 24 * 3600 * 1000 - 1;
}

function parseLocalDate(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return Date.now();
  return new Date(y, m - 1, d).getTime();
}

export function findLatestLiveStartEvent(
  events: WatchEvent[],
  platform: string,
  roomId: string
): WatchEvent | null {
  let latest: WatchEvent | null = null;
  for (const e of events) {
    if (e.platform !== platform || e.roomId !== roomId) continue;
    if (e.type !== "live_start_observed") continue;
    if (!latest || e.at > latest.at) latest = e;
  }
  return latest;
}
