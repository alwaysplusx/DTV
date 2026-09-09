# DTV 功能 TODO

> 按优先级/主题记录待开发功能。完成一项就把对应条目移到底部「已完成」并附 commit。

## 功能待办

### 1. 多屏直播（同屏播多个房间）— 开发中 (feat/multiview-layouts)
- 同一窗口内同时播放多个直播房间（网格/分屏布局）。
- 布局方案已定，详见 [docs/multiview-layouts.md](docs/multiview-layouts.md)（6 档：双屏 / 竖双屏 / 竖三屏 / 四宫格 / 主副 1+3 / 竖四屏；上限 4 路；不做 6/9 宫格、不做自动转置）。
- 进度：
  - [x] 布局模型 `web/src/components/player/multiview/layouts.ts`（布局定义 + `dtv_multiview_layout` 持久化 + 槽位保留规则）
  - [x] Rust 弹幕后端多实例：斗鱼/抖音/虎牙/B 站 stop 支持按房间（空 roomId = 全停），同平台多房间并发监听
  - [x] `PlayerCell` 可复用单格播放器（流获取/弹幕 overlay/音质线路控制/静音策略）
  - [x] `MultiViewGrid` 网格容器（布局选择器/空格占位/添加房间弹层/1+3 槽位交换/单格全屏）
  - [x] 多屏入口：单屏顶栏「多屏」按钮
  - [x] 运行验证：5 档布局切换+持久化、进入多屏带初始房间、添加房间、多路播放、音频策略（聚焦格有声）、单格全屏、1+3 槽位交换
  - [x] **多路代理冲突修复**：`StreamUrlStore` 改 `HashMap<session,url>` + 共享代理服务器按 `/live.flv/{session}` 路由；斗鱼/虎牙 helper 传 session，PlayerCell 卸载停本格代理。已验证 4 路斗鱼并发稳定、关闭任意格不影响其他格
- 遗留待定（见文档第八节）：音频策略细节、非焦点格降画质、拖拽分配（二期）、从关注栏拖入。—— 2026-08-23 决定暂不做。

### 2. 直播窗口中滚动鼠标调节音量
- 在直播画面上滚动滚轮调节该播放器音量（类似 B 站网页行为）。
- 注意与页面滚动的冲突处理：只在鼠标悬停于播放器区域时接管滚轮。
- ✅ 已实现：`useWheelVolume` hook（捕获阶段绑定 + 悬停命中判定，`preventDefault` 阻止页面滚动），MainPlayer 单屏 + PlayerCell 多屏按格生效；非焦点格保持"仅一格有声"策略只调数值，焦点格/单屏音量>0 取消静音（B 站行为）。

### 3. 关注列表状态自动刷新
- 关注列表（开播/下播状态）定时自动刷新，无需手动刷新。
- 进度：
  - [x] 轮询定时 5 分钟（`FOLLOW_AUTO_REFRESH_INTERVAL_MS`）
  - [x] 仅在窗口可见时刷新：监听 `document.visibilitychange`，隐藏时停止 interval，回到前台立即拉一次再起 interval
  - [x] 自动刷新走静默模式（`silent: true`），不打扰用户、不显示进度/对勾
  - [x] `refreshList` 增加 `silent` 参数，静默模式下跳过 `setIsRefreshing` / 进度 / 对勾的 UI 动画
  - [x] 间隔时间作为配置项：新增 `web/src/hooks/useFollowAutoRefreshInterval.ts`（预设 关闭/1/2/5/10/30 分钟 + localStorage 持久化 + custom event 通知）
  - [x] 设置菜单新增「关注列表自动刷新」入口 + 弹窗（`SettingsMenu.tsx`），右侧显示当前值
  - [x] 刷新引擎抽为应用级 `FollowRefreshProvider`：挂 AppShell 常驻外壳，不随侧栏折叠/路由卸载；定时器自校正调度防漂移；间隔事件监听与 visibilitychange 处理移入 Provider（原在 `FollowsList` 内的实现已迁出）；开播通知与刷新过程补运行日志

### 4. 关注的人开播桌面通知
- 监测关注主播开播，通过系统桌面通知提醒。
- 依赖：#3 的状态轮询；需去重（同一次开播只提醒一次）。
- 进度：
  - [x] 引入 `tauri-plugin-notification`（Rust）+ `@tauri-apps/plugin-notification`（JS）+ `notification:default` 权限
  - [x] 新增 `web/src/hooks/useLiveNotifications.ts`：监听 `follow.followedStreamers`，对比上一帧 LIVE 集合，新出现的 LIVE 触发通知
  - [x] 去重：首次进入只记录当前 LIVE 集合，不通知；同一主播开播→下播→再开播会重新通知
  - [x] 权限懒请求：首次触发通知时调用 `isPermissionGranted` / `requestPermission`，拒绝后静默
  - [x] 挂载到 `AppShell` 全局生效（侧栏折叠/路由切换不影响）
  - [x] Windows long-duration toast（约 25-30s）：插件 API 未暴露 duration，新增 `send_live_notification_cmd`（Rust `tauri-winrt-notification` 直发，`duration=long`）；dev 回退 PowerShell AUMID，安装版用 `com.dtv.app`；非 Windows 回退通知插件
  - [x] 点击通知 → 主窗口前置（unminimize+focus）+ emit `live_notif_click` + web `listen` → `playerOverlay.openPlayer` 单屏直达该主播（与关注列表点击一致）
  - [x] 运行验证：通知展示、long 时长、真实开播通知（非测试数据）、点击跳转全链路通过
