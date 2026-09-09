"use client";

import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { X } from "lucide-react";

import styles from "./CustomHomePage.module.css";
import { CommonStreamerList } from "@/components/streamers/CommonStreamerList";
import { PlatformIcon } from "@/components/common/PlatformIcon";
import { useCustomCategories, type CustomCategoryEntry } from "@/state/customCategories/CustomCategoriesProvider";
import { douyinCategoriesData } from "@/platforms/douyin/douyinCategoriesData";
import { huyaCategoriesData } from "@/platforms/huya/huyaCategoriesData";
import { biliCategoriesData } from "@/platforms/bilibili/biliCategoriesData";
import type { CategorySelectedEvent } from "@/platforms/common/categoryTypes";

function platformLabel(p: string) {
  if (p === "douyu") return "斗鱼";
  if (p === "douyin") return "抖音";
  if (p === "huya") return "虎牙";
  if (p === "bilibili") return "Bilibili";
  return p;
}

export function CustomHomePage() {
  const { entries, removeByKey } = useCustomCategories();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.sessionStorage.getItem("dtv_custom_selected_key_v1");
      if (saved) setSelectedKey(saved);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!entries.length) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !entries.some((e) => e.key === selectedKey)) {
      setSelectedKey(entries[0].key);
    }
  }, [entries, selectedKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!selectedKey) return;
    try {
      window.sessionStorage.setItem("dtv_custom_selected_key_v1", selectedKey);
    } catch {
      // ignore
    }
  }, [selectedKey]);

  const selectedEntry: CustomCategoryEntry | null = useMemo(() => {
    return entries.find((e) => e.key === selectedKey) ?? null;
  }, [entries, selectedKey]);

  const selectedPlatform = selectedEntry?.platform ?? "douyu";

  const selectedCategoriesData = useMemo(() => {
    if (selectedPlatform === "douyin") return douyinCategoriesData as any;
    if (selectedPlatform === "huya") return huyaCategoriesData as any;
    if (selectedPlatform === "bilibili") return biliCategoriesData as any;
    return undefined;
  }, [selectedPlatform]);

  const selectedCategory: CategorySelectedEvent | null = useMemo(() => {
    if (!selectedEntry || selectedEntry.platform === "douyu") return null;
    return {
      type: "cate2",
      cate1Href: selectedEntry.cate1Href || "",
      cate2Href: selectedEntry.cate2Href || "",
      cate1Name: selectedEntry.cate1Name || "",
      cate2Name: selectedEntry.cate2Name
    };
  }, [selectedEntry]);

  const selectedDouyuCategory = useMemo(() => {
    if (!selectedEntry || selectedEntry.platform !== "douyu") return null;
    return { type: "cate2" as const, id: selectedEntry.douyuId || "", name: selectedEntry.cate2Name };
  }, [selectedEntry]);

  return (
    <div className={styles.customHome}>
      {!entries.length ? <div className={styles.emptyTip}>暂无收藏分区，去分类页订阅后会出现在这里。</div> : null}

      {entries.length ? (
        <div className={styles.list}>
          <AnimatePresence initial={false}>
            {entries.map((entry) => {
              const active = entry.key === selectedKey;
              const platformClass =
                entry.platform === "douyu"
                  ? styles.platformDouyu
                  : entry.platform === "douyin"
                    ? styles.platformDouyin
                    : entry.platform === "huya"
                      ? styles.platformHuya
                      : styles.platformBilibili;

              return (
                <m.div
                  key={entry.key}
                  layout
                  className={`${styles.chip} ${platformClass} ${active ? styles.chipActive : ""}`}
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.16, ease: [0.4, 0, 0.2, 1] } }}
                  transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setSelectedKey(entry.key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedKey(entry.key);
                    }
                  }}
                  title={platformLabel(entry.platform)}
                >
                  <span className={styles.chipPlatform}>
                    <PlatformIcon platform={entry.platform} size={12} />
                  </span>
                  <span className={styles.chipName}>{entry.cate2Name}</span>
                  <button
                    type="button"
                    data-slot="button"
                    className={styles.chipRemoveBtn}
                    title="取消订阅"
                    aria-label={`取消订阅 ${entry.cate2Name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeByKey(entry.key);
                    }}
                  >
                    <X size={12} />
                  </button>
                </m.div>
              );
            })}
          </AnimatePresence>
        </div>
      ) : null}

      <div className={styles.streamerList}>
        {selectedEntry ? (
          <CommonStreamerList
            selectedCategory={selectedCategory}
            categoriesData={selectedCategoriesData}
            douyuCategory={selectedDouyuCategory}
            platformName={selectedPlatform}
            defaultPageSize={selectedPlatform === "huya" ? 120 : undefined}
          />
        ) : null}
      </div>
    </div>
  );
}
