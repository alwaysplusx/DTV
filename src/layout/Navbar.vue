<template>
  <nav
    class="mica navbar"
    data-tauri-drag-region
    :style="{
      height: 'var(--navbar-height)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 32px',
      paddingLeft: '16px',
      paddingRight: shouldShowWindowsControls && !isMacPreview ? '160px' : '16px',
      borderBottom: '1px solid var(--border)',
      position: 'sticky',
      top: 0,
      zIndex: 50,
      gap: '32px',
    }"
  >
    <div v-if="isMacPreview" class="mac-controls" aria-hidden="true">
      <span class="mac-dot mac-dot--close"></span>
      <span class="mac-dot mac-dot--min"></span>
      <span class="mac-dot mac-dot--max"></span>
    </div>

    <div class="platform-tabs-wrap" data-tauri-drag-region>
      <div class="platform-tabs" ref="platformTabsRef" data-tauri-drag-region>
        <div class="platform-highlight" :style="highlightStyles" data-tauri-drag-region />
      <button
        v-for="platform in platforms"
        :key="platform.id"
        type="button"
        class="platform-tab"
        :class="{ active: activePlatform === platform.id }"
        data-tauri-drag-region="false"
        :ref="(el) => setPlatformRef(platform.id, el)"
        @click="emit('platform-change', platform.id)"
      >
        {{ platform.name }}
      </button>
    </div>
    </div>

    <div class="nav-actions" :class="{ 'nav-actions--windows': shouldShowWindowsControls }" data-tauri-drag-region>
      <div class="search-container" ref="searchContainerRef" data-tauri-drag-region="false">
          <div class="search-shell" :class="{ focused: isSearchFocused }">
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="placeholderText"
              data-tauri-drag-region="false"
              class="search-input"
              @focus="handleFocus"
              @blur="handleBlur"
              @input="handleSearch"
            />
            <button
              v-if="searchQuery"
              type="button"
              class="search-clear-btn"
              data-tauri-drag-region="false"
              aria-label="清除搜索"
              @click="resetSearchState"
            >
              <X :size="14" />
            </button>
          </div>

          <div v-show="showResults" class="search-results-wrapper">
            <div v-if="isLoadingSearch" class="search-loading">搜索中...</div>
            <div v-else-if="searchError" class="search-error-message">{{ searchError }}</div>
            <div v-else-if="searchResults.length > 0" class="search-results-list">
              <div
                v-for="anchor in searchResults"
                :key="anchor.platform + '-' + anchor.roomId"
                class="search-result-item"
                @mousedown="selectAnchor(anchor)"
              >
                <div class="result-avatar">
                  <img v-if="anchor.avatar" :src="anchor.avatar" :alt="anchor.userName" class="avatar-img" />
                  <div v-else class="avatar-placeholder">{{ anchor.userName[0] }}</div>
                </div>

                <div class="result-main-content">
                  <div class="result-line-1-main">
                    <span class="result-name" :title="anchor.userName">{{ anchor.userName }}</span>
                    <span class="live-status-badge styled-badge" :class="{ 'is-live': anchor.liveStatus }">
                      {{ anchor.liveStatus ? '直播' : '未播' }}
                    </span>
                  </div>
                  <div class="result-line-2-main">
                    <span class="result-room-title" :title="anchor.roomTitle || '暂无标题'">{{ anchor.roomTitle || '暂无标题' }}</span>
                    <span class="result-roomid styled-badge">{{ anchor.webId || anchor.roomId }}</span>
                  </div>
                </div>

                <div class="result-meta-right">
                  <span
                    class="platform-tag styled-badge"
                    :class="[
                      anchor.platform.toLowerCase(),
                      { douyu: anchor.platform === Platform.DOUYU, douyin: anchor.platform === Platform.DOUYIN, huya: anchor.platform === Platform.HUYA }
                    ]"
                  >
                    {{ anchor.platform === Platform.DOUYU ? '斗鱼' : (anchor.platform === Platform.DOUYIN ? '抖音' : (anchor.platform === Platform.HUYA ? '虎牙' : anchor.platform)) }}
                  </span>
                </div>
              </div>
            </div>

            <div v-else-if="trimmedQuery && !isLoadingSearch && !searchError" class="search-no-results">
              未找到结果
              <button
                v-if="isPureNumeric(trimmedQuery)"
                class="search-fallback-btn"
                @mousedown.prevent="tryEnterRoom(trimmedQuery)"
                @click.prevent="tryEnterRoom(trimmedQuery)"
              >
                进入房间 {{ trimmedQuery }}
              </button>
            </div>
          </div>
      </div>

      <button type="button" class="nav-icon-btn github-btn" data-tauri-drag-region="false" @click="openGithub">
        <Github :size="20" />
        <span class="github-badge">{{ appVersion || '-' }}</span>
      </button>
      <button
        type="button"
        class="nav-icon-btn"
        data-tauri-drag-region="false"
        @click="toggleTheme"
      >
        <Sun v-if="effectiveTheme === 'dark'" :size="20" />
        <Moon v-else :size="20" />
      </button>

      <div v-if="shouldShowWindowsControls && !isMacPreview" class="win-controls-wrap">
        <WindowsWindowControls />
      </div>
  </div>
  </nav>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { platform as detectPlatform } from '@tauri-apps/plugin-os';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { useRoute } from 'vue-router';
