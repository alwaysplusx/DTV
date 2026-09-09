"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCopy, Eraser, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import styles from "./LogViewerWindow.module.css";

type ParsedLine = { time: string; level: string; target: string; message: string; raw: string };
type LevelFilter = "all" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const FILTER_MIN_WEIGHT: Record<Exclude<LevelFilter, "all">, number> = { info: 2, warn: 3, error: 4 };

// tauri-plugin-log 行格式（timezone_strategy 设置后）：
// [2026-08-20][12:34:56][INFO][dtv_lib::proxy] message
const LINE_RE = /^\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\]\[(\w+)\]\[([^\]]*)\]\s?(.*)$/;

function parseLogText(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    const m = LINE_RE.exec(raw);
    if (m) {
      out.push({ time: `${m[1]} ${m[2]}`, level: m[3].toLowerCase(), target: m[4], message: m[5], raw });
    } else if (out.length > 0) {
      // 多行消息（如格式化错误堆栈）并入上一条，跟随其级别参与过滤
      const prev = out[out.length - 1];
      prev.message += `\n${raw}`;
      prev.raw += `\n${raw}`;
    } else {
      out.push({ time: "", level: "info", target: "", message: raw, raw });
    }
  }
  return out;
}

function levelClass(level: string): string {
  if (level === "error") return styles.logLevelError;
  if (level === "warn") return styles.logLevelWarn;
  if (level === "debug" || level === "trace") return styles.logLevelDebug;
  return styles.logLevelInfo;
}

/** 「运行日志」独立窗口的内容（/logs/ 路由渲染，窗口本体由 Rust open_log_window_cmd 创建）。 */
export function LogViewerWindow() {
  const [rawText, setRawText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [copied, setCopied] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  // 单飞 + 代际守卫：读盘慢不叠加 invoke；卸载/清除后丢弃在途结果
  const loadGenRef = useRef(0);
  const loadInFlightRef = useRef(false);
  const confirmTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    const gen = loadGenRef.current;
    try {
      const text = await invoke<string>("read_log_tail_cmd", { maxBytes: 262144 });
      if (gen !== loadGenRef.current) return;
      setError(null);
      setRawText(typeof text === "string" ? text : "");
    } catch (e: any) {
      if (gen !== loadGenRef.current) return;
      setError(typeof e === "string" ? e : e?.message || "读取日志失败");
    } finally {
      if (gen === loadGenRef.current) loadInFlightRef.current = false;
    }
  }, []);

  // 挂载立即读一次 + 2s 轮询（文件是唯一数据源：Rust 侧与 web 转发的日志都落在这里）
  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 2000);
    return () => {
      window.clearInterval(id);
      loadGenRef.current++;
    };
  }, [load]);

  useEffect(
    () => () => {
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    },
    []
  );

  const lines = useMemo(() => parseLogText(rawText), [rawText]);
  const filtered = useMemo(() => {
    if (filter === "all") return lines;
    const min = FILTER_MIN_WEIGHT[filter];
    return lines.filter((l) => (LEVEL_WEIGHT[l.level] ?? 2) >= min);
  }, [filter, lines]);

  // 有新内容且原本贴底时保持贴底；用户上翻查看历史则不打扰
  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered]);

  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(filtered.map((l) => l.raw).join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用（权限/非安全上下文）：给出可见反馈，下一轮成功读取后自动消失
      setError("复制失败：剪贴板不可用");
    }
  }, [filtered]);

  const onClear = useCallback(async () => {
    try {
      await invoke("clear_log_files_cmd");
      // 使清除前发起、尚未返回的读取结果作废，避免旧内容闪回
      loadGenRef.current++;
      loadInFlightRef.current = false;
      stickToBottomRef.current = true;
      await load();
    } catch (e: any) {
      setError(typeof e === "string" ? e : e?.message || "清除日志失败");
    }
  }, [load]);

  // 二次确认同关注取关风格：3 秒未确认自动复位
  const requestClear = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true);
      confirmTimerRef.current = window.setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    if (confirmTimerRef.current !== null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmClear(false);
    void onClear();
  }, [confirmClear, onClear]);

  return (
    <div className={styles.windowRoot}>
      <div className={styles.toolbar}>
        <div className={styles.filterChips} role="group" aria-label="级别过滤">
          {(
            [
              ["all", "全部"],
              ["info", "信息+"],
              ["warn", "警告+"],
              ["error", "错误"]
            ] as Array<[LevelFilter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`${styles.chip}${filter === key ? ` ${styles.chipActive}` : ""}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={styles.toolBtns}>
          <button type="button" className={styles.toolBtn} onClick={() => void load()}>
            <RefreshCw size={13} />
            刷新
          </button>
          <button type="button" className={styles.toolBtn} onClick={() => void onCopy()}>
            <ClipboardCopy size={13} />
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            className={`${styles.toolBtn}${confirmClear ? ` ${styles.toolBtnConfirm}` : ` ${styles.toolBtnDanger}`}`}
            onClick={requestClear}
          >
            <Eraser size={13} />
            {confirmClear ? "确认清除" : "清除"}
          </button>
        </div>
      </div>

      <div ref={listRef} className={styles.logList} onScroll={onListScroll}>
        {error ? (
          <span className={styles.logLevelError}>{error}</span>
        ) : filtered.length === 0 ? (
          <span className={styles.logLevelDebug}>暂无日志</span>
        ) : (
          filtered.map((l, i) => (
            <span key={i} className={styles.logLine}>
              {l.time ? <span className={styles.logTime}>{l.time}</span> : null}
              <span className={levelClass(l.level)}>{`[${l.level.toUpperCase()}]`}</span>
              {l.target ? <span className={styles.logTarget}>{`[${l.target}]`}</span> : null}
              {l.message}
            </span>
          ))
        )}
      </div>

      <div className={styles.logStatus}>
        <span>{filtered.length} 行</span>
        <span className={styles.logStatusHint}>最多显示最近 256KB · 每 2 秒自动刷新 · 单文件 5MB 滚动、保留 1 份历史</span>
      </div>
    </div>
  );
}