- 已知边界：Windows 系统通知关闭时失败完全静默（`show()` 仍返回成功）——排查用 `ToastNotifier.Setting`（`DisabledForUser` = 系统设置拦截）；Win11 24H2 通知开关权威状态在 CloudStore，改旧注册表键无效，必须走设置 UI

### 5. 关注栏主列表取消关注
- 关注栏（侧边栏竖排列表）每个主播项增加取消关注入口。
- 现状：`FollowProvider.unfollowStreamer` 已存在；取关入口目前只在三处——overlay 弹层「管理」模式的 ×（`FollowsList.tsx` overlayDeleteMode）、单屏播放器关注按钮、Navbar 悬浮岛。**主列表项（`renderStreamerItem`）无任何取关交互**，点击只能打开播放。
- 方案待定：悬停显示 ×（同 overlay 风格）或右键菜单（可顺带容纳"移动到文件夹"等后续操作）。
- 进度：
  - [x] 主列表项取关交互 + 二次确认（强调色 pill 按钮 + 二次确认变红色「确认」按钮，3 秒未确认自动复位）
  - [x] 移除过渡动画：外层 m.div 加 `layout`/`initial`/`animate`/`exit`，外层 `AnimatePresence initial={false}` 包裹主列表；点击取关后整行 fade + height 收起，相邻项平滑上移
  - [x] 悬停高亮状态清理：取关触发后浏览器原生 mouseEnter/mouseLeave 自动联动（hoverHighlight 跟随鼠标），无需手动清理
  - [x] 按钮样式升级为强调色 pill（`--accent-gradient` + `accent-text` + `accent-glow` 阴影），二次确认采用红色破坏色渐变（约定俗成的删除确认样式）

### 6. 收藏分区页取消订阅
- `/custom/`（收藏分区）页的分区 chip 增加取消订阅入口。
- 现状：4 个平台首页分类栏已有「订阅分区/取消订阅」切换（`DouyuHomePage` 等的 `category-subscribe-btn`）；`CustomCategoriesProvider.removeByKey(key)` API 已存在。**收藏页的 chip 只能选中切换，无法就地取消订阅**，必须回到对应平台分类页操作。
- 进度：
  - [x] chip 上取消订阅交互：悬停/聚焦/选中态显示 × 按钮，点击调用 `removeByKey(entry.key)`（`CustomHomePage.tsx`）
  - [x] chip 结构：`<m.div>` 替代 `<m.button>`，可嵌套按钮；保持 keyboard 可达（`role=button`、`Enter`/`Space` 触发 select）
  - [x] 移除过渡动画：`AnimatePresence initial={false}` + `layout`/`initial`/`animate`/`exit`，其他 chip 平滑填补空位
  - [x] 选中态回退：依赖现有 `useEffect`（selectedKey 不在 entries 时选第一项），同时 sessionStorage 在下次 selectedKey 变更时自动刷新
  - [x] 跨页联动：`removeByKey` 直接改写 `dtv_custom_categories_v1` localStorage，平台首页 `isSubscribed` 实时计算 → 移除后自动回到「订阅分区」

#### 7. 日志迁移收尾（web console.* → logger）— 已放弃（2026-08-23，价值不大）
- 应用内日志查看本体已完成（2026-08-20，见「已完成」）：`tauri-plugin-log` 落盘（KeepSome(1) 滚动保留 1 份副本）+ web `logger` 经 IPC 转发统一落盘 + 设置 → 「运行日志」独立窗口（单例，可边操作应用边看日志；级别过滤/刷新/复制/二次确认清除）。
- 遗留收尾：
  - `web/src` 仍有约 80 处 `console.error/warn` 直调（24 个文件：player、各平台 helper、api 等）未走 `logger`，这些日志不落盘、日志窗口看不到。优先迁播放/弹幕排障路径（`player/constants.ts`、`danmuOverlay.ts`、`douyu/api.ts` 等 error/warn 热点）。
  - Rust panic 仍走 `eprintln!`，只进终端不进日志窗口。
  - 环境变量 `RUST_LOG` 不再生效（env_logger → 插件 builder 写死级别，tauri-plugin-log 无 env filter）；临时拉依赖日志级别需改 `logging.rs` 的 `level_for`。

## 其他待办

（暂无）

## 已完成

<!-- 完成的功能移到这里，格式：- YYYY-MM-DD feat 描述 (commit) -->