import { Github, Moon, Sun, X } from 'lucide-vue-next';
import WindowsWindowControls from '../components/window-controls/WindowsWindowControls.vue';
import { useThemeStore } from '../stores/theme';
import { Platform } from '../platforms/common/types';
import type { Platform as UiPlatform } from './types';

interface DouyinApiStreamInfo {
  title?: string | null;
  anchor_name?: string | null;
  avatar?: string | null;
  status?: number | null;
  error_message?: string | null;
  web_rid?: string | null;
}

interface HuyaAnchorItem {
  room_id: string;
  avatar: string;
  user_name: string;
  live_status: boolean;
  title: string;
}

type BilibiliSearchItem = {
  room_id: string;
  title: string;
  cover: string;
  anchor: string;
  avatar: string;
  watching: string;
  area: string;
  is_live: boolean;
};

interface SearchResultItem {
  platform: Platform;
  roomId: string;
  webId?: string | null;
  userName: string;
  roomTitle?: string | null;
  avatar: string | null;
  liveStatus: boolean;
  fansCount?: string;
  category?: string;
  rawStatus?: number | null;
}

const props = defineProps<{
  theme: 'light' | 'dark';
  searchQuery?: string;
  activePlatform: UiPlatform | 'all';
}>();

const emit = defineEmits<{
  (event: 'theme-toggle'): void;
  (event: 'search-change', value: string): void;
  (event: 'platform-change', value: UiPlatform | 'all'): void;
  (event: 'select-anchor', payload: { id: string; platform: Platform; nickname: string; avatarUrl: string | null; currentRoomId?: string }): void;
}>();

const platforms: { id: UiPlatform | 'all'; name: string }[] = [
  { id: 'douyu', name: '斗鱼' },
  { id: 'huya', name: '虎牙' },
  { id: 'douyin', name: '抖音' },
  { id: 'bilibili', name: 'Bilibili' },
];

const activePlatform = computed(() => props.activePlatform);
const searchQuery = ref(props.searchQuery ?? '');
const trimmedQuery = computed(() => searchQuery.value.trim());
const searchResults = ref<SearchResultItem[]>([]);
const showResults = ref(false);
const searchError = ref<string | null>(null);
const isLoadingSearch = ref(false);
const isSearchFocused = ref(false);
const searchContainerRef = ref<HTMLElement | null>(null);
const platformTabsRef = ref<HTMLElement | null>(null);
const platformItemRefs = new Map<UiPlatform | 'all', HTMLElement>();
const highlight = ref({ left: 0, width: 0, opacity: 0 });
const highlightStyles = computed(() => ({
  transform: `translateX(${highlight.value.left}px)`,
  width: `${highlight.value.width}px`,
  opacity: highlight.value.opacity,
}));

