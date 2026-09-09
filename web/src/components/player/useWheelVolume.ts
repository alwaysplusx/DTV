"use client";

import { useEffect, useRef, type RefObject } from "react";
import { persistStoredVolume } from "@/components/player/constants";
import { useVolumeToast } from "@/state/volumeToast/VolumeToastProvider";

/**
 * 直播画面滚轮调音量（TODO #2，类似 B 站网页行为）。
 *
 * 采用 window 捕获阶段绑定 + 命中判定：事件在捕获阶段最先到达 window，
 * 在这里根据 `containerRef.current` 判断鼠标是否悬停于播放器区域——
 * 只有悬停时才接管滚轮（调音量 + preventDefault），否则放行页面滚动。
 *
 * 之所以不用「直接绑定到容器」：MainPlayer 单屏容器在进出多屏时会整体卸载/重建，
 * effect 只跑一次会丢失监听；捕获绑定每次读 `containerRef.current` 取最新节点，
 * 天然跨重建。多屏多格场景下，各格 hook 的命中判定保证只有悬停格响应。
 *
 * 音量变化触发 xgplayer 的 `volumechange`，`VolumeControl` 插件据此自动同步
 * 滑块/百分比并持久化，这里无需重复写 UI 更新。同时通过 VolumeToastProvider
 * 在屏幕中央弹一个半透明音量条 toast，避免窗口小时底部音量条被遮挡而看不见。
 *
 * @param containerRef 播放器容器（悬停命中判定；多屏传格根节点，单屏传视频容器）
 * @param playerRef    xgplayer 实例（惰性读取，mount 后才可用）
 * @param opts
 *   - step：每"物理滚轮一格"（≈deltaY 100）的音量步长（0~1），默认 0.05。
 *     实际步长 = step × (|deltaY|/100)，clamp 到 0.25×~3× —— 慢速精细滚动更细
 *     （deltaY≈±20 时约 1%），正常滚一格 5%，快速甩动最多 15%。
 *   - keepMuted：true 时音量>0 也不取消静音（多屏非焦点格：策略性静音，
 *     仍调音量并让 UI 反映数值，尊重"仅一格有声"的音频策略）。
 *   - showToast：是否弹全局音量条 toast。默认 true；
 *     keepMuted 场景下应传 false，避免在非焦点格静默策略下误导用户。
 */
export function useWheelVolume(
  containerRef: RefObject<HTMLElement | null>,
  playerRef: RefObject<any>,
  opts?: { step?: number; keepMuted?: boolean; showToast?: boolean }
) {
  const keepMutedRef = useRef(!!opts?.keepMuted);
  keepMutedRef.current = !!opts?.keepMuted;
  const showToastRef = useRef(opts?.showToast !== false);
  showToastRef.current = opts?.showToast !== false;

  const toast = useVolumeToast();

  useEffect(() => {
    // 基准步长：一个物理滚轮档位（≈deltaY 100）的调幅，默认 5%
    const baseStep = Math.min(0.2, Math.max(0.01, opts?.step ?? 0.05));

    const onWheel = (e: WheelEvent) => {
      const root = containerRef.current;
      if (!root) return;
      if (!(e.target instanceof Node) || !root.contains(e.target)) return;

      const player = playerRef.current;
      if (!player) return;
      if (typeof player.volume !== "number") return;

      // deltaMode 1 = 行（Firefox），其他像素。方向：上滚 + 下滚 -
      const rawDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const dir = Math.sign(rawDelta);
      if (dir === 0) return;

      // 按实际滚动量缩放步长：物理滚轮一格≈±100；触控板/平滑滚轮产生小 delta 事件
      // （慢滚更细），快甩大 delta 调得更多。clamp 防抖动误触与跳变。
      const detents = Math.max(0.25, Math.min(3, Math.abs(rawDelta) / 100));

      const next = Math.min(1, Math.max(0, player.volume - dir * baseStep * detents));
      if (next === player.volume) return;

      if (next > 0 && !keepMutedRef.current) {
        player.muted = false;
      }
      player.volume = next;
      // 四舍五入到百分位，避免浮点残留写入 localStorage
      persistStoredVolume(Math.round(next * 100) / 100);
      if (showToastRef.current) {
        toast.show(next, !!player.muted);
      }
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch {
        // ignore
      }
    };

    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onWheel, { capture: true } as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);
}