- 2026-08-18 feat(player) 直播画面滚轮调节音量（单屏+多屏按格生效，非焦点格保持静音策略）
- 2026-08-19 feat(follows) 播放房间与关注栏联动高亮（`useActiveRoom` 从 URL/overlay 读取当前房间，列表项 `data-active` 主题色强调；多屏模式不联动避免误导）
- 2026-08-19 feat(follows) 关注开播桌面通知（检测开播 transitions 逐条通知；Windows long-duration toast 约 25-30s + 点击通知前置窗口并直达单屏播放；非 Windows 回退通知插件）
- 2026-08-19 feat(follows) 关注栏主列表取消关注（悬停强调色 pill + 二次点击确认 3 秒复位 + AnimatePresence 移除动画）
- 2026-08-19 feat(custom) 收藏分区页取消订阅（chip 悬停/聚焦显示 × + 平滑移除动画 + 选中态回退 + 平台页订阅按钮联动）
- 2026-08-19 fix(follows) 文件夹悬停误显示全部子项取关按钮（文件夹外层移除 `.listItemWrapper`，`z-index:1` 移入 `.folderItem`）
- 2026-08-19 fix(follows) 关注列表强调色统一接入 `--accent` 变量体系（LIVE 状态点 #10b981 → `var(--accent)`；取关按钮绿 300/400 → accent/accent-hover；hover 昵称、激活头像光环、选中卡片的 rgba(34,197,94,…) 字面量改 `color-mix(var(--accent) N%, transparent)`）
- 2026-08-19 feat(multiview) 新增竖双屏布局 STACK_2（1fr 列 × 1fr 1fr 行上下两格）+ 布局选择器按格数由少到多排序（双屏/竖双/竖三/四格/1+3/竖四）；关注大面板卡片在多屏下接入槽位选择器（点击卡片弹选格替换，不再叠单屏；面板保持开启可连续替换）；顺手清理 MultiviewProvider 遗留死代码（pickerOpen/pickerPayload/openPicker/closePicker）
- 2026-08-19 fix(follows) 手动刷新关注列表不再弹开播桌面通知（`refreshList` 批次完成派发 `dtv_follow_refresh_completed` 事件携带终态 + notify 标志，通知 hook 改为消费事件做 diff，避开 suppression 标志与 React 异步 flush 的竞态；同时吸收新关注/重新关注主播，修掉「关注了正在直播的人被误报开播」；启动首轮刷新与定时/回前台自动刷新仍正常通知）
- 2026-08-19 fix(player) 快速连续切换直播间后播放停留在上一个房间、与关注栏高亮错位（`reloadStream` 在途互斥时 pending 重放误用自身旧闭包的 roomId，改为经 `reloadStreamRef` 取最新闭包；MainPlayer 与多屏 PlayerCell 同修；另 `useActiveRoom` 在 overlay 盖住 /player 路由时优先取 overlay 房间）
- 2026-08-19 feat(follows) 播放中房间头像光环呼吸效果（`avatarActiveBreath` 2.6s box-shadow 收放，CSS 变量驱动 keyframes 保留深/浅主题各自透明度；`prefers-reduced-motion` 时退回静态光环）
- 2026-08-20 feat(logs) 应用内运行日志（tauri-plugin-log 双目标 stderr+LogDir 落盘、5MB 滚动 KeepSome(1) 保留 1 份副本；web logger 经 IPC 转发统一落盘，`formatArg` 支持 Error；设置 → 「运行日志」**独立窗口**（Rust `open_log_window_cmd` 单例创建/前置，原生标题栏），`/logs/` 路由无外壳渲染 + 主题跨窗口跟随；2s 轮询单飞 + 代际守卫、级别过滤、复制、二次确认清除，read 优先 dtv.log 不足再拼滚动副本尾部，目录 NotFound 容错，清除失败显式报错）
- 2026-08-23 feat(shell) 折叠态左缘热区条（贯穿全高细线可点击开合侧栏，悬停联动高亮微可视把手；真全屏期间侧栏 portal 至全屏元素内以穿透 top layer）
- 2026-08-23 refactor(follows) 关注刷新引擎抽为应用级 `FollowRefreshProvider`（挂常驻外壳不随侧栏折叠/路由卸载；定时器自校正调度防漂移；开播通知与刷新过程补运行日志）
- 2026-08-24 feat(player) 独立直播间窗口（单屏播放器「独立窗口」按钮 → Rust `open_player_window_cmd` 每房间单例无边框沉浸窗（decorations=false，拖拽/最小化/最大化/关闭由播放器页内 UI 承担）；`/player-window/` 路由无外壳渲染，Providers 挂 Follow/PlayerUi/Multiview/VolumeToast 子集；OS 级关闭经 CloseRequested 拦截 → emit `dtv_player_window_close` → 前端清理后自销毁 + 3s 兜底强关；弹幕按房间精准 stop、FLV 代理每窗口独立 session（B 站命令新增 session 参数），多窗口互不顶掉；capabilities 加 `player-*`）
- 2026-08-24 fix(follows) 开播通知收敛为仅定时轮次触发（启动首轮/回前台补刷/手动刷新只吸收检测基线，`notify = reason === "timer"`）