const themeStore = useThemeStore();
const effectiveTheme = computed(() => themeStore.getEffectiveTheme());
const route = useRoute();

const detectedPlatform = ref<string | null>(null);
const isMacPreview = false;
const appVersion = ref('');
const isWindowsPlatform = computed(() => {
  const name = detectedPlatform.value?.toLowerCase() ?? '';
  return name.startsWith('win');
});
const shouldShowWindowsControls = computed(() => isWindowsPlatform.value);

const proxyBase = ref<string | null>(null);
const ensureProxyStarted = async () => {
  if (!proxyBase.value) {
    try {
      const base = await invoke<string>('start_static_proxy_server');
      proxyBase.value = base;
    } catch (e) {
      console.error('[Navbar] Failed to start static proxy server', e);
    }
  }
};
const proxify = (url?: string | null): string | null => {
  if (!url) return null;
  if (proxyBase.value) {
    return `${proxyBase.value}/image?url=${encodeURIComponent(url)}`;
  }
  return url;
};

const currentPlatform = computed<Platform>(() => {
  const name = route.name as string | undefined;
  const path = route.path;

  if (name) {
    if (name === 'douyinPlayer' || name === 'DouyinHome') return Platform.DOUYIN;
    if (name === 'huyaPlayer' || name === 'HuyaHome') return Platform.HUYA;
    if (name === 'bilibiliPlayer' || name === 'BilibiliHome') return Platform.BILIBILI;
    if (name === 'douyuPlayer' || name === 'DouyuHome') return Platform.DOUYU;
  }

  if (path.startsWith('/player/douyin') || path.startsWith('/douyin')) return Platform.DOUYIN;
  if (path.startsWith('/player/huya') || path.startsWith('/huya')) return Platform.HUYA;
  if (path.startsWith('/player/bilibili') || path.startsWith('/bilibili')) return Platform.BILIBILI;
  if (path.startsWith('/player/douyu') || path.startsWith('/')) return Platform.DOUYU;

  return Platform.DOUYU;
});

const placeholderText = computed(() => {
  if (currentPlatform.value === Platform.DOUYU) return '搜索斗鱼主播名称/房间号';
  if (currentPlatform.value === Platform.HUYA) return '搜索虎牙主播名称/房间号';
  if (currentPlatform.value === Platform.DOUYIN) return '搜索抖音房间号';
  if (currentPlatform.value === Platform.BILIBILI) return '搜索B站主播名称/房间号';
  return '搜索主播/房间';
});

onMounted(async () => {
  try {
    detectedPlatform.value = await detectPlatform();
  } catch (error) {
    console.error('[Navbar] Failed to detect platform', error);
    if (typeof navigator !== 'undefined') {
      const ua = navigator.userAgent.toLowerCase();
      if (ua.includes('windows')) {
        detectedPlatform.value = 'windows';
      }
    }
  }
});

onMounted(() => {
  if (isMacPreview && typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-platform', 'darwin');
  } else if (typeof document !== 'undefined') {
    document.documentElement.removeAttribute('data-platform');
  }
});

onMounted(async () => {
  try {
    appVersion.value = await getVersion();
  } catch (error) {
    console.error('[Navbar] Failed to read app version', error);
  }
});

const setPlatformRef = (key: UiPlatform | 'all', el: Element | ComponentPublicInstance | null) => {
  if (!el) {
    platformItemRefs.delete(key);
    return;
  }
  const element = (el as ComponentPublicInstance).$el ?? el;
  if (element instanceof HTMLElement) {
    platformItemRefs.set(key, element);
  }
};

