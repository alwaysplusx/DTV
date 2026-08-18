"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ExternalLink, MonitorSmartphone, Settings, ThumbsUp, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import styles from "./SettingsMenu.module.css";
import { LanSyncModal } from "./LanSyncModal";
import { openInDefaultBrowser } from "@/services/openExternal";

type VersionInfo = {
  version: string;
  title?: string;
  notes?: string[];
  url?: string;
  published_at?: string;
};

const GITHUB_RELEASES_URL = "https://github.com/chen-zeong/DTV/releases";

export function SettingsMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [donateOpen, setDonateOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [lanSyncOpen, setLanSyncOpen] = useState(false);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [localVersion, setLocalVersion] = useState<string>("");

  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点外关闭二级菜单
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 版本检查不是关键功能：失败不重试、不报错、不提示
      try {
        const res = await invoke<any>("check_version_cmd");
        if (cancelled) return;
        const local = typeof res?.local_version === "string" ? res.local_version : "";
        setLocalVersion(local);
        const remote = res?.remote;
        if (remote && typeof remote.version === "string" && remote.version.trim()) {
          const info: VersionInfo = {
            version: remote.version,
            title: typeof remote.title === "string" ? remote.title : undefined,
            notes: Array.isArray(remote.notes) ? remote.notes.filter((x: any) => typeof x === "string") : undefined,
            url: typeof remote.url === "string" ? remote.url : undefined,
            published_at: typeof remote.published_at === "string" ? remote.published_at : undefined
          };
          setVersionInfo(info);
        }
        setHasUpdate(!!res?.has_update);
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const openMenuItem = useCallback((open: () => void) => {
    setMenuOpen(false);
    open();
  }, []);

  return (
    <div ref={rootRef} className={styles.settingsRoot}>
      <button
        type="button"
        className={styles.settingsBtn}
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="设置"
        title="设置"
      >
        <Settings size={18} />
        {hasUpdate ? <span className={styles.badgeDot} aria-hidden="true" /> : null}
      </button>

      <AnimatePresence initial={false}>
        {menuOpen ? (
          <m.div
            className={styles.menu}
            role="menu"
            aria-label="设置菜单"
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}
          >
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => openMenuItem(() => setUpdateOpen(true))}
            >
              <span className={styles.menuItemMain}>
                <span className={styles.menuItemLabel}>版本信息</span>
                <span className={styles.menuItemValue}>
                  v{localVersion || "?"}
                  {hasUpdate ? <span className={styles.badgeNew}>NEW</span> : null}
                </span>
              </span>
            </button>

            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => openMenuItem(() => setLanSyncOpen(true))}
            >
              <span className={styles.menuItemMain}>
                <span className={styles.menuItemLabel}>
                  <MonitorSmartphone size={15} />
                  数据同步
                </span>
                <span className={styles.menuItemValue} />
              </span>
            </button>

            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => openMenuItem(() => setDonateOpen(true))}
            >
              <span className={styles.menuItemMain}>
                <span className={styles.menuItemLabel}>
                  <ThumbsUp size={15} />
                  打赏支持
                </span>
                <span className={styles.menuItemValue} />
              </span>
            </button>
          </m.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {donateOpen ? (
          <m.div
            className={styles.overlayBackdrop}
            // eslint-disable-next-line react/no-unknown-property
            data-tauri-drag-region="false"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={() => setDonateOpen(false)}
          >
            <m.div
              className={styles.overlayCard}
              initial={{ opacity: 0, y: 10, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.99 }}
              transition={{ type: "spring", stiffness: 520, damping: 44, mass: 0.7 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className={styles.overlayHeader}>
                <div className={styles.overlayTitle}>打赏支持</div>
                <button type="button" className={styles.overlayClose} onClick={() => setDonateOpen(false)} aria-label="关闭">
                  <X size={16} />
                </button>
              </div>
              <div className={styles.overlayBody}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.qrImage} src="/wechat.jpg" alt="微信赞赏码" />
              </div>
            </m.div>
          </m.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {updateOpen ? (
          <m.div
            className={styles.overlayBackdrop}
            // eslint-disable-next-line react/no-unknown-property
            data-tauri-drag-region="false"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={() => setUpdateOpen(false)}
          >
            <m.div
              className={styles.overlayCard}
              initial={{ opacity: 0, y: 10, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.99 }}
              transition={{ type: "spring", stiffness: 520, damping: 44, mass: 0.7 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className={styles.overlayHeader}>
                <div className={styles.overlayTitle}>
                  {hasUpdate && versionInfo ? versionInfo.title || `发现新版本 v${versionInfo.version}` : "版本信息"}
                </div>
                <button type="button" className={styles.overlayClose} onClick={() => setUpdateOpen(false)} aria-label="关闭">
                  <X size={16} />
                </button>
              </div>
              <div className={styles.overlayBody}>
                <div className={styles.updateMeta}>
                  <span>当前版本：v{localVersion || "?"}</span>
                  {hasUpdate && versionInfo ? <span>最新版本：v{versionInfo.version}</span> : <span>已是最新</span>}
                  {hasUpdate && versionInfo?.published_at ? <span>发布日期：{versionInfo.published_at}</span> : null}
                </div>
                {hasUpdate && versionInfo?.notes?.length ? (
                  <ul className={styles.updateNotes}>
                    {versionInfo.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                ) : null}

                <div className={styles.updateActions}>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={() => void openInDefaultBrowser((versionInfo?.url || GITHUB_RELEASES_URL) as string)}
                  >
                    <ExternalLink size={16} />
                    {hasUpdate ? "打开下载页" : "打开 GitHub"}
                  </button>
                </div>
              </div>
            </m.div>
          </m.div>
        ) : null}
      </AnimatePresence>

      <LanSyncModal open={lanSyncOpen} onClose={() => setLanSyncOpen(false)} appVersion={localVersion} />
    </div>
  );
}
