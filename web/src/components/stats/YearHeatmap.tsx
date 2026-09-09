"use client";

import React, { useMemo, useState } from "react";

import type { WatchHistory } from "@/types/watchStats";
import { aggregateByDay, formatDuration } from "@/utils/watchStats";

import styles from "./YearHeatmap.module.css";

const WEEKS = 53;
const DAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

type DayInfo = {
  key: string;
  seconds: number;
  netSeconds: number;
  visits: number;
  level: number;
};

function toDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function levelFor(seconds: number, max: number): number {
  if (seconds <= 0) return 0;
  if (seconds >= max * 0.7) return 4;
  if (seconds >= max * 0.4) return 3;
  if (seconds >= max * 0.2) return 2;
  return 1;
}

/** GitHub 风格近 365 天观看强度热力图（周一为一周起点）。bare=true 去掉自带卡片底，供嵌套进外层卡片。 */
export function YearHeatmap({ history, bare = false }: { history: WatchHistory; bare?: boolean }) {
  const [tip, setTip] = useState<{ x: number; y: number; title: string; text: string } | null>(null);

  const { weeks, months } = useMemo(() => {
    const byDay = new Map<string, { seconds: number; netSeconds: number; visits: number }>();
    for (const a of aggregateByDay(history))
      byDay.set(a.day, { seconds: a.totalSeconds, netSeconds: a.netSeconds, visits: a.visits });
    const max = Math.max(1, ...[...byDay.values()].map((v) => v.seconds));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // 终点为今天，起点回退 364 天后对齐到所在周的周一
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 364);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

    const weeks: DayInfo[][] = [];
    const months: { col: number; label: string }[] = [];
    const day = new Date(start);
    let prevMonth = -1;
    for (let w = 0; w < WEEKS; w++) {
      const week: DayInfo[] = [];
      for (let d = 0; d < 7; d++) {
        const month = day.getMonth();
        if (month !== prevMonth) {
          // 该月第一天落在哪一列，就在哪列顶上标月名（GitHub 同款）
          if (day.getDate() === 1) months.push({ col: w, label: `${month + 1}月` });
          prevMonth = month;
        }
        const key = toDayKey(day);
        const data = byDay.get(key);
        const seconds = data?.seconds ?? 0;
        week.push({
          key,
          seconds,
          netSeconds: data?.netSeconds ?? 0,
          visits: data?.visits ?? 0,
          level: levelFor(seconds, max)
        });
        day.setDate(day.getDate() + 1);
      }
      weeks.push(week);
    }
    return { weeks, months };
  }, [history]);

  const monthAt = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of months) map.set(m.col, m.label);
    return map;
  }, [months]);

  return (
    <div className={bare ? styles.bare : styles.panel}>
      <div className={styles.monthRow}>
        <span className={styles.gutter} />
        {weeks.map((_, wi) => (
          <span key={wi} className={styles.monthLabel}>
            {monthAt.get(wi) ?? ""}
          </span>
        ))}
      </div>

      <div className={styles.grid}>
        <div className={styles.dayGutter}>
          {DAY_LABELS.map((label, i) =>
            i === 0 || i === 2 || i === 4 ? (
              <span key={i} className={styles.dayLabel}>
                {label}
              </span>
            ) : (
              <span key={i} className={styles.daySpacer} />
            )
          )}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} className={styles.week}>
            {week.map((d) => {
              // 净时间只在多直播间重叠（净 < 累计）时才有信息量，附在括号里
              const netSuffix = d.netSeconds > 0 && d.netSeconds < d.seconds
                ? `（净 ${formatDuration(d.netSeconds)}）`
                : "";
              const desc = d.seconds > 0
                ? `观看 ${formatDuration(d.seconds)}${netSuffix} · ${d.visits} 次`
                : "无观看";
              return (
                <div
                  key={d.key}
                  role="img"
                  aria-label={`${d.key} · ${desc}`}
                  className={styles.cell}
                  data-level={d.level}
                  onMouseEnter={(e) =>
                    setTip({
                      x: e.clientX,
                      y: e.clientY,
                      title: d.key,
                      text: desc
                    })
                  }
                  onMouseMove={(e) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}
                  onMouseLeave={() => setTip(null)}
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className={styles.legend}>
        <span className={styles.legendLabel}>少</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={styles.cell} data-level={l} />
        ))}
        <span className={styles.legendLabel}>多</span>
      </div>

      {tip ? (
        <div className={styles.tooltip} style={{ left: tip.x + 12, top: tip.y + 12 }}>
          <div className={styles.tooltipTitle}>{tip.title}</div>
          <div className={styles.tooltipText}>{tip.text}</div>
        </div>
      ) : null}
    </div>
  );
}