const updateHighlight = async () => {
  await nextTick();
  const container = platformTabsRef.value;
  const active = platformItemRefs.get(props.activePlatform);
  if (!container || !active) {
    highlight.value.opacity = 0;
    return;
  }
  const rect = active.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  highlight.value = {
    left: rect.left - containerRect.left,
    width: rect.width,
    opacity: 1,
  };
};

watch(() => props.activePlatform, () => {
  updateHighlight();
}, { immediate: true });

onMounted(() => {
  window.addEventListener('resize', updateHighlight);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateHighlight);
});

const handleDocumentMouseDown = (event: MouseEvent) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (searchContainerRef.value && !searchContainerRef.value.contains(target)) {
    showResults.value = false;
    isSearchFocused.value = false;
  }
};

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentMouseDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDocumentMouseDown);
});

const toggleTheme = () => {
  emit('theme-toggle');
};

const openGithub = async () => {
  try {
    await openUrl('https://github.com/chen-zeong/DTV/releases');
  } catch (error) {
    if (typeof window !== 'undefined') {
      window.open('https://github.com/chen-zeong/DTV/releases', '_blank', 'noopener,noreferrer');
      return;
    }
    console.error('[Navbar] Failed to open GitHub', error);
  }
};

let searchTimeout: number | null = null;

const isPureNumeric = (value: string): boolean => /^\d+$/.test(value);

const resetSearchState = () => {
  if (searchTimeout) {
    clearTimeout(searchTimeout);
    searchTimeout = null;
  }
  searchQuery.value = '';
  searchResults.value = [];
  searchError.value = null;
  showResults.value = false;
  isLoadingSearch.value = false;
};

const handleSearch = () => {
  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }
  searchError.value = null;
  isLoadingSearch.value = true;
  emit('search-change', searchQuery.value);

  searchTimeout = window.setTimeout(() => {
    performSearchBasedOnInput();
  }, 500);
};

const performSearchBasedOnInput = async () => {
  const query = trimmedQuery.value;
  if (!query) {
    searchResults.value = [];
    showResults.value = false;
    isLoadingSearch.value = false;
    return;
  }
  searchQuery.value = query;

  if (currentPlatform.value === Platform.DOUYIN) {
    await performDouyinIdSearch(query);
  } else if (currentPlatform.value === Platform.HUYA) {
    await performHuyaSearch(query);
  } else if (currentPlatform.value === Platform.BILIBILI) {
    await performBilibiliSearch(query);
  } else {
    await performDouyuSearch(query);
  }
  isLoadingSearch.value = false;
};

const performDouyinIdSearch = async (userInputRoomId: string) => {
  searchResults.value = [];
  searchError.value = null;
  isLoadingSearch.value = true;
  try {
    const payloadData = { args: { room_id_str: userInputRoomId } };
    const douyinInfo = await invoke<DouyinApiStreamInfo>('fetch_douyin_streamer_info', {
      payload: payloadData,
    });
    isLoadingSearch.value = false;
    if (douyinInfo?.anchor_name) {
      const isLive = douyinInfo.status === 2;
      const webId = (douyinInfo as any).web_rid ?? userInputRoomId;
      searchResults.value = [{
        platform: Platform.DOUYIN,
        roomId: webId,
        webId,
        userName: douyinInfo.anchor_name || '抖音主播',
        roomTitle: douyinInfo.title || null,
        avatar: douyinInfo.avatar || null,
        liveStatus: isLive,
        rawStatus: douyinInfo.status,
      }];
    } else {
      searchError.value = '搜索失败，请重试。';
    }
  } catch (e) {
    isLoadingSearch.value = false;
    searchError.value = '搜索失败，请重试。';
  }
  showResults.value = true;
};

