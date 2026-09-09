"use client";

import React from "react";
import { LayoutGrid } from "lucide-react";

/**
 * 直播平台官方图标（图片资源位于 web/public/platforms/）。
 * - douyu / huya / bilibili：各平台官网 favicon 转制的 PNG（统一尺寸、透明背景）
 * - all：无"官方全部"图标，用 LayoutGrid（网格）语义替身
 * - 其它（douyin 等）：无官方图，渲染占位色块
 */
const PLATFORM_IMG: Record<string, string> = {
  douyu: "/platforms/douyu.png",
  huya: "/platforms/huya.png",
  bilibili: "/platforms/bili.png",
  douyin: "/platforms/douyin.png"
};

export function PlatformIcon({
  platform,
  size = 16,
  className
}: {
  platform: "all" | "douyu" | "huya" | "bilibili" | string;
  size?: number;
  className?: string;
}) {
  if (platform === "all") {
    return <LayoutGrid size={size} strokeWidth={2.2} className={className} aria-hidden />;
  }
  const src = PLATFORM_IMG[String(platform || "").toLowerCase()];
  if (!src) {
    return <span className={className} style={{ width: size, height: size }} aria-hidden />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} width={size} height={size} alt="" className={className} style={{ borderRadius: "20%" }} />;
}
