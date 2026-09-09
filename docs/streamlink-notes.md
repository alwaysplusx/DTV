# Streamlink 研读与 B 站画质调研笔记

> 记录日期：2026-08-23。起因：研读 [streamlink](https://github.com/streamlink/streamlink) 各平台插件，确认「平台间差异是否会迫使 DTV 采用不同播放器」；随后用真实 API 对照实验查证 B 站拉流方案与清晰度的关系，过程中推翻了我们此前的一个认知（见第四节）。
>
> 结论要点已并入 [`architecture.md`](./architecture.md) §5.4 / §5.5，本文保留完整证据链。

## 一、背景与方法论纠正

- streamlink 的平台实现在 `src/streamlink/plugins/*.py`；`src/streamlink_cli/utils/` 只是 CLI 基建（参数解析、进度条、播放器启动），不含任何平台逻辑。
- **架构定位差异**：streamlink 是「拿地址 → 交给外部播放器（mpv/VLC 等 ffmpeg 系）」，它只把流分类为 HTTPStream（渐进式 FLV）/ HLSStream / DASHStream，容器差异由外部播放器消化，所以平台形态差异对它几乎无感。DTV 是 WebView + MSE 内嵌播放，**容器形态直接决定前端 JS 引擎**（FLV → xgplayer-flv，HLS → xgplayer-hls.js）。因此「streamlink 不在乎的差异」对 DTV 可能致命，反之亦然。

## 二、四平台插件对比（master @ 2026-08）

| 平台 | 地址获取方式 | 流形态 | 必需请求头 | 关键备注 |
|---|---|---|---|---|
| **斗鱼** `douyu.py` | `getEncryption` 接口下发 key/rand_str → `_compute_auth` **本地 MD5 链迭代**算 auth → POST `getH5PlayV1` | 仅 FLV (HTTPStream) | 仅 `Referer: https://www.douyu.com/` | **全程不执行混淆 JS**；DID 常量与 DTV 完全一致（`10000000000000000000000000001501`）；`hevc=0` 固定 |
| **虎牙** `huya.py` | 房间页 HTML 抓 `hyPlayerConfig`（base64/JSON 双格式兼容）→ anti_code 本地算法拼 FLV | 仅 FLV | `Origin`/`Referer: www.huya.com` | anti_code 与 DTV/pure_live 同源算法（fm 盐解 base64、md5(seqid\|ctype\|t)、uid 循环左移 8 位）；常量 `t=100, ver=1, sv=2401090219, codec=264` |
| **抖音** `douyin.py` | 直播页 SSR state（`self.__pace_f.push`）正则抓 `flv_pull_url` | 仅 FLV（强制 https） | 无特殊头 | cookie 只需一个**随机** `__ac_nonce`（uuid hex），完全绕开 a_bogus 签名；无视 `hls_pull_url_map` |
| **B 站** `bilibili.py` | 双源：v1 `Room/playUrl(platform=web, quality=4)` 出 **FLV durl**；页面 `__NEPTUNE_IS_MY_WAIFU__` / v2 `getRoomPlayInfo` 过滤出 **HLS**（schema 显式只留 `http_hls` 协议 + fmp4/ts 格式 + **avc 编码**） | **FLV + HLS 双形态** | 无 | `stream_weight` 中 httpstream 权重 4 > hls 权重 2，即**优先选 FLV**；HEAD 预检 durl 可用性；**无任何 cookie 机制** |

### 核心结论：差异分两层，只有一层影响播放器

1. **地址获取层差异**（签名方式、接口、协议、头要求）：四家天差地别，但这层只决定「URL 怎么拿到」，与播放器选型无关。DTV 已各自实现对应方案。
2. **流形态层差异**（FLV vs HLS）：这才是播放器选型的唯一决定因素。斗鱼/虎牙/抖音三家完全收敛于 FLV → 共用 xgplayer-flv + 本地代理一套管线；唯一有第二形态的是 B 站。

另注意一个架构性差异：streamlink 以 CLI 进程身份发请求（requests 库可带任意头），所以不需要本地代理；DTV 是 WebView 里 `<video>` 发流媒体请求才被迫加代理。「需要代理」不是某平台的特性需求，别误读。

## 三、B 站实测：拉流方案不决定清晰度，登录态才决定

测试条件：2026-08-23，直播间 `1829181560` 在播，匿名 curl（带 UA + Referer，无 cookie）。

### 3.1 对照矩阵

| 方案 | 参数组合 | 服务端实际交付 `current_qn` |
|---|---|---|
| DTV 路径 (v2 getRoomPlayInfo) | `platform=html5&codec=0` 不传 qn | **250（超清）** |
| DTV 路径 | `platform=html5&codec=0&qn=10000`（请求原画） | **250** |
| （对照） | `platform=web&codec=0&qn=10000` | **250** |
| streamlink v2 兜底源 | `platform=web&qn=0&protocol=0,1&format=0,1,2&codec=0,1,2` | **250** |
| streamlink v1 主源 | `playUrl?cid=&platform=web&quality=4` | **250**（durl 文件名 `_2500.flv` 码率档吻合） |

**匿名状态下无论怎么请求，服务端一律降档到 250**。请求 qn=10000 不会报错也不会生效。

### 3.2 官方清晰度命名表（来自响应 `g_qn_desc` 实测）

```
30000:杜比  20000:4K  15000:2K  10000:原画  400:蓝光  250:超清  150:高清  80:流畅
```

avc 编码下该房间 `accept_qn = [10000, 400, 250]`——没有通往官方「高清(150)/流畅(80)」的路径。

### 3.3 推论

- 清晰度的唯一杠杆是**有效登录 cookie（SESSDATA）**，服务端按账号权益交付更高档位。
- DTV 支持从 WebView 提取 `bilibili_cookie` 注入请求，上限高于 streamlink；streamlink 插件完全没有 cookie 机制，永远锁死匿名上限。
- 本机验证：DTV 运行日志中 `Cookie header set` 出现 0 次——**当前使用环境下 B 站画质上限就是超清 250**，UI 上写「原画」也只是请求值而非交付值。

## 四、运行时反转：DTV 的 B 站一直在走 FLV，不是 hls.js

此前的认知（含一度写入 architecture.md 的版本）是「B 站日常几乎总落在 xgplayer-hls.js 上」，依据是 git 考古（见下）。**运行日志推翻了它**：

- `%LOCALAPPDATA%/com.dtv.app/logs/dtv.log` 中 2026-08-20 ~ 08-23 的 B 站会话记录共 9 条，全部是 `Attempt 1 obtained FLV stream ... stop retrying`，无一例 HLS。
- 今日 API 实测：`platform=html5` 下同样返回 `http_stream/flv` 候选，且 `codec=0` 时与 `platform=web` 响应一致（web 仅在放开 `codec=0,1,2` 时多 hevc/av1 项）。

历史脉络还原：

```
dc9be86  优化B站播放器逻辑，优先使用M3U8地址        ← 最初 HLS 优先
13dfc3a  强制使用 FLV…「拒绝使用 HLS」（2025-10）   ← 统一到 FLV+代理管线的尝试
b8231e1  修复b站部分直播间无法播放（2025-11）       ← 当时 html5 不发 FLV，强制策略翻车，重写为双分支
（现在）  API 行为再度漂移：html5 又发 FLV 了        ← 「FLV 优先」逻辑每次第一击命中，hls.js 沦为保险
```

教训：

1. **B 站 API 的流形态行为随时间漂移**（约一年内至少翻转两次），双分支 + 探测验证的设计是对的，不要删任何一支。
2. 对「某平台只能怎样」的断言要标时间戳、以可复现实测为准；git 考古得出的「现状」可能是过时现状。

## 五、顺带发现的两个产品级问题

1. **清晰度文案错位一档**：`match_qn` 把 UI「高清」映射到 400（官方叫**蓝光**）、「标清」映射到 250（官方叫**超清**）。用户拿到的画质不吃亏，但标签与官方命名错位；且 avc 下没有路径到达官方「高清/流畅」低档。
2. **`current_qn` 不可观测**：代码未解析、未记录响应中的 `codec[].current_qn`，「请求的档位 vs 实际交付档位」是否一致无从判断。建议补一行 info 日志，排查画质问题时能立刻分辨「没请求到」还是「被降档」。
3. **日志级别语义倒挂**：`bilibili/stream_url.rs` 里大量调试性打印（qn_map、Cookie header set、分支命中结果等）用的都是 `log::error!`——运行日志窗口满屏 ERROR 不代表出错。排查时按内容关键字 grep 比按级别过滤可靠；长期看这批打印应降级为 debug/info。

## 六、对 DTV 的机会点（按价值排序，均未验证）

1. **斗鱼去 JS 化候选**：streamlink 新流程（`getEncryption` + `_compute_auth` 纯 MD5 迭代）完全不执行混淆 JS，DID 常量与我们一致。若实测稳定，斗鱼侧可摘掉 deno_core，规避「服务端换混淆脚本就全线挂」的脆弱性。（deno_core 仍需保留给抖音弹幕 sign.js。）注意 `getEncryption` 可能有 web 端风控差异，需灰度验证。
2. **抖音备选路径**：随机 `__ac_nonce` 抓 SSR state 即得全清晰度 `flv_pull_url`，可作为 a_bogus 逆向失效时的退路。
3. **HEVC 共同坑佐证**：streamlink B 站 schema 过滤 avc-only、斗鱼固定 `hevc=0`、虎牙硬编码 `codec=264`——三方项目集体回避 HEVC，印证 DTV 在 WebView2 上打 `hev1→hvc1` monkey patch 是补同一个坑，方向正确。
4. **维持 v2 单 URL 的理由**：v1 `playUrl` 返回分段 durl（实测 count=2），外部播放器顺序播没问题，内嵌 MSE 播放器则需额外的段间续播处理——不值得抄。
5. **TLS 冷知识备查**：streamlink 为斗鱼部分 CDN 域名挂了 SECLEVEL1 adapter（OpenSSL 3 默认 SECLEVEL=2 握手失败、以及带下划线域名的证书校验问题，douyu.py 头部注释）。Rust reqwest 不走 OpenSSL 大概率无感，但若将来某条斗鱼 CDN 线路莫名连不上，先想起这条。
6. **待验证——HLS 兜底分支的防盗链机制**：MainPlayer 的 hls 配置同时传了 `fetchOptions.referrer` 和 `xhrSetup` 里 `setRequestHeader("Referer", …)`；后者按 Fetch 规范属 forbidden header，浏览器会静默拒设（代码 try/catch 吞掉），前者是否生效取决于 xgplayer-hls.js 底层走 fetch 还是 XHR loader。HLS 分支当前处于休眠态（FLV 总是第一击命中），若未来 API 再翻转、HLS 成为主力，需要先实测 Referer 到底有没有带上。

## 附：复现命令

```bash
# 找在播房间
curl -s 'https://api.live.bilibili.com/room/v1/Room/room_init?id=<rid>' -H 'UA' | jq .data.live_status   # 1=直播中

# DTV 路径（对照 streamlink 路径换 platform/qn/codec 组合即可）
curl -s 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=<rid>&protocol=0,1&format=0,1,2&codec=0&platform=html5&qn=10000&dolby=5'

# streamlink v1 主源
curl -s 'https://api.live.bilibili.com/room/v1/Room/playUrl?cid=<rid>&platform=web&quality=4'

# 关注字段：data.playurl_info.playurl.stream[].format[].codec[] 下的 current_qn / accept_qn
#          playurl.g_qn_desc（全量命名表）；v1 则是 data.current_qn / data.durl

# 本机运行日志（分支命中证据）
grep "obtained FLV\|Selected HLS" "$LOCALAPPDATA/com.dtv.app/logs/dtv.log"
```