const performHuyaSearch = async (keyword: string) => {
  searchResults.value = [];
  searchError.value = null;
  isLoadingSearch.value = true;
  try {
    const items = await invoke<HuyaAnchorItem[]>('search_huya_anchors', { keyword, page: 1 });
    await ensureProxyStarted();
    isLoadingSearch.value = false;
    if (Array.isArray(items) && items.length > 0) {
      searchResults.value = items.map((item): SearchResultItem => ({
        platform: Platform.HUYA,
        roomId: item.room_id,
        userName: item.user_name || '虎牙主播',
        roomTitle: item.title || null,
        avatar: proxify(item.avatar || null),
        liveStatus: !!item.live_status,
      }));
      searchError.value = null;
    }
  } catch (e) {
    isLoadingSearch.value = false;
    searchError.value = '搜索失败，请重试。';
  }
  showResults.value = true;
};

const performDouyuSearch = async (keyword: string) => {
  searchResults.value = [];
  searchError.value = null;
  isLoadingSearch.value = true;
  try {
    const response = await invoke<string>('search_anchor', { keyword });
    isLoadingSearch.value = false;
    const data = JSON.parse(response);
    if (data.error === 0 && data.data && data.data.relateUser) {
      searchResults.value = data.data.relateUser
        .filter((item: any) => item.type === 1)
        .map((item: any): SearchResultItem => {
          const anchorInfo = item.anchorInfo;
          const isReallyLive = anchorInfo.isLive === 1 && anchorInfo.videoLoop !== 1;
          return {
            platform: Platform.DOUYU,
            roomId: anchorInfo.rid.toString(),
            userName: anchorInfo.nickName,
            roomTitle: anchorInfo.roomName || anchorInfo.description || null,
            avatar: anchorInfo.avatar,
            liveStatus: isReallyLive,
            fansCount: anchorInfo.fansNumStr,
            category: anchorInfo.cateName,
          };
        });
      searchError.value = null;
    } else {
      searchError.value = '搜索失败，请重试。';
    }
  } catch (e) {
    isLoadingSearch.value = false;
    searchError.value = '搜索失败，请重试。';
  }
  showResults.value = true;
};

const performBilibiliSearch = async (keyword: string) => {
  searchResults.value = [];
  searchError.value = null;
  isLoadingSearch.value = true;
  try {
    const response = await invoke<BilibiliSearchItem[]>('search_bilibili_rooms', {
      keyword,
      page: 1,
    });
    await ensureProxyStarted();
    if (Array.isArray(response) && response.length > 0) {
      searchResults.value = response.map((item) => ({
        platform: Platform.BILIBILI,
        roomId: item.room_id,
        webId: item.room_id,
        userName: item.anchor || 'B站主播',
        roomTitle: item.title || null,
        avatar: proxify(item.avatar),
        liveStatus: item.is_live,
        fansCount: item.watching,
        category: item.area,
      }));
    }
  } catch (e) {
    searchError.value = '搜索失败，请重试。';
  } finally {
    isLoadingSearch.value = false;
    showResults.value = true;
  }
};

const handleFocus = () => {
  isSearchFocused.value = true;
  showResults.value = true;
};

const handleBlur = () => {
  isSearchFocused.value = false;
  setTimeout(() => {
    if (!isLoadingSearch.value && !searchError.value) {
      showResults.value = false;
    }
  }, 300);
};

const selectAnchor = (anchor: SearchResultItem) => {
  emit('select-anchor', {
    id: anchor.webId || anchor.roomId,
    platform: anchor.platform,
    nickname: anchor.userName,
    avatarUrl: anchor.avatar,
    currentRoomId: undefined,
  });
  resetSearchState();
};

const tryEnterRoom = (roomId: string) => {
  if (!roomId) return;
  emit('select-anchor', {
    id: roomId,
    platform: currentPlatform.value,
    nickname: roomId,
    avatarUrl: null,
    currentRoomId: undefined,
  });
  resetSearchState();
};
</script>
<style scoped>
.platform-tabs-wrap {
  flex: 0 0 auto;
}

.mac-controls {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding-left: 4px;
}

