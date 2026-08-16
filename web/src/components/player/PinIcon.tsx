// 窗口置顶图钉图标（macOS 交通灯旁 / Win/Linux 右上窗口控制区共享）。
// 已激活 filled=true：垂直插入的实心推钉（蓝色，由 currentColor 控制）——稳定 / 固定。
// 未激活 filled=false：倾斜悬空的推钉描线（灰色，由 currentColor 控制）——未锁定 / 自由。
// 颜色由外层容器（.player-pin-pill / .window-btn--pin）经 color/currentColor 控制。
// 不加 CSS/SVG 光晕：此前 3.4 宽暗色描边叠在 1.7 灰线上，是“灰边太粗”的根因；
// 去掉后仅留干净细描边，小尺寸下更清晰。
const PIN_BODY =
  "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z";
const PIN_NEEDLE = "M12 17v5";

export function PinIcon({ filled }: { filled: boolean }) {
  if (filled) {
    // 已激活：垂直、实心填充
    return (
      <svg viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d={PIN_BODY} fill="currentColor" stroke="currentColor" strokeWidth="1.4" />
        <path d={PIN_NEEDLE} stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  // 未激活：倾斜 ~40° 悬空、干净细描线
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g transform="translate(12 12) rotate(40) scale(0.9) translate(-12 -12)">
        <path d={`${PIN_BODY} ${PIN_NEEDLE}`} />
      </g>
    </svg>
  );
}
