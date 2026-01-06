<template>
  <aside
    class="mica sidebar-shell"
    :style="{
      width: isCollapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      borderRight: '1px solid var(--border)',
      transition: 'none',
    }"
  >
    <div v-show="!isCollapsed" class="sidebar-body">
      <FollowList
        :followedAnchors="followedAnchors"
        @selectAnchor="emit('select-anchor', $event)"
        @unfollow="emit('unfollow', $event)"
        @reorderList="emit('reorder-list', $event)"
      />
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { FollowedStreamer, Platform } from '../platforms/common/types';
import FollowList from '../components/FollowsList/index.vue';

defineProps<{
  isCollapsed: boolean;
  followedAnchors: FollowedStreamer[];
}>();

const emit = defineEmits<{
  (event: 'select-anchor', streamer: FollowedStreamer): void;
  (event: 'unfollow', payload: { platform: Platform; id: string } | string): void;
  (event: 'reorder-list', newList: FollowedStreamer[]): void;
}>();
</script>

<style scoped>
.sidebar-shell {
  z-index: 100;
}

.sidebar-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0 8px 8px;
}
</style>
