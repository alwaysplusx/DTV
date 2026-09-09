export type WatchSessionReason = "playing" | "offline_visit";

export type WatchSession = {
  platform: string;
  roomId: string;
  anchorName: string | null;
  title: string | null;
  avatar: string | null;
  beganAt: number;
  endedAt: number;
  seconds: number;
  reason: WatchSessionReason;
  multiviewSlot: number | null;
};

export type WatchEventType = "live_start_observed";

export type WatchEvent = {
  platform: string;
  roomId: string;
  anchorName: string | null;
  type: WatchEventType;
  at: number;
  approx: boolean;
};

export type WatchHistory = {
  version: number;
  sessions: WatchSession[];
  events: WatchEvent[];
};
