"use client";

import React from "react";
import { usePathname } from "next/navigation";

import { ThemeProvider } from "@/state/theme/ThemeProvider";
import { FollowProvider } from "@/state/follow/FollowProvider";
import { CustomCategoriesProvider } from "@/state/customCategories/CustomCategoriesProvider";
import { PlayerUiProvider } from "@/state/playerUi/PlayerUiProvider";
import { MultiviewProvider } from "@/state/multiview/MultiviewProvider";
import { VolumeToastProvider } from "@/state/volumeToast/VolumeToastProvider";
import { WatchHistoryProvider } from "@/state/watchHistory/WatchHistoryProvider";
import { MainWindowCloseGuard } from "@/components/shell/MainWindowCloseGuard";
import { VolumeToastHost } from "@/components/player/VolumeToast";

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // 「运行日志」独立窗口页面：只挂主题（CSS 变量 + 窗口主题），
  // 不带关注/播放器等主窗口状态
  if (pathname?.startsWith("/logs")) {
    return <ThemeProvider>{children}</ThemeProvider>;
  }

  // 「观看统计」独立窗口页面：主题 + 观看历史；点主播行经 Rust 转主窗口打开播放，
  // 不依赖 PlayerOverlay（该 Provider 只挂主窗口外壳）
  if (pathname?.startsWith("/stats")) {
    return <ThemeProvider><WatchHistoryProvider>{children}</WatchHistoryProvider></ThemeProvider>;
  }

  // 「独立直播间」窗口页面：无主窗口外壳，但播放器需要关注/播放器 UI/
  // 多屏/音量 toast 这些上下文；各窗口实例状态天然隔离
  if (pathname?.startsWith("/player-window")) {
    return (
      <ThemeProvider>
        <FollowProvider>
          <PlayerUiProvider>
            <MultiviewProvider>
              <WatchHistoryProvider>
                <VolumeToastProvider>
                  {children}
                  <VolumeToastHost />
                </VolumeToastProvider>
              </WatchHistoryProvider>
            </MultiviewProvider>
          </PlayerUiProvider>
        </FollowProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <FollowProvider>
        <PlayerUiProvider>
          <CustomCategoriesProvider>
            <WatchHistoryProvider>
              <MainWindowCloseGuard />
              {children}
            </WatchHistoryProvider>
          </CustomCategoriesProvider>
        </PlayerUiProvider>
      </FollowProvider>
    </ThemeProvider>
  );
}
