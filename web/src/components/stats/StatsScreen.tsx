"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BarChart3, Clock, Flame, RefreshCw, Users } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import styles from "./StatsScreen.module.css";
import { PlatformIcon } from "@/components/common/PlatformIcon";
import { useImageProxy } from "@/hooks/useImageProxy";
import { useWatchHistory } from "@/state/watchHistory/WatchHistoryProvider";
import { YearHeatmap } from "@/components/stats/YearHeatmap";
import type { WatchHistory } from "@/types/watchStats";
import {
  aggregateByRange,
  findLatestLiveStartEvent,
  formatDuration,
  getRangeWindow,
  type RangePreset,
  type RangeAggregate,
  type StreamerAggregate,
  type RangeBucket
} from "@/utils/watchStats";

function normalizeStreamerParam(raw: string | null): { platform: string; roomId: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  return { platform: raw.slice(0, idx).toUpperCase(), roomId: raw.slice(idx + 1) };
}

function SummaryCard({
  icon,
  label,
  value,
  hint
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className={styles.summaryCard}>
      <div className={styles.summaryIcon}>{icon}</div>
      <div className={styles.summaryMeta}>
        <div className={styles.summaryLabel}>{label}</div>
        <div className={styles.summaryValue}>{value}</div>
        {hint ? <div className={styles.summaryHint}>{hint}</div> : null}
      </div>
    </div>
  );
}

function StreamerRow({
  aggregate,
  rank,
  onOpen
}: {
  aggregate: StreamerAggregate;
  rank: number;
  onOpen: () => void;
}) {
  const { getAvatarSrc } = useImageProxy();
  const avatar = aggregate.avatar ? getAvatarSrc(aggregate.platform.toLowerCase(), aggregate.avatar) : null;
  return (
    <button type="button" className={styles.streamerRow} onClick={onOpen}>
      <span className={styles.streamerRowRank}>{rank}</span>
      {avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.streamerRowAvatar} src={avatar} alt="" />
      ) : (
        <div className={styles.streamerRowAvatarFallback}>{(aggregate.anchorName || aggregate.roomId).slice(0, 1).toUpperCase()}</div>
      )}
      <span className={styles.streamerRowMeta}>
        <span className={styles.streamerRowName}>
          <PlatformIcon platform={aggregate.platform.toLowerCase()} size={13} />
          {aggregate.anchorName || aggregate.roomId}
        </span>
        <span className={styles.streamerRowSub}>播放 {aggregate.playingSessions} 次 · 访问 {aggregate.visits} 次</span>
      </span>
      <span className={styles.streamerRowDuration}>{formatDuration(aggregate.totalSeconds)}</span>
    </button>
  );
}

