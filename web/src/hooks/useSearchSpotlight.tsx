"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { createPortal } from "react-dom";
import { Search, Users, X } from "lucide-react";

import styles from "@/components/shell/Navbar.module.css";
import { searchAnchors, searchFiltered, SEARCH_PLATFORM_LABELS, type SearchAnchorResult, type SearchFilter, type SearchPlatform } from "@/services/search";
import { PlatformIcon } from "@/components/common/PlatformIcon";
import { useImageProxy } from "@/hooks/useImageProxy";
import { useFollow, type Platform as FollowPlatform } from "@/state/follow/FollowProvider";

/** spotlight 筛选：平台 chips + 本地「关注」tab（后者不走网络，本地过滤关注列表） */
type SpotlightFilter = SearchFilter | "follows";

const SPOTLIGHT_FILTERS: Array<{ id: SpotlightFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "follows", label: "关注" },
  ...SEARCH_PLATFORM_LABELS.filter((f) => f.id !== "all")
];

/** FollowProvider 大写平台枚举 → 搜索结果的小写平台串 */
const FOLLOW_PLATFORM_TO_SEARCH: Record<FollowPlatform, SearchAnchorResult["platform"]> = {
  DOUYU: "douyu",
  DOUYIN: "douyin",
  HUYA: "huya",
  BILIBILI: "bilibili"
};

/** Spotlight 打开策略：调用方决定何时调用 open()/close()；hook 只管状态与浮层。 */
export interface SearchSpotlightOptions {
  /** 当前路由对应的"具体平台"（用于"内联模式"自动单平台搜索 + 数字回车回退）。
      传 null/false 关闭内联模式（MainPlayer / 独立窗 走 spotlight 即可）。 */
  inlinePlatform: SearchPlatform | null | false;
  /** 当前活跃的平台 id（用于 placeholder 与数字回车回退），可与 inlinePlatform 不同。 */
  activePlatformLabel: "douyu" | "douyin" | "huya" | "bilibili" | "custom" | "follows" | "any";
  /** 点击结果"在主壳播放器打开"；/player-window 没 Provider 时可不传，hook 会改走 standalone。 */
  onSelectInMain?: (platform: string, roomId: string) => void;
  /** 点击结果"另开独立窗"；不传则禁用此入口。 */
  onSelectInStandalone?: (platform: string, roomId: string) => void;
  /** 点击结果"在当前独立窗切换房间"；不传则禁用此入口。 */
  onSelectInPlace?: (platform: string, roomId: string) => void;
}

