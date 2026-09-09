// 多屏直播布局模型 —— 设计文档：docs/multiview-layouts.md
// 6 档布局：双屏 / 四宫格 / 主副 1+3 / 竖双屏 / 竖三屏 / 竖四屏；上限 4 路。

export type MultiviewLayoutId = "SPLIT_2" | "GRID_4" | "PIPS_1_3" | "STACK_2" | "STACK_3" | "STACK_4";

export type MultiviewLayoutDef = {
  id: MultiviewLayoutId;
  label: string;
  /** 格子数量（= 槽位数） */
  cells: number;
  /** 是否为竖版（上下堆叠）布局 */
  vertical: boolean;
  /** CSS Grid 列模板 */
  gridTemplateColumns: string;
  /** CSS Grid 行模板 */
  gridTemplateRows: string;
  /** 仅 PIPS_1_3：大格（焦点格）跨行数 */
  focusSpanRows?: number;
  /** 仅 PIPS_1_3：焦点格所在槽位索引（0 = 第 1 格） */
  focusSlot?: number;
};

export const MULTIVIEW_LAYOUTS: MultiviewLayoutDef[] = [
  // 数组顺序 = 布局选择器按钮顺序：按格数由少到多、从左到右排列
  {
    id: "SPLIT_2",
    label: "双屏",
    cells: 2,
    vertical: false,
    gridTemplateColumns: "1fr 1fr",
    gridTemplateRows: "1fr"
  },
  {
    id: "STACK_2",
    label: "竖双屏",
    cells: 2,
    vertical: true,
    gridTemplateColumns: "1fr",
    gridTemplateRows: "1fr 1fr"
  },
  {
    id: "STACK_3",
    label: "竖三屏",
    cells: 3,
    vertical: true,
    gridTemplateColumns: "1fr",
    gridTemplateRows: "1fr 1fr 1fr"
  },
  {
    id: "GRID_4",
    label: "四宫格",
    cells: 4,
    vertical: false,
    gridTemplateColumns: "1fr 1fr",
    gridTemplateRows: "1fr 1fr"
  },
  {
    id: "PIPS_1_3",
    label: "主副 1+3",
    cells: 4,
    vertical: false,
    gridTemplateColumns: "1.9fr 1fr",
    gridTemplateRows: "1fr 1fr 1fr",
    focusSpanRows: 3,
    focusSlot: 0
  },
  {
    id: "STACK_4",
    label: "竖四屏",
    cells: 4,
    vertical: true,
    gridTemplateColumns: "1fr",
    gridTemplateRows: "1fr 1fr 1fr 1fr"
  }
];

export const DEFAULT_MULTIVIEW_LAYOUT: MultiviewLayoutId = "GRID_4";

export const MULTIVIEW_LAYOUT_STORAGE_KEY = "dtv_multiview_layout";

export function getLayoutDef(id: MultiviewLayoutId): MultiviewLayoutDef {
  return (
    MULTIVIEW_LAYOUTS.find((l) => l.id === id) ??
    MULTIVIEW_LAYOUTS.find((l) => l.id === DEFAULT_MULTIVIEW_LAYOUT) ??
    MULTIVIEW_LAYOUTS[0]
  );
}

export function loadStoredMultiviewLayout(): MultiviewLayoutId {
  if (typeof window === "undefined") return DEFAULT_MULTIVIEW_LAYOUT;
  try {
    const saved = window.localStorage.getItem(MULTIVIEW_LAYOUT_STORAGE_KEY);
    if (saved && MULTIVIEW_LAYOUTS.some((l) => l.id === saved)) {
      return saved as MultiviewLayoutId;
    }
  } catch {
    // ignore
  }
  return DEFAULT_MULTIVIEW_LAYOUT;
}

export function persistMultiviewLayout(id: MultiviewLayoutId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MULTIVIEW_LAYOUT_STORAGE_KEY, id);
  } catch {
    // ignore
  }
}

/** 一个多屏槽位承载的房间 */
export type MultiviewSlot = {
  platform: string;
  roomId: string;
} | null;

/**
 * 布局切换时的槽位保留规则：按格子编号顺序保留前 N 格房间。
 * 例：4 宫格 -> 双屏保留 1、2 号格；反向切换时新出现的格子为空占位。
 */
export function shrinkSlotsTo(slots: MultiviewSlot[], cells: number): MultiviewSlot[] {
  const next: MultiviewSlot[] = [];
  for (let i = 0; i < cells; i += 1) {
    const slot = slots[i] ?? null;
    next.push(slot && slot.roomId ? slot : null);
  }
  return next;
}