.mac-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}

.mac-dot--close {
  background: #ff5f57;
}

.mac-dot--min {
  background: #febc2e;
}

.mac-dot--max {
  background: #28c840;
}

.platform-tabs {
  display: flex;
  background-color: rgba(0, 0, 0, 0.04);
  padding: 4px;
  border-radius: var(--radius-md);
  position: relative;
  overflow: hidden;
}

:global([data-theme='dark']) .platform-tabs {
  background-color: rgba(255, 255, 255, 0.06);
}

.platform-tab {
  padding: 8px 20px;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-secondary);
  position: relative;
  z-index: 2;
  transition: color 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s ease;
}

.platform-tab:hover:not(.active) {
  background-color: rgba(0, 0, 0, 0.03);
}

.platform-tab.active {
  font-weight: 700;
  color: var(--text-primary);
}

.platform-highlight {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 0;
  background-color: var(--platform-active-bg);
  border-radius: var(--radius-sm);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition:
    transform 240ms cubic-bezier(0.16, 1, 0.3, 1),
    width 240ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 160ms ease;
  z-index: 1;
}

.search-container {
  position: relative;
  width: min(360px, 36vw);
}

.search-shell {
  width: 100%;
  max-width: 420px;
  position: relative;
  display: flex;
  align-items: center;
  z-index: 10;
  transform: scale(1);
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  background-color: rgba(0, 0, 0, 0.04);
  border-radius: var(--radius-lg);
}

:global([data-theme='dark']) .search-shell {
  background-color: rgba(255, 255, 255, 0.06);
}

.search-shell.focused {
  transform: scale(1.02);
  box-shadow: var(--shadow-lg);
}

.search-input {
  width: 100%;
  padding: 12px 16px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  font-size: 0.9rem;
  color: var(--text-primary);
  outline: none;
}

.search-clear-btn {
  background: transparent;
  border: none;
  width: 32px;
  height: 32px;
  margin-right: 6px;
  border-radius: 50%;
  cursor: pointer;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.search-clear-btn:hover {
  color: var(--accent);
  background: rgba(0, 0, 0, 0.06);
}

.search-results-wrapper {
  position: absolute;
  top: calc(100% + 10px);
  left: 0;
  right: 0;
  transform: none;
  width: 100%;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-radius: var(--radius-md);
  box-shadow: var(--glass-shadow);
  max-height: 480px;
  overflow-y: auto;
  z-index: 1001;
  border: 1px solid var(--glass-border);
  padding: 8px;
}

:global([data-theme='dark']) .search-results-wrapper,
:global(html[data-theme='dark']) .search-results-wrapper,
:global(:root[data-theme='dark']) .search-results-wrapper {
  background: rgba(18, 18, 20, 0.96) !important;
  border-color: rgba(255, 255, 255, 0.08);
}

.search-result-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s ease;
  gap: 10px;
}

.search-result-item:hover {
  background: var(--hover-bg);
  transform: translateX(4px);
}

:global([data-theme='dark']) .search-result-item:hover,
:global(html[data-theme='dark']) .search-result-item:hover,
:global(:root[data-theme='dark']) .search-result-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.result-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--tertiary-bg);
  border: 2px solid var(--border-color);
  flex-shrink: 0;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.result-main-content {
  flex: 1;
  min-width: 0;
}

.result-line-1-main {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 1px;
}

.result-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--primary-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:global([data-theme='dark']) .result-name,
:global(html[data-theme='dark']) .result-name,
:global(:root[data-theme='dark']) .result-name {
  color: #f3f4f6;
}

