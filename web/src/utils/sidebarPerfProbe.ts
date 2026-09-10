// [TEMP-PERF-PROBE] 侧栏开合性能探针：诊断关注栏折叠/展开卡顿用，定位后整体移除。
// toggleSidebar 时调用 probeSidebarToggle(direction)：900ms 内采样 rAF 帧间隔与 longtask，
// 结束后落一条摘要日志（经 logger 落盘到 ~/Library/Logs/com.dtv.app/dtv.log）。
import { logger } from "./logger";

const WINDOW_MS = 900;

export function probeSidebarToggle(direction: "collapse" | "expand") {
  const t0 = performance.now();
  const deltas: number[] = [];
  const longtasks: string[] = [];
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longtasks.push(`${Math.round(e.duration)}ms@${Math.round(e.startTime - t0)}ms`);
      }
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch {
    // WebView 不支持 longtask 时静默降级，帧采样仍然有效
  }

  let last = t0;
  const tick = (t: number) => {
    deltas.push(t - last);
    last = t;
    if (t - t0 < WINDOW_MS) {
      requestAnimationFrame(tick);
      return;
    }
    obs?.disconnect();
    const median = deltas.length ? [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)] : 16.7;
    const janky = deltas.filter((d) => d > median * 1.6);
    const worst = deltas.length ? Math.max(...deltas) : 0;
    logger.info(
      `[sidebar-perf] ${direction} frames=${deltas.length} median=${median.toFixed(1)}ms janky=${janky.length} worst=${worst.toFixed(1)}ms longtasks=${longtasks.length}${longtasks.length ? ` [${longtasks.join(" ")}]` : ""}`
    );

    // 采样结束后再扫描毛玻璃元素/在播视频（一次性主线程扫描，不污染上面的帧数据）
    window.setTimeout(() => {
      let backdropCount = 0;
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el as Element);
        const bf = (cs as any).backdropFilter ?? (cs as any).webkitBackdropFilter;
        if (bf && bf !== "none") backdropCount++;
      }
      const videos = document.querySelectorAll("video");
      let playing = 0;
      for (const v of videos) {
        if (!v.paused && v.readyState >= 2) playing++;
      }
      logger.info(`[sidebar-perf] ${direction} backdrop-elements=${backdropCount} videos=${videos.length} playing=${playing}`);
    }, 60);
  };
  requestAnimationFrame(tick);
}
