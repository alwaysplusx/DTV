import type { FollowedStreamer } from "@/state/follow/FollowProvider";

/** 关注列表刷新批次完成事件：`FollowRefreshProvider`（应用级刷新引擎）派发，`useLiveNotifications` 等消费方解耦监听 */
export const FOLLOW_REFRESH_COMPLETED_EVENT = "dtv_follow_refresh_completed";

export type FollowRefreshCompletedDetail = {
  /** false（手动刷新）：只更新开播检测基线，不弹桌面通知 */
  notify: boolean;
  /** 本轮刷新后的全量主播终态（含刷新失败合并出的 UNKNOWN） */
  streamers: FollowedStreamer[];
};