function BarChart({
  buckets,
  selectedLabel,
  onSelect
}: {
  buckets: RangeBucket[];
  selectedLabel: string | null;
  onSelect: (label: string | null) => void;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.totalSeconds));
  if (buckets.length === 0) return <div className={styles.emptyText}>该时段没有数据</div>;
  return (
    <div className={styles.barChart}>
      {buckets.map((b) => {
        const percent = (b.totalSeconds / max) * 100;
        const isSelected = selectedLabel === b.label;
        return (
          <button
            key={b.label}
            type="button"
            className={`${styles.barItem}${isSelected ? ` ${styles.barItemSelected}` : ""}`}
            onClick={() => onSelect(isSelected ? null : b.label)}
            title={`${b.label} · ${formatDuration(b.totalSeconds)} · 共 ${b.sessions} 次`}
          >
            <div className={styles.barItemTrack}>
              <div
                className={`${styles.barItemFill}${b.totalSeconds > 0 ? "" : ` ${styles.barItemFillEmpty}`}`}
                style={{ height: `${b.totalSeconds > 0 ? Math.max(2, percent) : 0}%` }}
              />
            </div>
            <span className={styles.barItemLabel}>{b.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function RangeStats({ aggregate, onOpenStreamer }: { aggregate: RangeAggregate; onOpenStreamer: (a: StreamerAggregate) => void }) {
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);

  const handleSelect = useCallback((label: string | null) => {
    setSelectedBucket(label);
  }, []);

  const source = selectedBucket ? aggregate.byStreamerBucket.get(selectedBucket) ?? [] : aggregate.byStreamer;

  return (
    <div className={styles.rangeRoot}>
      <div className={styles.rangeHead}>
        <div className={styles.rangeTitle}>
          {selectedBucket ? `该时段 · ${selectedBucket} 的主播排行` : "该时段主播排行"}
          {selectedBucket ? (
            <button type="button" className={styles.rangeHeadReset} onClick={() => handleSelect(null)}>
              清除
            </button>
          ) : null}
        </div>
        <div className={styles.rangeTotal}>
          {formatDuration(aggregate.totalSeconds)} · 播放 {aggregate.playingSessions} 次 · 访问 {aggregate.visits} 次
        </div>
      </div>

      <BarChart buckets={aggregate.buckets} selectedLabel={selectedBucket} onSelect={handleSelect} />

      <div className={styles.streamerList}>
        {source.length === 0 ? (
          <div className={styles.emptyText}>{selectedBucket ? "该时段没有看过任何主播" : "还没有观看数据"}</div>
        ) : (
          source.map((a, idx) => (
            <StreamerRow
              key={a.key}
              aggregate={a}
              rank={idx + 1}
              onOpen={() => onOpenStreamer(a)}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function StatsScreen() {
  const searchParams = useSearchParams();
  const streamerParam = useMemo(() => normalizeStreamerParam(searchParams.get("streamer")), [searchParams]);
  const { history, hydrated, refresh } = useWatchHistory();

  // 统计窗是独立进程：主窗口产生的会话不会推到这里，切回前台时重读磁盘，
  // 避免一直停留在打开窗口那一刻的快照
  useEffect(() => {
    const onFocus = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  // 独立统计窗口：点主播行经 Rust 前置主窗口并在其打开播放 overlay
  const openStreamerPlayer = useCallback((a: { platform: string; roomId: string }) => {
    void invoke("open_player_in_main_cmd", { platform: a.platform.toLowerCase(), roomId: a.roomId }).catch(() => {});
  }, []);

  const [preset, setPreset] = useState<RangePreset>("today");
  const [customFrom, setCustomFrom] = useState<string | null>(null);
  const [customTo, setCustomTo] = useState<string | null>(null);

  const range = useMemo(
    () => getRangeWindow(preset, customFrom, customTo),
    [preset, customFrom, customTo]
  );

  const aggregate = useMemo(() => aggregateByRange(history, range.from, range.to), [history, range]);

  const focusedStreamer = useMemo(() => {
    if (!streamerParam) return null;
    return aggregate.byStreamer.find(
      (a) => a.platform.toUpperCase() === streamerParam.platform && a.roomId === streamerParam.roomId
    ) ?? null;
  }, [aggregate, streamerParam]);

  const focusedLatestEvent = useMemo(() => {
    if (!streamerParam) return null;
    return findLatestLiveStartEvent(history.events, streamerParam.platform, streamerParam.roomId);
  }, [history.events, streamerParam]);

  const PRESET_LABELS: { id: RangePreset; label: string }[] = [
    { id: "today", label: "今日" },
    { id: "week", label: "近7日" },
    { id: "month", label: "本月" },
    { id: "custom", label: "自定义" }
  ];

  if (!hydrated && history.sessions.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.emptyState}>
          <BarChart3 size={32} />
          <div className={styles.emptyTitle}>暂无观看数据</div>
          <div className={styles.emptyText}>看完直播后这里会按主播/平台/日记录你的观看时长。</div>
        </div>
      </div>
    );
  }

  if (focusedStreamer) {
    return (
      <div className={styles.root}>
        <StreamerHeader aggregate={focusedStreamer} latestEvent={focusedLatestEvent} />
        <div className={styles.section}>
          <div className={styles.sectionTitle}>近 14 天观看分布</div>
          <RangeStats aggregate={aggregate} onOpenStreamer={openStreamerPlayer} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.heatSection}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitle}>近365天观看强度</div>
          <button
            type="button"
            className={`${styles.refreshBtn}${refreshing ? ` ${styles.refreshSpin}` : ""}`}
            onClick={() => void handleRefresh()}
            title="刷新观看数据"
            aria-label="刷新观看数据"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <YearHeatmap history={history} />
      </div>

      <div className={styles.presetTabs}>
        {PRESET_LABELS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`${styles.presetTab}${preset === p.id ? ` ${styles.presetTabActive}` : ""}`}
            onClick={() => setPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {preset === "custom" ? (
        <div className={styles.customRange}>
          <label className={styles.customRangeLabel}>
            开始日
            <input
              type="date"
              className={styles.customRangeInput}
              value={customFrom ?? ""}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
          </label>
          <label className={styles.customRangeLabel}>
            结束日
            <input
              type="date"
              className={styles.customRangeInput}
              value={customTo ?? ""}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </label>
        </div>
      ) : null}

      <div className={styles.summaryGrid}>
        <SummaryCard icon={<Clock size={18} />} label="累计观看时长" value={formatDuration(aggregate.totalSeconds)} />
        <SummaryCard
          icon={<BarChart3 size={18} />}
          label="净观看时长"
          value={formatDuration(aggregate.netSeconds)}
          hint="重叠时段只计一次"
        />
        <SummaryCard
          icon={<Users size={18} />}
          label="看过主播"
          value={`${aggregate.byStreamer.length} 位`}
          hint={`播放 ${aggregate.playingSessions} 次 / 访问 ${aggregate.visits} 次`}
        />
        <SummaryCard
          icon={<Flame size={18} />}
          label="最长主播"
          value={aggregate.byStreamer[0]?.anchorName ?? "—"}
        />
      </div>

      <RangeStats aggregate={aggregate} onOpenStreamer={openStreamerPlayer} />
    </div>
  );
}

function StreamerHeader({ aggregate, latestEvent }: { aggregate: StreamerAggregate; latestEvent: { at: number; approx: boolean } | null }) {
  const { getAvatarSrc } = useImageProxy();
  const avatar = aggregate.avatar ? getAvatarSrc(aggregate.platform.toLowerCase(), aggregate.avatar) : null;
  const name = aggregate.anchorName || aggregate.roomId;
  return (
    <div className={styles.streamerHeader}>
      {avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.streamerAvatar} src={avatar} alt={name} />
      ) : (
        <div className={styles.streamerAvatarFallback}>{name.slice(0, 1).toUpperCase()}</div>
      )}
      <div className={styles.streamerHeaderMeta}>
        <div className={styles.streamerName}>
          <PlatformIcon platform={aggregate.platform.toLowerCase()} size={15} />
          {name}
        </div>
        <div className={styles.streamerHeaderSub}>
          房间 {aggregate.roomId} · 共 {formatDuration(aggregate.totalSeconds)} · {aggregate.playingSessions} 次播放
        </div>
      </div>
      {latestEvent ? (
        <div className={styles.latestLiveHint}>
          最近开播 {latestEvent.approx ? "约" : ""}
          {new Date(latestEvent.at).toLocaleString("zh-CN", { hour12: false })}
        </div>
      ) : null}
    </div>
  );
}
