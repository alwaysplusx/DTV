# DTV — Agent 笔记

DTV 是基于 Tauri 2.0 的桌面客户端（Rust + Next.js），聚合斗鱼/虎牙/抖音/bilibili 直播。用户面向的信息见 `README.md`；本文件面向修改本仓库的 Agent。

## 目录结构

```
DTV/
├── web/                          ← Next.js 16 前端（实际 UI）
│   ├── src/app/                  App Router 页面（路由 ↔ 屏幕）
│   ├── src/components/           UI 组件（player/ 含单屏 + multiview + 音量 toast）
│   ├── src/platforms/            平台侧 payload 解析（web ↔ src-tauri/src/platforms/）
│   ├── src/state/                全局 React Context（theme / follow / multiview / volumeToast / playerUi / playerOverlay / customCategories）
│   ├── src/services/             lanSync、search 等 IPC 辅助
│   ├── src/screens/              各平台主页/播放器屏幕
│   ├── src/utils/                logger 等工具
│   ├── src/hooks/                useImageProxy、useWheelVolume 等
│   ├── src/data/                 静态数据（如分类定义）
│   ├── src/types/                跨模块共享类型
│   └── src/assets/               图片 / 字体等静态资源
│
├── src-tauri/                    ← Tauri 2 + Rust 后端
│   ├── src/main.rs               真正的桌面入口；register invoke_handler
│   ├── src/proxy.rs              actix-web：34721 图片代理常驻 + 34719 FLV 流代理按需
│   ├── src/platforms/            按平台分目录（douyu/douyin/huya/bilibili/common）
│   ├── build.rs                  prost-build 编 douyin.proto → 不可手编辑生成文件
│   ├── tauri.conf.json           devUrl / beforeDevCommand / frontendDist 等入口配置
│   ├── capabilities/default.json Tauri 权限白名单（最小；Web 端新增 Tauri API 前必先加权限）
│   └── keys/                     签名密钥（public 入库，private gitignore）
│
└── docs/                          文档：architecture.md（工作原理总览，含架构图）、multiview-layouts.md（多屏布局设计）、streamlink-notes.md（streamlink 对比与 B 站画质调研）
```

## Rust 命令注册

所有真正的 `#[tauri::command]` 都通过 `src-tauri/src/main.rs::main()` 的 `tauri::Builder::default()...invoke_handler(tauri::generate_handler![…])` 注册（2026-08 已清理早期 Vite + Vue 脚手架与模板遗留的 `lib.rs`，main.rs 是唯一入口）。**新增 Rust 命令必须追加到那个宏列表里**，否则 `web/` 侧 `invoke` 不到；反之删除命令时要同步摘除注册项。

## 命令

用户向的编译 / 安装 / 构建流程见 `README.md`「编译」章节（克隆项目、`protobuf` 安装、`pnpm install` / `pnpm tauri dev` / `pnpm tauri build` / 交叉编译 `--target aarch64-apple-darwin` 等）。本节仅列 Agent 修改本仓库时需要的检查 / 调试命令：

- **仅构建前端**：`pnpm -C web build` → `web/out/`（跳过 Rust / Tauri 打包，纯前端构建用）。
- **Web 类型检查**：`cd web && npx tsc --noEmit`（仓库内没有 ESLint/Prettier 配置）。
- **Rust 检查**：`cd src-tauri && cargo check`、`cargo clippy`（clippy 在 `rust-toolchain.toml` 中）。
- **依赖**：`pnpm install` 用 `pnpm-lock.yaml`，**不是** `package-lock.json`。
- **`web/` 与 `src-tauri/` 都没有测试用例**。不要跑 `pnpm test` / `cargo test` 期待有产物。
- **开发调试**：`pnpm tauri dev` 优先使用应用方式进行开发调试（注意：此命令为常驻命令，勿直接执行阻塞会话）
- **构建安装包**：`pnpm tauri build`

## 工具链与原生依赖