export function useSearchSpotlight(opts: SearchSpotlightOptions) {
  const { inlinePlatform, activePlatformLabel, onSelectInMain, onSelectInStandalone, onSelectInPlace } = opts;
  const { ensureProxyStarted, proxify } = useImageProxy();
  const follow = useFollow();

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchAnchorResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isLoadingSearch, setIsLoadingSearch] = useState(false);
  const [searchFilter, setSearchFilter] = useState<SpotlightFilter>("all");
  const [searchSpotlightOpen, setSearchSpotlightOpen] = useState(false);
  // 弹出/收回动画的锚点：触发 spotlight 的那个搜索框/按钮元素
  const [spotlightAnchor, setSpotlightAnchor] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const open = useCallback((anchor?: HTMLElement | null) => {
    setSpotlightAnchor(anchor ?? null);
    setSearchFilter("all");
    setSearchSpotlightOpen(true);
  }, []);
  const close = useCallback(() => {
    setSearchSpotlightOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);
    setIsLoadingSearch(false);
  }, []);

  const searchPlatform: SearchPlatform | null = useMemo(() => {
    if (inlinePlatform === false || inlinePlatform == null) return null;
    return inlinePlatform;
  }, [inlinePlatform]);

  // 本地关注列表匹配（昵称/房间号/标题），「关注」tab 与「全部」合并展示共用；
  // 空串匹配全部（includes("") 恒真），即 spotlight 默认列表。LIVE 优先排
  const filterFollowedResults = useCallback(
    (trimmed: string): SearchAnchorResult[] => {
      const q = trimmed.toLowerCase();
      return follow.followedStreamers
        .filter((s) => {
          const nickname = (s.nickname || "").toLowerCase();
          const roomId = s.currentRoomId || s.id || "";
          const title = (s.roomTitle || "").toLowerCase();
          return nickname.includes(q) || roomId.includes(trimmed) || title.includes(q);
        })
        .map((s): SearchAnchorResult => ({
          platform: FOLLOW_PLATFORM_TO_SEARCH[s.platform],
          roomId: s.currentRoomId || s.id,
          userName: s.nickname,
          roomTitle: s.roomTitle ?? "",
          liveStatus: s.liveStatus === "LIVE",
          avatar: s.avatarUrl
        }))
        .sort((a, b) => Number(b.liveStatus) - Number(a.liveStatus));
    },
    [follow.followedStreamers]
  );

  // 搜索 effect：spotlight 模式按筛选 chip；内联模式按当前平台单平台
  useEffect(() => {
    const trimmed = searchQuery.trim();
    setSearchError(null);
    if (!trimmed) {
      // spotlight 打开（全部/关注 tab）空查询时默认展示关注列表，输入后再过滤
      if (searchSpotlightOpen && (searchFilter === "all" || searchFilter === "follows")) {
        setSearchResults(filterFollowedResults(""));
      } else {
        setSearchResults([]);
      }
      setIsLoadingSearch(false);
      return;
    }
    // 「关注」tab：本地过滤关注列表，不发请求
    if (searchSpotlightOpen && searchFilter === "follows") {
      setSearchResults(filterFollowedResults(trimmed));
      setIsLoadingSearch(false);
      return;
    }
    if (!searchSpotlightOpen) {
      if (!searchPlatform) {
        setSearchResults([]);
        setIsLoadingSearch(false);
        return;
      }
      setIsLoadingSearch(true);
      const id = window.setTimeout(() => {
        searchAnchors(searchPlatform, trimmed)
          .then((res) => setSearchResults(res ?? []))
          .catch((e: any) => {
            setSearchResults([]);
            setSearchError(typeof e === "string" ? e : e?.message || "搜索失败");
          })
          .finally(() => setIsLoadingSearch(false));
      }, 220);
      return () => window.clearTimeout(id);
    }
    // spotlight 平台筛选（TS：此处 searchFilter 已排除 "follows"）
    const filter: SearchFilter = searchFilter === "follows" ? "all" : searchFilter;
    setIsLoadingSearch(true);
    const id = window.setTimeout(() => {
      searchFiltered(trimmed, filter)
        .then((res) => {
          const network = res ?? [];
          if (filter !== "all") {
            setSearchResults(network);
            return;
          }
          // 「全部」：关注列表匹配排前面，与网络结果按 platform:roomId 去重
          const followed = filterFollowedResults(trimmed);
          const seen = new Set(followed.map((r) => `${r.platform}:${r.roomId}`));
          setSearchResults([...followed, ...network.filter((r) => !seen.has(`${r.platform}:${r.roomId}`))]);
        })
        .catch((e: any) => {
          setSearchResults([]);
          setSearchError(typeof e === "string" ? e : e?.message || "搜索失败");
        })
        .finally(() => setIsLoadingSearch(false));
    }, 220);

    return () => window.clearTimeout(id);
  }, [filterFollowedResults, searchPlatform, searchQuery, searchSpotlightOpen, searchFilter]);

  useEffect(() => {
    if (searchPlatform === "bilibili" || searchPlatform === "huya") {
      void ensureProxyStarted();
    }
  }, [ensureProxyStarted, searchPlatform]);

  // 数字回车直达房间：spotlight 模式下优先用 chip；否则用内联平台
  const resolveNumericPlatform = useCallback((): string | null => {
    if (searchSpotlightOpen && searchFilter !== "all" && searchFilter !== "follows") return searchFilter;
    if (searchPlatform) return searchPlatform;
    return null;
  }, [searchFilter, searchPlatform, searchSpotlightOpen]);

  const submitNumericRoom = useCallback(
    (action: (platform: string, roomId: string) => void) => {
      const trimmed = searchQuery.trim();
      if (!trimmed || !/^\d+$/.test(trimmed)) return;
      const platform = resolveNumericPlatform();
      if (platform) {
        action(platform, trimmed);
        close();
      }
    },
    [close, resolveNumericPlatform, searchQuery]
  );

  const placeholderText = useMemo(() => {
    if (searchSpotlightOpen) {
      if (searchFilter === "follows") return "搜索关注的主播...";
      if (searchFilter === "douyin") return "输入抖音直播号...";
      if (searchFilter === "douyu") return "搜索斗鱼主播/房间...";
      if (searchFilter === "huya") return "搜索虎牙主播/房间...";
      if (searchFilter === "bilibili") return "搜索B站直播间...";
      return "搜索全部平台主播 / 直播间...";
    }
    if (activePlatformLabel === "huya") return "搜索虎牙主播/房间...";
    if (activePlatformLabel === "bilibili") return "搜索B站直播间...";
    if (activePlatformLabel === "douyin") return "搜索直播间号";
    if (activePlatformLabel === "custom" || activePlatformLabel === "follows") return "搜索主播 / 直播间...";
    return "搜索斗鱼主播/房间...";
  }, [activePlatformLabel, searchFilter, searchSpotlightOpen]);

  const focusInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  // 卡片静止位是 overlay 的 flex 居中 + padding-top 18vh，可由视口直接算出（卡片高度动态但不参与对齐）。
  // 变换取 transform-origin 顶中：缩放平移后卡片顶中与锚点框顶中重合，视觉上即"从搜索框长出来/缩回去"。
  const spotlightOrigin = useMemo(() => {
    const el = spotlightAnchor;
    if (!el || typeof window === "undefined") return null;
    const a = el.getBoundingClientRect();
    // 锚点不可见（如播放页收起的搜索框 display:none）时矩形为 0，退回默认动画
    if (!a.width || !a.height) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardWidth = Math.min(560, vw * 0.92);
    const cardLeft = (vw - cardWidth) / 2;
    const cardTop = Math.round(vh * 0.18);
    return {
      x: a.left + a.width / 2 - (cardLeft + cardWidth / 2),
      y: a.top - cardTop,
      scale: Math.max(0.16, Math.min(1, a.width / cardWidth))
    };
  }, [spotlightAnchor]);

  // chip 滑动胶囊（spotlight 内部自管）
  const chipRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const chipContainerRef = useRef<HTMLDivElement | null>(null);
  const spotlightCardRef = useRef<HTMLDivElement | null>(null);
  const [chipHighlight, setChipHighlight] = useState<{ width: number; x: number; opacity: number }>({ width: 0, x: 0, opacity: 0 });
  const chipHighlightMotion = useMemo(
    () => ({
      width: chipHighlight.width,
      x: chipHighlight.x,
      opacity: chipHighlight.opacity,
      scale: chipHighlight.opacity ? 1 : 0.96
    }),
    [chipHighlight]
  );

  const updateChipHighlight = useCallback(() => {
    const el = chipRefs.current[searchFilter];
    const container = chipContainerRef.current;
    const card = spotlightCardRef.current;
    if (!el || !container) {
      setChipHighlight((prev) => ({ ...prev, opacity: 0 }));
      return;
    }
    // 锚点弹出动画期间卡片带 scale，getBoundingClientRect 是视觉尺寸；按当前缩放反推布局值，
    // 否则挂载首帧会把胶囊量成 ~0.2 倍宽并停在那里
    let scale = 1;
    if (card) {
      const visual = card.getBoundingClientRect().width;
      if (visual > 0 && card.offsetWidth > 0) scale = visual / card.offsetWidth;
    }
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setChipHighlight({ width: r.width / scale, x: (r.left - c.left) / scale, opacity: 1 });
  }, [searchFilter]);

  useLayoutEffect(() => {
    updateChipHighlight();
  }, [updateChipHighlight, searchSpotlightOpen]);

  useEffect(() => {
    if (!searchSpotlightOpen) return;
    const onResize = () => updateChipHighlight();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateChipHighlight, searchSpotlightOpen]);

  // 渲染 Spotlight 浮层（唯一一份；进出场均从锚点位置弹出/收回）
  const renderSpotlight = useCallback(() => {
    if (typeof document === "undefined") return null;
    const showResults = !!searchQuery.trim();
    // AnimatePresence 退场期间沿用关闭前快照，query/results 虽被 close() 清空也不会闪变
    const originFrom = spotlightOrigin
      ? { opacity: 0, x: spotlightOrigin.x, y: spotlightOrigin.y, scale: spotlightOrigin.scale }
      : { opacity: 0, y: -14, scale: 0.97 };
    return createPortal(
      <AnimatePresence>
        {searchSpotlightOpen ? (
          <m.div
            key="search-spotlight"
            className={styles.searchSpotlightOverlay}
            role="presentation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.16, ease: "easeIn" } }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <m.div
              ref={spotlightCardRef}
              className={styles.searchSpotlightCard}
              role="dialog"
              aria-label="搜索"
              initial={originFrom}
              animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
              exit={{ ...originFrom, transition: { duration: 0.2, ease: "easeIn" } }}
              transition={{
                type: "spring",
                stiffness: 460,
                damping: 40,
                mass: 0.85,
                opacity: { duration: 0.16, ease: "easeOut" }
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
          <div className={styles.searchSpotlightInputWrap}>
            <Search size={20} className={styles.searchSpotlightIcon} />
            <input
              ref={inputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={placeholderText}
              className={styles.searchSpotlightInput}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Escape") close();
              }}
            />
            {searchQuery ? (
              <button
                type="button"
                className={styles.searchSpotlightClear}
                aria-label="清除搜索"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setSearchQuery("");
                  setSearchResults([]);
                  setSearchError(null);
                }}
              >
                <X size={16} />
              </button>
            ) : null}
          </div>

          <div className={styles.searchSpotlightFilters}>
            <div className={styles.searchSpotlightFiltersInner} ref={chipContainerRef}>
              <m.span
                className={styles.searchSpotlightChipHighlight}
                initial={false}
                animate={chipHighlightMotion}
                transition={{ type: "spring", stiffness: 420, damping: 36, mass: 0.85 }}
              />
              {SPOTLIGHT_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`${styles.searchSpotlightChip}${searchFilter === f.id ? " " + styles.searchSpotlightChipActive : ""}`}
                  ref={(node) => {
                    chipRefs.current[f.id] = node;
                  }}
                  onClick={() => {
                    setSearchFilter(f.id);
                    setSearchResults([]);
                    setSearchError(null);
                  }}
                >
                  {f.id === "follows" ? <Users size={13} /> : <PlatformIcon platform={f.id} size={13} />}
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.searchSpotlightBody}>
            {isLoadingSearch ? (
              <div className={styles.searchMeta}>搜索中...</div>
            ) : searchError ? (
              <div className={styles.searchMeta}>{searchError}</div>
            ) : searchResults.length ? (
              <div className={styles.searchResultsList}>
                {searchResults.map((anchor) => {
                  const trigger = (which: "main" | "standalone" | "inPlace") => {
                    if (which === "main" && onSelectInMain) onSelectInMain(anchor.platform, anchor.roomId);
                    else if (which === "standalone" && onSelectInStandalone) onSelectInStandalone(anchor.platform, anchor.roomId);
                    else if (which === "inPlace" && onSelectInPlace) onSelectInPlace(anchor.platform, anchor.roomId);
                    close();
                  };
                  const hasMulti = (onSelectInMain ? 1 : 0) + (onSelectInStandalone ? 1 : 0) + (onSelectInPlace ? 1 : 0);
                  return (
                    <div
                      key={`${anchor.platform}-${anchor.roomId}`}
                      className={styles.searchResultItem}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        trigger("main");
                      }}
                    >
                      <div className={styles.resultAvatar}>
                        {anchor.avatar ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            className={styles.resultAvatarImg}
                            src={anchor.platform === "bilibili" || anchor.platform === "huya" ? proxify(anchor.avatar) : anchor.avatar}
                            alt={anchor.userName}
                          />
                        ) : (
                          <div className={styles.resultAvatarFallback}>{(anchor.userName || "?").slice(0, 1)}</div>
                        )}
                        <span className={`${styles.liveDot} ${anchor.liveStatus ? styles.liveDotOn : ""}`} aria-hidden="true" />
                      </div>
                      <div className={styles.resultMain}>
                        <div className={styles.resultName} title={anchor.userName}>
                          {anchor.userName}
                        </div>
                        <div className={styles.resultTitle} title={anchor.roomTitle}>
                          {anchor.roomTitle}
                        </div>
                      </div>
                      {hasMulti > 1 ? (
                        <div className={styles.searchResultActions}>
                          {onSelectInStandalone ? (
                            <button
                              type="button"
                              className={styles.searchResultAction}
                              title="独立窗口打开"
                              aria-label="独立窗口打开"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                trigger("standalone");
                              }}
                            >
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M14 4h6v6" />
                                <path d="M20 4 10 14" />
                                <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
                              </svg>
                            </button>
                          ) : null}
                          {onSelectInPlace ? (
                            <button
                              type="button"
                              className={styles.searchResultAction}
                              title="当前窗口切换"
                              aria-label="当前窗口切换"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                trigger("inPlace");
                              }}
                            >
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M8 3 4 7l4 4" />
                                <path d="M4 7h16" />
                                <path d="m16 21 4-4-4-4" />
                                <path d="M20 17H4" />
                              </svg>
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : showResults && !searchResults.length ? (
              <div className={styles.searchMeta}>
                未找到结果
                {searchQuery.trim() && /^\d+$/.test(searchQuery.trim()) && searchFilter !== "douyin" && searchFilter !== "all" && searchFilter !== "follows" ? (
                  <button
                    type="button"
                    className={styles.searchFallbackBtn}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (onSelectInMain) onSelectInMain(searchFilter, searchQuery.trim());
                      else if (onSelectInStandalone) onSelectInStandalone(searchFilter, searchQuery.trim());
                      else if (onSelectInPlace) onSelectInPlace(searchFilter, searchQuery.trim());
                      close();
                    }}
                  >
                    进入房间 {searchQuery.trim()}
                  </button>
                ) : null}
              </div>
            ) : searchFilter === "all" || searchFilter === "follows" ? (
              <div className={styles.searchMeta}>暂无关注主播，输入关键词搜索或先去关注</div>
            ) : (
              <div className={styles.searchMeta}>输入关键词搜索主播 / 直播间</div>
            )}
          </div>
            </m.div>
          </m.div>
        ) : null}
      </AnimatePresence>,
      document.body
    );
  }, [
    chipHighlightMotion,
    close,
    isLoadingSearch,
    onSelectInMain,
    onSelectInPlace,
    onSelectInStandalone,
    placeholderText,
    proxify,
    searchError,
    searchFilter,
    searchQuery,
    searchResults,
    searchSpotlightOpen,
    spotlightOrigin
  ]);

  return {
    state: {
      query: searchQuery,
      setQuery: setSearchQuery,
      isOpen: searchSpotlightOpen,
      filter: searchFilter,
      setFilter: setSearchFilter,
      results: searchResults,
      error: searchError,
      isLoading: isLoadingSearch
    },
    actions: {
      open,
      close,
      focusInput,
      submitNumeric: (defaultAction: (p: string, r: string) => void) => submitNumericRoom(defaultAction),
      placeholder: placeholderText
    },
    renderSpotlight
  };
}
