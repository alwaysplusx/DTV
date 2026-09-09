"use client";

import { invoke } from "@tauri-apps/api/core";

export type SearchPlatform = "douyu" | "huya" | "bilibili";

/** 搜索结果平台：斗鱼/虎牙/B站 支持关键词搜索；抖音仅按直播号解析 */
export type SearchAnchorPlatform = SearchPlatform | "douyin";

export type SearchAnchorResult = {
  platform: SearchAnchorPlatform;
  roomId: string;
  userName: string;
  roomTitle: string;
  avatar: string;
  liveStatus: boolean;
};

function safeString(v: unknown) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function toBool(v: unknown) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
  return false;
}

function parseDouyuSearch(raw: string): SearchAnchorResult[] {
  try {
    const json = JSON.parse(raw) as any;
    const list =
      json?.data?.relateUser ??
      json?.data?.relate_user ??
      json?.data?.relate ??
      json?.data?.relateUserList ??
      json?.data ??
      json?.relate ??
      [];
    if (!Array.isArray(list)) return [];

    return list
      .filter((item: any) => {
        // Douyu searchUser returns mixed types; type===1 is anchor user
        if (typeof item?.type === "number") return item.type === 1;
        return true;
      })
      .map((item: any) => {
        const anchorInfo = item?.anchorInfo ?? item;
        const roomId =
          safeString(anchorInfo?.rid ?? anchorInfo?.room_id ?? anchorInfo?.roomId) ||
          safeString(anchorInfo?.bkUrl ? String(anchorInfo.bkUrl).split("/").pop() : "");
        const userName = safeString(anchorInfo?.nickName ?? anchorInfo?.nickname ?? anchorInfo?.user_name ?? anchorInfo?.userName);
        const roomTitle = safeString(anchorInfo?.roomName ?? anchorInfo?.room_name ?? anchorInfo?.description ?? anchorInfo?.title);
        const avatar = safeString(anchorInfo?.avatar ?? anchorInfo?.avatar_url ?? anchorInfo?.avatarUrl);

        const isLive = Number(anchorInfo?.isLive ?? anchorInfo?.is_live ?? NaN);
        const isLoop = Number(anchorInfo?.isLoop ?? anchorInfo?.is_loop ?? NaN);
        const videoLoop = Number(anchorInfo?.videoLoop ?? anchorInfo?.video_loop ?? NaN);
        const liveStatus = isLive === 2 && isLoop !== 1 && videoLoop !== 1;

        if (!roomId || !userName) return null;
        return {
          platform: "douyu" as const,
          roomId,
          userName,
          roomTitle: roomTitle || "暂无标题",
          avatar,
          liveStatus
        };
      })
      .filter(Boolean) as SearchAnchorResult[];
  } catch {
    return [];
  }
}

export async function searchAnchors(platform: SearchPlatform, keyword: string): Promise<SearchAnchorResult[]> {
  const trimmed = (keyword || "").trim();
  if (!trimmed) return [];

  if (platform === "huya") {
    const items = await invoke<Array<{ room_id: string; avatar: string; user_name: string; live_status: boolean; title: string }>>(
      "search_huya_anchors",
      { keyword: trimmed }
    );
    return (items ?? []).map((x) => ({
      platform: "huya",
      roomId: safeString(x.room_id),
      userName: safeString(x.user_name),
      roomTitle: safeString(x.title || "暂无标题"),
      avatar: safeString(x.avatar),
      liveStatus: !!x.live_status
    }));
  }

  if (platform === "bilibili") {
    const items = await invoke<Array<{ room_id: string; title: string; avatar: string; anchor: string; is_live: boolean }>>(
      "search_bilibili_rooms",
      { keyword: trimmed }
    );
    return (items ?? []).map((x) => ({
      platform: "bilibili",
      roomId: safeString(x.room_id),
      userName: safeString(x.anchor),
      roomTitle: safeString(x.title || "暂无标题"),
      avatar: safeString(x.avatar),
      liveStatus: !!x.is_live
    }));
  }

  const raw = await invoke<string>("search_anchor", { keyword: trimmed });
  return parseDouyuSearch(raw ?? "");
}

/** 抖音无关键词搜索，仅支持按直播号/web_id 解析单个直播间 */
export async function searchDouyinRoom(keyword: string): Promise<SearchAnchorResult[]> {
  const trimmed = (keyword || "").trim();
  if (!trimmed) return [];
  // 抖音号通常是纯数字或带字母的 web_id
  const data = await invoke<{
    title?: string | null;
    anchor_name?: string | null;
    avatar?: string | null;
    status?: number | null;
    error_message?: string | null;
    web_rid?: string | null;
  }>("fetch_douyin_streamer_info", {
    payload: { args: { room_id_str: trimmed } }
  });
  if (!data || data.error_message || !data.anchor_name) {
    throw new Error("未找到该抖音号，请确认直播号是否正确");
  }
  return [
    {
      platform: "douyin",
      roomId: data.web_rid || trimmed,
      userName: data.anchor_name,
      roomTitle: data.title || "暂无标题",
      avatar: data.avatar || "",
      liveStatus: data.status === 2
    }
  ];
}

/** 平台筛选：单个平台，或 "all"（斗鱼/虎牙/B站 并行） */
export type SearchFilter = SearchPlatform | "all" | "douyin";

export const SEARCH_PLATFORM_LABELS: Array<{ id: SearchFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "douyu", label: "斗鱼" },
  { id: "huya", label: "虎牙" },
  { id: "bilibili", label: "B站" },
  { id: "douyin", label: "抖音" }
];

/**
 * 按筛选搜索：选单平台只搜该平台；选「全部」则斗鱼/虎牙/B站 并行搜索并去重。
 * 抖音无关键词搜索，仅支持按直播号/web_id 精确解析单个直播间，不参与「全部」并行。
 * 并行模式下单个平台失败不阻塞其它平台（错误静默），单平台模式原样向上抛错。
 */
export async function searchFiltered(keyword: string, filter: SearchFilter): Promise<SearchAnchorResult[]> {
  const trimmed = (keyword || "").trim();
  if (!trimmed) return [];
  if (filter === "all") {
    const platforms: SearchPlatform[] = ["douyu", "huya", "bilibili"];
    const settled = await Promise.allSettled(platforms.map((p) => searchAnchors(p, trimmed)));
    const merged: SearchAnchorResult[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled") merged.push(...(s.value ?? []));
    }
    const seen = new Set<string>();
    return merged.filter((r) => {
      const k = `${r.platform}:${r.roomId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (filter === "douyin") return searchDouyinRoom(trimmed);
  return searchAnchors(filter, trimmed);
}