- `src-tauri/rust-toolchain.toml` 固定为 **nightly**，附带 `rustfmt` + `clippy`。不要降级到 stable —— `deno_core` 0.288（用于斗鱼直播流 URL 解密与抖音签名运行的嵌入式 JS 运行时）依赖 nightly 特性。
- `src-tauri/build.rs` 用 `prost-build` 编译 `src-tauri/src/platforms/douyin/danmu/douyin.proto`，生成 `src-tauri/src/platforms/douyin/danmu/gen/douyin.rs`，由 `gen/mod.rs` 的 `include!("douyin.rs")` 引入。**只改 `.proto` 然后重新构建，不要直接编辑 `gen/douyin.rs`**。
- macOS 构建在链接期通过 `-platform_version` 把二进制记录的 sdk 抬到 26.0（见 `build.rs` 内注释）：macOS 26 (Tahoe) 只对 sdk>=26 的二进制启用新版窗口控件，否则主窗口红绿灯保持旧样式（更小、色更实）。用 `otool -l <binary> | grep -A4 LC_BUILD_VERSION` 可验证 sdk 字段；不要删这段链接参数。
- 首次构建前需要的系统包：
  - **Windows**：`protoc`、Strawberry Perl、NASM（CI：`choco install protoc`；`choco install strawberryperl nasm -y`）。另外必须设置 `RUSTY_V8_ARCHIVE=https://github.com/denoland/rusty_v8/releases/download/v0.93.1/rusty_v8_release_x86_64-pc-windows-msvc.lib.gz`，让 MSVC 能拿到预编译的 `rusty_v8` 静态库。
  - **macOS**：`brew install protobuf pkg-config nasm`。Apple 的 `ld` 加载不了 Rust LTO bitcode —— `profile.release` 已固定 `lto = false`，本机裸跑 `pnpm tauri build` 即可；`build.yml` 的 macOS job 仍设 `CARGO_PROFILE_RELEASE_LTO=false` 作兜底（Windows/Linux CI 产物也随之不开 LTO）。
  - **Linux**：`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf protobuf-compiler pkg-config perl build-essential`。
- 根 `package.json#pnpm.onlyBuiltDependencies` 白名单里有 `core-js`、`esbuild`、`es5-ext`、`sharp`。新增其它原生依赖要显式加入白名单。

## Tauri 配置要点

- `src-tauri/tauri.conf.json`：`beforeDevCommand: pnpm -C web dev`，`devUrl: http://localhost:2896`，`beforeBuildCommand: pnpm -C web build`，`frontendDist: ../web/out`。端口 `2896` 在 `web/package.json`（`dev`/`start`）里硬编码。
- 默认窗口保持 `decorations: true`（macOS 红绿灯依赖此项）。Windows/Linux 构建把 `decorations` 改成 `false` 以无边框化 —— CI 用内联 PowerShell 在 `.github/workflows/build.yml`/`windows-build.yml` 中改写主配置；本地可直接用平台覆盖配置 `src-tauri/tauri.{windows,linux}.conf.json`（Tauri 会按平台自动选 overlay）。
- macOS 交通灯位是**多处联动的几何契约**，改任何一处都要同步：新版灯组（sdk>=26 样式，见 build.rs 链接参数）宽 60pt、按钮 14pt、间距 23，AppKit 原生默认左缘 9pt（HIG 不给坐标，这是系统自动排布的事实标准）；应用取 `trafficLightPosition: x=14` = (88−60)/2，灯组 14..74 在折叠迷你条内左右对称各 14px，故 `--sidebar-collapsed-width: 88px`（= 2x + 60，改 x 必须同步改栏宽），底部三键簇竖列锚点 `left:22` 在 88px 内居中（滑块基准 74/126、回收位移 52/104——收拢到锚点列后与锚点同 x，且横排/竖列两向都是 52 中心距 = 8px 间隙）；`FollowsRail.module.css` 的 `.railHeaderMac`（61px）兼做灯位与头像对齐：灯组 y=33 时纵向占 y24..38，且 61 + railScroll 上垫 12 = 折叠态首个头像顶 73，与展开态（followList 10 + 表头 48（=按钮行 44 + margin-top 4，FollowsList.headerActions 不可去掉该 margin）+ 间距 10 + 行边距 5 = 顶 73）同线；头像两态统一 44px、行距统一 56px（列表 44+2×5+gap 2，迷你条 44+gap 12），切换时各行头像零缩放零位移（`railScroll` **只能右垫 4px**：左缘对齐 20px 靠「左 0 + 右 4」把列中线压到 42，写成左右各 4 会让整列右移 2px、折叠瞬间头像重影）——改表头/上垫/行边距/头像尺寸/行距须同步；`legacy-global.css` 的 `.player-pin-pill`（置顶药丸，macOS 主窗口交通灯旁的置顶入口；播放窗顶栏与多屏栏另有不限平台的图钉按钮）`left:76` 紧跟灯组右缘 +2px，折叠态加 `player-pin-pill-hidden` 淡出（迷你条太窄会连成一串）。运行时挪灯不可行——tao 在每次 `drawRect` 都会按建窗时的 inset 重摆灯组，把外部改动弹回。
- NSIS/WiX 安装包强制本地化为 `zh-CN` / `SimpChinese`。
- 能力声明（`src-tauri/capabilities/default.json`）最小化：`core:default`、`opener:default`、`os:default`，外加少量窗口控制权限。**Web 端调用新的 Tauri API 前必须先在这里加权限**，否则 `invoke` 会被拒绝。

## Web（Next.js）约定

