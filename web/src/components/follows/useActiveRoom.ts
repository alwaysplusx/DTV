"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { useMultiview } from "@/state/multiview/MultiviewProvider";
import type { Platform } from "@/state/follow/FollowProvider";

export type ActiveRoom = { platform: Platform; roomId: string };

const PLATFORM_ALIASES: Record<string, Platform | undefined> = {
  douyu: "DOUYU",
  douyin: "DOUYIN",
  huya: "HUYA",
  bilibili: "BILIBILI"
};

function normalizePlatform(raw: string | null | undefined): Platform | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return PLATFORM_ALIASES[key] ?? null;
}

function playerRouteActive(pathname: string | null): boolean {
  if (!pathname) return false;
  const trimmed = pathname.replace(/\/+$/g, "") || "/";
  return trimmed === "/player" || trimmed.startsWith("/player/");
}

export function useActiveRoom(): ActiveRoom | null {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const overlay = usePlayerOverlay();
  const multiview = useMultiview();

  // 多屏模式下没有单值"当前房间"，避免联动误导
  if (multiview.isMultiview) return null;

  // overlay 播放器盖在 /player 路由之上时，"正在播放"的是 overlay 的房间；
  // 此时路由 URL 参数只代表被覆盖的下层播放器，若优先取 URL 会高亮错位 → overlay 优先
  if (overlay.isOpen) {
    const platform = normalizePlatform(overlay.platform);
    const roomId = (overlay.roomId ?? "").trim();
    if (platform && roomId) return { platform, roomId };
  }

  if (pathname && playerRouteActive(pathname)) {
    const platform = normalizePlatform(searchParams?.get("platform") ?? null);
    const roomId = (searchParams?.get("roomId") ?? "").trim();
    if (platform && roomId) return { platform, roomId };
  }

  return null;
}