.result-room-title {
  font-size: 12px;
  color: var(--secondary-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:global([data-theme='dark']) .result-room-title,
:global(html[data-theme='dark']) .result-room-title,
:global(:root[data-theme='dark']) .result-room-title {
  color: #9ca3af;
}

.styled-badge {
  font-size: 10px;
  padding: 2px 10px;
  border-radius: 100px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

:global([data-theme='dark']) .styled-badge,
:global(html[data-theme='dark']) .styled-badge,
:global(:root[data-theme='dark']) .styled-badge {
  color: #e2e8f0;
}

.live-status-badge.is-live {
  background: rgba(255, 62, 62, 0.15);
  color: #ff3e3e;
  border: 1px solid rgba(255, 62, 62, 0.2);
}

.platform-tag {
  background: var(--hover-bg);
  color: var(--secondary-text);
  border: 1px solid var(--glass-border);
}

:global([data-theme='dark']) .platform-tag,
:global(html[data-theme='dark']) .platform-tag,
:global(:root[data-theme='dark']) .platform-tag {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
}

.platform-tag.douyu { color: #ff7a1c; }
.platform-tag.douyin { color: #fe2c55; }
.platform-tag.huya { color: #f5a623; }
.platform-tag.bilibili { color: #fb7299; }

.search-no-results {
  padding: 12px;
  font-size: 13px;
  color: var(--secondary-text);
}

:global([data-theme='dark']) .search-no-results,
:global(html[data-theme='dark']) .search-no-results,
:global(:root[data-theme='dark']) .search-no-results,
:global([data-theme='dark']) .search-loading,
:global(html[data-theme='dark']) .search-loading,
:global(:root[data-theme='dark']) .search-loading,
:global([data-theme='dark']) .search-error-message,
:global(html[data-theme='dark']) .search-error-message,
:global(:root[data-theme='dark']) .search-error-message {
  color: #cbd5e1;
}

:global([data-theme='dark']) .avatar-placeholder,
:global(html[data-theme='dark']) .avatar-placeholder,
:global(:root[data-theme='dark']) .avatar-placeholder {
  background: rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
}

.search-fallback-btn {
  background: transparent;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-weight: 600;
}

.nav-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  justify-content: flex-end;
  position: relative;
}

.nav-actions > .search-container {
  margin-left: auto;
}

.nav-actions--windows {
  position: static;
  padding-right: 0;
}

.nav-actions--windows :deep(.win-controls) {
  position: static !important;
}

.nav-icon-btn {
  padding: 12px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.04);
  transition: background-color 0.2s ease, transform 0.2s ease;
}

:global([data-theme='dark']) .nav-icon-btn {
  background-color: rgba(255, 255, 255, 0.06);
}

.nav-icon-btn:hover {
  background-color: rgba(0, 0, 0, 0.05);
  transform: scale(1.05);
}

:global([data-theme='dark']) .nav-icon-btn:hover {
  background-color: rgba(255, 255, 255, 0.08);
}

:global([data-theme='dark']) .nav-icon-btn:active {
  background-color: rgba(255, 255, 255, 0.12);
}

.nav-icon-btn:active {
  transform: scale(0.95);
}

.mini-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: mini-spin 0.8s linear infinite;
}

@keyframes mini-spin {
  to { transform: rotate(360deg); }
}

.win-controls-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  position: absolute;
  top: -1px;
  right: -1px;
}

.win-controls-wrap :deep(.win-controls) {
  position: static !important;
}

.github-btn {
  position: relative;
  padding-top: 10px;
  padding-right: 14px;
}

.github-badge {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  transform: none;
  padding: 2px 8px 3px;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  font-size: 8px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 0.2px;
  text-transform: uppercase;
  color: rgba(17, 24, 39, 0.68);
  background: rgba(17, 24, 39, 0.08);
  border: none;
  box-shadow: none;
  opacity: 0.95;
  text-align: center;
}

:global([data-theme='dark']) .github-badge {
  color: rgba(226, 232, 240, 0.9);
  background: rgba(226, 232, 240, 0.08);
  border-top-color: rgba(226, 232, 240, 0.2);
  border-bottom-color: rgba(226, 232, 240, 0.2);
  opacity: 0.9;
}

</style>