- `web/next.config.mjs` 上的几个"反常"项（理解动机前不要乱改）：
  - `output: "export"` —— Tauri 需要的静态导出。
  - `trailingSlash: true` —— 所有路由以斜杠结尾（`/douyin/`、`/player/`），导航/链接要对应。
  - `images: { unoptimized: true }` —— 静态导出必需。
  - **`reactStrictMode: false`** 是有意为之：StrictMode 会让 effect 跑两遍，导致同一个 IPC `invoke()` 在 dev 阶段被重复触发（重复请求 / 白页）。保持关闭。
- App Router 页面在 `web/src/app/`，路由与屏幕对应：
  - `/` → `DouyuHomePage`
  - `/douyin/`、`/huya/`、`/bilibili/`、`/custom/` → 对应屏幕
  - `/player/?platform=&roomId=` → `PlayerPage`（单房间播放；多屏入口在页面内）
- `/logs/` → 运行日志独立窗口页面（Rust `open_log_window_cmd` 按需创建单例 `logs` WebviewWindow；Providers/AppShell 对该路由降级为无外壳 + 仅主题）
- `web/src/platforms/{douyu,douyin,huya,bilibili,common}/` 与 `src-tauri/src/platforms/` 镜像。Web 侧负责解析/类型化 payload，Rust 侧负责抓取与解密。
- 全局状态用 React Context，集中在 `web/src/state/`（`theme`、`follow`、`customCategories`、`playerUi`、`playerOverlay`）。
- 日志：使用 `web/src/utils/logger.ts` 的 `logger`，不要直接 `console.*`；`debug` 在生产环境被屏蔽。
- `web/next-env.d.ts` 由 Next 自动生成并被 `.gitignore` 忽略；首次 `pnpm -C web dev` 后才会出现。
- 侧栏（`Sidebar.tsx`）的展开列表与折叠迷你条**两块面板常驻挂载**，折叠节拍（`railShown`）只切 `paneHidden`——不要改回条件渲染：卸载重挂会重建全部头像 `<img>` 并触发整列表进场动画，切换明显闪烁。**`paneHidden` 是硬切、没有 opacity/visibility 过渡**（曾用 180ms 交叉淡变，实测两块面板的位图在淡变中叠加，整列头像发白重影：对比度 46→35、约 150ms，就是收起/展开瞬间的“闪烁”）；硬切之所以看不出来，前提是两态头像逐像素对齐（见上条几何契约），残留差异只有第 7 格——未开播头像 ↔ 未开播计数按钮。`FollowsRail` 因此接收 `active` 并在隐藏时主动关闭 portal 到 body 的悬浮预览卡。（开合顿挫曾有 `web/src/utils/sidebarPerfProbe.ts` 探针，属临时工具。）

## 多屏功能

- 布局定义与槽位规则：`web/src/components/player/multiview/layouts.ts`。带图的文档：`docs/multiview-layouts.md`。
- 六档预设（选择器按格数由少到多排列）：`SPLIT_2`、`STACK_2`、`STACK_3`、`GRID_4`、`PIPS_1_3`、`STACK_4`。同时播放硬上限 4 路（WebView2 稳定性）。
- 持久化键：localStorage `dtv_multiview_layout`；侧边栏折叠 `dtv_sidebar_collapsed`；首跳闸门 `dtv_initial_route_custom_v1`。
- `src-tauri/src/proxy.rs` 用一个 `actix-web` 实例撑两个端口：
  - **`34721` 静态图片代理，常驻** —— 给斗鱼/B 站那些 referer-  / cookie- 校验的图片源加 Referer/Cookie Header，避免 WebView 直连 403。
  - **`34719` FLV 直播流代理，按需起** —— 多屏流路由依赖 `StreamUrlStore`（`HashMap<session, url>`）：每个 `PlayerCell` 拿到自己的 session，共享代理按 `/live.flv/{session}` 转发。停掉一个 cell → 该 cell 的代理条目被清除；最后一个 session 也移除时整代理服务停掉。

## 其它值得知道

