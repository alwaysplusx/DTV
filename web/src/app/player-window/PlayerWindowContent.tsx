"use client";

import React, { useEffect } from "react";
import { useSearchParams } from "next/navigation";

import { PlayerPage } from "@/screens/PlayerPage";

/** 「独立直播间」窗口内容（/player-window/ 路由渲染，窗口本体由 Rust open_player_window_cmd 创建）。 */
export default function PlayerWindowContent() {
  const searchParams = useSearchParams();
  const platform = (searchParams.get("platform") || "douyu").toLowerCase();
  const roomId = searchParams.get("roomId") || "";

  // macOS 透明窗：body 背景让位给本容器的圆角背景（legacy-global 的 body.frameless-rounded-window）
  useEffect(() => {
    document.body.classList.add("frameless-rounded-window");
    return () => document.body.classList.remove("frameless-rounded-window");
  }, []);

  if (!roomId) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          flex: 1,
          minHeight: 0,
          background: "var(--bg-primary)",
          borderRadius: 10,
          overflow: "hidden",
          color: "var(--secondary-text)",
          fontWeight: 700
        }}
      >
        <div>
          <div style={{ fontSize: 16, marginBottom: 8 }}>未指定房间 ID</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>请从主播列表进入直播间</div>
        </div>
      </div>
    );
  }

  return (
    // 独立窗口无外壳：主窗口的高度链由 .appShell(100vh) 提供，这里需自撑满窗高；
    // 根容器自画圆角背景（透明窗四角无内容，macOS 投影随之呈圆角轮廓）
    <div
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        height: "100dvh",
        background: "var(--bg-primary)",
        borderRadius: 10,
        overflow: "hidden"
      }}
    >
      <PlayerPage platform={platform} roomId={roomId} standalone />
    </div>
  );
}
