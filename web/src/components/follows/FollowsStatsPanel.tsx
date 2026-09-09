"use client";

import { useCallback, useMemo } from "react";
import { BarChart3, Clock, Flame, Users } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import styles from "./FollowsStatsPanel.module.css";
import { useWatchHistory } from "@/state/watchHistory/WatchHistoryProvider";
import { YearHeatmap } from "@/components/stats/YearHeatmap";
import { aggregateByRange, formatDuration, getRangeWindow } from "@/utils/watchStats";

/** 关注页顶部观时摘要：4 张 7 天维度卡片 + 365 天热力图
 *  4 张卡语义同独立统计页 .summaryGrid（累计/净/看过/最长），保持观感一致 */
export function FollowsStatsPanel() {
  const { history } = useWatchHistory();

  const week = useMemo(() => {
    const { from, to } = getRangeWindow("week");
    return aggregateByRange(history, from, to);
  }, [history]);

  const openStatsWindow = useCallback(() => {
    void invoke("open_stats_window_cmd", {}).catch(() => {});
  }, []);

  const top = week.byStreamer[0];

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.headTitle}>
          <BarChart3 size={15} />
          观时统计 · 近 7 天
        </div>
        <button type="button" className={styles.openBtn} onClick={openStatsWindow} title="打开完整观看统计窗口">
          完整统计
        </button>
      </div>

      <div className={styles.body}>
        <div className={styles.summaryGrid}>
          <div className={styles.summaryCard}>
            <div className={styles.summaryIcon}><Clock size={16} /></div>
            <div className={styles.summaryMeta}>
              <div className={styles.summaryLabel}>累计观看时长</div>
              <div className={styles.summaryValue}>{formatDuration(week.totalSeconds)}</div>
            </div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryIcon}><BarChart3 size={16} /></div>
            <div className={styles.summaryMeta}>
              <div className={styles.summaryLabel}>净观看时长</div>
              <div className={styles.summaryValue}>{formatDuration(week.netSeconds)}</div>
            </div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryIcon}><Users size={16} /></div>
            <div className={styles.summaryMeta}>
              <div className={styles.summaryLabel}>看过主播</div>
              <div className={styles.summaryValue}>{week.byStreamer.length} 位</div>
            </div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryIcon}><Flame size={16} /></div>
            <div className={styles.summaryMeta}>
              <div className={styles.summaryLabel}>最长主播</div>
              <div className={styles.summaryValue} title={top?.anchorName ?? ""}>
                {top?.anchorName ?? "—"}
              </div>
            </div>
          </div>
        </div>

        <div className={styles.heatmapWrap}>
          <YearHeatmap history={history} bare />
        </div>
      </div>
    </div>
  );
}