- 注释克制：非必要不添加注释。只写解释"为什么"和外部不可见约定（踩坑、API 陷阱）的注释，不复述代码字面能看出的东西。
- 用户可见文案全部为 zh-CN，保持中文。代码注释中英混合，编辑时保留。
- CI 在 tag 模式 `v*.*.*`、`*.*`、`*.*.*` 或 `workflow_dispatch` 触发发布；发布用 `tauri-apps/tauri-action@v0`；签名密钥在 `src-tauri/keys/`（`public.key` 入库，`private.key` 被 `.gitignore`）。
- 没有 pre-commit 钩子，也没有 lint CI 步骤 —— 根目录与 `web/` 都没有 ESLint/Prettier 配置。
- 拿不准时以可执行的源文件为准：`pnpm-workspace.yaml`、`web/next.config.mjs`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/build.rs`、`src-tauri/rust-toolchain.toml`。配置文件 > 文字说明。

## 观看统计（watch stats）功能

按主播/平台/日的观看时长统计，三层全做（会话记录 + 聚合展示 + 开播事件）。

- 存储：Rust 侧 JSON 文件（`app.path().app_data_dir()/watch-history.json`），走 `src-tauri/src/watch_stats.rs` 三个命令 `read_watch_stats_cmd` / `append_watch_session_cmd` / `append_watch_event_cmd`（**均已注册到 `main.rs::invoke_handler!`**，新增同类命令同理）。读写用模块级 `Mutex` 串行化。会话结构见 `src-tauri/src/watch_stats.rs::WatchSession` / `WatchEvent` / `WatchHistory`。
- 计时挂点：`web/src/hooks/useWatchTracker.ts` 挂在 `MainPlayer`（单屏，`enabled: !isMultiview`）与 `PlayerCell`（`multiviewSlot` 由 `MultiViewGrid` 透传 `index`）；cleanup 时若曾成功播放（`played` 锁存）记入 `playing`，否则 `offline_visit`。时长以首次 played 起算。
- 前端读取：内存缓存 + 订阅在 `web/src/services/watchStatsStore.ts`（append 时乐观更新 cache 并通知订阅者），由 `web/src/state/watchHistory/WatchHistoryProvider.tsx` 注入两套 Providers（主路由 + 独立直播间窗口）。`useWatchHistory()` 取 `history`。
- 聚合工具：`web/src/utils/watchStats.ts` 的 `aggregateByStreamer` / `aggregateByPlatform` / `aggregateByDay` / `aggregateByRange`（时间窗）/ `getRangeWindow`（预设今日/本周/本月/自定义）/ `formatDuration`（hh:mm:ss）。**双口径**：`totalSeconds` 为加法口径（多屏同时播放按倍数计，每格独立会话求和）；`netSeconds`（DayAggregate/RangeAggregate 均有）为墙钟净时间——播放区间重建为 `[endedAt-seconds*1000, endedAt]` 裁剪到窗口后合并求并集，重叠时段只算一次。按主播统计仅加法口径（各自真实播放时长）。
- 展示：`/stats/` 路由 = **独立统计窗口**（Rust `open_stats_window_cmd` 单例 `stats` 窗口，原生标题栏，可带 `?streamer=平台:房间号` 聚焦单主播；Providers/AppShell 对该路由降级为无外壳 + 主题 + WatchHistory）。入口：设置菜单「观看统计」、关注列表右键「查看观看统计」（均 invoke 命令开窗，不再应用内跳转）。窗内点主播行经 `open_player_in_main_cmd`（Rust 前置主窗口 + 广播 `dtv_open_player_request`）转主窗口打开播放 overlay。侧栏「已看 X」与播放器 topbar HUD 已按需求移除（采集照常，仅去展示）。主视图含 `YearHeatmap` 近 365 天观看强度热力图（GitHub 贡献图样式，周一为周起点，4 级 accent 绿派生色阶——两主题色阶均经 dataviz 校验器 ordinal 模式通过，见 YearHeatmap.module.css）；摘要卡并列「累计观看时长 / 净观看时长」（多屏重叠时净 < 累计），热力图 tooltip 同日有重叠时附「（净 X）」。统计窗是独立进程，主窗口产生的会话不会推到这里：获焦/可见时自动 `readWatchHistory()` 重读磁盘，另在页面顶部有手动刷新按钮。
- P4 时间窗 UI：四个 Tabs（今日/本周/本月/自定义）+ 直条图（原生 SVG-style CSS，按小时/日/周/月动态粒度）+ 点击某直条切到该时段主播排行 + 自定义日期区间。
- 开播事件：关注刷新 `FOLLOW_REFRESH_COMPLETED_EVENT` 从 非LIVE→LIVE 跳变时由 `WatchHistoryProvider` 记一条 `live_start_observed`，`approx: true`（平台接口未透出精确开播时间，UI 标"约"；后续可由 B 站 `room_info.live_time` / 抖音 raw room JSON `start_time` 改为精确）。首轮（含整页重载后）只吸收基线不记录，避免冷启动把所有在播主播刷成开播。
- 关窗结清：窗口销毁时 React cleanup 不执行，`useWatchTracker` 用模块级注册表暴露 `flushActiveWatchTrackers()`；主窗口 CloseRequested 被 Rust 拦截发 `dtv_main_close_requested`（3s 兜底强关），`MainWindowCloseGuard`（Providers 主分支）结清会话等落盘后 ack `confirm_main_close_cmd` 再销毁；独立播放窗口关闭链（MainPlayer standalone listener）同样先 flush 再 destroy。
- 临时文件提示：watch-history.json 不在 LAN 同步白名单（`LAN_SYNC_KEYS`），如需跨设备同步要单独加。