// 在开发模式下允许控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest;
use std::collections::HashMap;
use std::env;
use std::panic;
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
mod lan_sync;
mod logging;
mod platforms;
mod proxy;
mod sync_transfer;
mod version_check;
mod watch_stats;
use platforms::common::{DouyinDanmakuState, FollowHttpClient, HuyaDanmakuState};
use platforms::douyin::danmu::signature::generate_douyin_ms_token;
use platforms::douyin::fetch_douyin_partition_rooms;
use platforms::douyin::fetch_douyin_streamer_info;
use platforms::douyin::{get_douyin_live_stream_url, get_douyin_live_stream_url_with_quality};
use platforms::douyin::{start_douyin_danmu_listener, stop_douyin_danmu_listener};
use platforms::douyu::fetch_categories;
use platforms::douyu::fetch_douyu_room_info;
use platforms::douyu::fetch_three_cate;
use platforms::douyu::{fetch_live_list, fetch_live_list_for_cate3};
use platforms::huya::stop_huya_danmaku_listener;
use platforms::huya::{fetch_huya_live_list, start_huya_danmaku_listener};
// use platforms::huya::get_huya_stream_url_with_quality; // removed in favor of unified cmd

#[derive(Default, Clone)]
pub struct StreamUrlStore {
    /// session key -> 上游流 URL。多屏场景下每个格子用自己的 session，互不干扰。
    pub url: Arc<Mutex<HashMap<String, String>>>,
}

// State for managing Douyu danmaku listener handles (stop signals), multi-room capable.
// 斗鱼弹幕注册表：room_id -> 共享监听条目（stop sender + 窗口引用计数）。
// 跨窗口同房间共享一条连接，start 计数、stop 减计数、归零才真停。
#[derive(Default, Clone)]
pub struct DouyuDanmakuHandles(
    Arc<Mutex<platforms::common::DanmakuStopSignals<tokio::sync::mpsc::Sender<()>>>>,
);

#[tauri::command]
async fn get_stream_url_cmd(room_id: String) -> Result<String, String> {
    // Call the actual function to fetch the stream URL from the new location
    platforms::douyu::get_stream_url(&room_id, None)
        .await
        .map_err(|e| {
            log::error!(
                "[Rust Error] Failed to get stream URL for room {}: {}",
                room_id,
                e.to_string()
            );
            format!("Failed to get stream URL: {}", e.to_string())
        })
}

#[tauri::command]
async fn get_stream_url_with_quality_cmd(
    room_id: String,
    quality: String,
    line: Option<String>,
) -> Result<String, String> {
    platforms::douyu::get_stream_url_with_quality(&room_id, &quality, line.as_deref())
        .await
        .map_err(|e| {
            log::error!(
                "[Rust Error] Failed to get stream URL with quality {} for room {}: {}",
                quality,
                room_id,
                e.to_string()
            );
            format!("Failed to get stream URL with quality: {}", e.to_string())
        })
}

// Legacy Huya stream URL command removed in favor of unified command

// This is the command that should be used for setting stream URL if it interacts with StreamUrlStore
#[tauri::command]
async fn set_stream_url_cmd(
    session: Option<String>,
    url: String,
    state: tauri::State<'_, StreamUrlStore>,
) -> Result<(), String> {
    let key = session.unwrap_or_default();
    let mut store = state.url.lock().unwrap();
    if url.is_empty() {
        store.remove(&key);
    } else {
        store.insert(key, url);
    }
    Ok(())
}

// Command to start Douyu danmaku listener
#[tauri::command]
async fn start_danmaku_listener(
    room_id: String,
    window: tauri::Window,
    danmaku_handles: tauri::State<'_, DouyuDanmakuHandles>,
) -> Result<(), String> {
    // 引用计数共享：同窗口重复 start 先释放旧引用（保持重启语义）；
    // 跨窗口同房间复用现有连接，互不误停。
    let (need_spawn, stale_tx) = {
        let mut lock = danmaku_handles.0.lock().unwrap();
        let stale_tx =
            platforms::common::release_danmaku_room(&mut lock, &room_id, window.label());
        let need_spawn = platforms::common::acquire_danmaku_room(&mut lock, &room_id, window.label());
        (need_spawn, stale_tx)
    };
    if let Some(tx) = stale_tx {
        let _ = tx.send(()).await;
    }
    if !need_spawn {
        return Ok(());
    }

    let (stop_tx, stop_rx) = tokio::sync::mpsc::channel(1);
    {
        let mut lock = danmaku_handles.0.lock().unwrap();
        platforms::common::register_danmaku_stop_tx(&mut lock, &room_id, stop_tx.clone());
    }

    let window_clone = window.clone();
    let room_id_clone = room_id.clone();
    // State 借用不能跨 'static spawn：取内部拥有的句柄克隆（Arc 共享同一注册表）
    let handles_for_cleanup = danmaku_handles.inner().clone();
    let room_id_for_cleanup = room_id.clone();
    let tx_for_guard = stop_tx.clone();
    tokio::spawn(async move {
        let mut client = platforms::douyu::danmu_start::DanmakuClient::new(
            &room_id_clone,
            window_clone,
            stop_rx, // Pass the receiver part of the stop channel
        );
        if let Err(e) = client.start().await {
            log::error!(
                "[Rust Main] Douyu danmaku client for room {} failed: {}",
                room_id_clone,
                e
            );
        }
        // 任务退出后兜底清理注册表（正常 stop 路径已被 release 移除）。
        // 条目已换成新实例（same_channel 不符）时不动作，防误删。
        let mut lock = handles_for_cleanup.0.lock().unwrap();
        let is_ours = lock
            .get(&room_id_for_cleanup)
            .and_then(|room| room.stop_tx.as_ref())
            .map(|tx| tx.same_channel(&tx_for_guard))
            .unwrap_or(false);
        if is_ours {
            lock.remove(&room_id_for_cleanup);
        }
    });

    Ok(())
}

// Command to stop Douyu danmaku listener
#[tauri::command]
async fn stop_danmaku_listener(
    room_id: String,
    window: tauri::Window,
    danmaku_handles: tauri::State<'_, DouyuDanmakuHandles>,
) -> Result<(), String> {
    // `room_id` 为空 = 停止该窗口全部；否则只减该窗口引用，归零才真停（跨窗口共享连接）。
    let senders = {
        let mut lock = danmaku_handles.0.lock().unwrap();
        if room_id.is_empty() {
            platforms::common::release_all_danmaku_rooms(&mut lock, window.label())
        } else {
            platforms::common::release_danmaku_room(&mut lock, &room_id, window.label())
                .into_iter()
                .collect()
        }
    };
    let mut had_error = false;
    for sender in senders {
        if sender.send(()).await.is_err() {
            had_error = true;
        }
    }
    if had_error {
        // receiver dropped = listener already exited; not a fatal error for multi-room semantics
        log::error!(
            "[Rust Main] Some Douyu danmaku stop signals failed (listener may have exited): room {}",
            room_id
        );
    }
    Ok(())
}

// search_anchor seems fine, assuming douyu::search_anchor is correct
#[tauri::command]
async fn search_anchor(keyword: String) -> Result<String, String> {
    platforms::douyu::perform_anchor_search(&keyword)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_default_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL is empty.".to_string());
    }
    app.opener()
        .open_url(trimmed, None::<String>)
        .map_err(|e| e.to_string())
}

// 开播通知：Windows 用 long-duration toast（约 25-30s，插件 API 未暴露 duration）；
// dev 下无 AUMID 快捷方式，回退 PowerShell AUMID（与插件行为一致）；
// 点击通知 → emit live_notif_click 事件 + 主窗口前置，web 侧导航到单屏播放
#[cfg(windows)]
#[tauri::command]
async fn send_live_notification_cmd(
    app: tauri::AppHandle,
    title: String,
    body: String,
    platform: String,
    room_id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    use tauri::Manager;

    let app_id = if tauri::is_dev() {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID
    } else {
        app.config().identifier.as_str()
    };

    let click_app = app.clone();
    let click_platform = platform.clone();
    let click_room_id = room_id.clone();

    tauri_winrt_notification::Toast::new(app_id)
        .title(&title)
        .text1(&body)
        .duration(tauri_winrt_notification::Duration::Long)
        .on_activated(move |_action| {
            // 点击主体（无按钮时唯一激活方式）→ 前置窗口 + 通知前端打开单屏播放
            let _ = click_app.emit(
                "live_notif_click",
                serde_json::json!({ "platform": click_platform, "roomId": click_room_id }),
            );
            if let Some(win) = click_app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .show()
        .map_err(|e| {
            log::error!("[live-notif] toast failed: {} -> {:?}", title, e);
            e.to_string()
        })
}

#[cfg(not(windows))]
#[tauri::command]
async fn send_live_notification_cmd(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}

// 打开「独立直播间」窗口（每房间单例）。与 logs 窗口同模式：Rust 侧创建绕开
// webview capability 白名单；必须 async（同步命令在事件循环上执行 build() 会自死锁）。
// 沉浸模式：decorations=false，无系统标题栏；拖拽/窗口控制由播放器页内 UI 承担。
#[tauri::command]
async fn open_player_window_cmd(
    app: tauri::AppHandle,
    platform: String,
    room_id: String,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let platform = platform.trim().to_lowercase();
    if !matches!(platform.as_str(), "douyu" | "douyin" | "huya" | "bilibili") {
        return Err(format!("unsupported platform: {platform}"));
    }
    // label 只允许安全字符（room_id 来自各平台，可能是数字或含连字符的 id）
    let sanitize = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect()
    };
    let room_id = room_id.trim().to_string();
    if room_id.is_empty() {
        return Err("empty room id".into());
    }
    let label = format!("player-{}-{}", sanitize(&platform), sanitize(&room_id));

    let focus_existing = |win: &tauri::WebviewWindow| {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    };
    if let Some(win) = app.get_webview_window(&label) {
        focus_existing(&win);
        return Ok(());
    }

    let url = format!("player-window/?platform={platform}&roomId={}", urlencode(&room_id));
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(format!("直播间 {room_id}"))
        .inner_size(1104.0, 660.0)
        .min_inner_size(640.0, 400.0)
        .decorations(false)
        .build();
    match built {
        Ok(_) => Ok(()),
        // 并发创建同一 label：第二个失败时前置已建窗口即可
        Err(e) => {
            if let Some(win) = app.get_webview_window(&label) {
                focus_existing(&win);
                Ok(())
            } else {
                Err(format!("create player window failed: {e}"))
            }
        }
    }
}

// 主窗口关闭 ack：前端结清观看会话落盘后调用，真正关闭主窗口（destroy 绕过
// CloseRequested 拦截；最后一个窗口销毁时应用随之退出）。async：与其它窗口命令一致。
#[tauri::command]
async fn confirm_main_close_cmd(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        win.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 打开「观看统计」独立窗口（单例，可带 ?streamer=平台:房间号 直接聚焦主播）。
// logs 窗口同模式；必须 async（同步命令在事件循环上执行 build() 会自死锁）。
#[tauri::command]
async fn open_stats_window_cmd(app: tauri::AppHandle, streamer: Option<String>) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    const LABEL: &str = "stats";

    let focus_existing = |win: &tauri::WebviewWindow| {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    };

    if let Some(win) = app.get_webview_window(LABEL) {
        focus_existing(&win);
        return Ok(());
    }

    let url = match streamer.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => format!("stats/?streamer={}", urlencode(s)),
        None => "stats/".to_string(),
    };
    let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(url.into()))
        .title("观看统计")
        .inner_size(980.0, 700.0)
        .min_inner_size(560.0, 420.0)
        .build();
    match built {
        Ok(_) => Ok(()),
        Err(e) => {
            if let Some(win) = app.get_webview_window(LABEL) {
                focus_existing(&win);
                Ok(())
            } else {
                Err(format!("create stats window failed: {e}"))
            }
        }
    }
}

// 统计窗口点主播行：前置主窗口并广播打开播放请求（主窗口 PlayerOverlayProvider 接住）
#[tauri::command]
async fn open_player_in_main_cmd(
    app: tauri::AppHandle,
    platform: String,
    room_id: String,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    app.emit(
        "dtv_open_player_request",
        serde_json::json!({ "platform": platform, "roomId": room_id }),
    )
    .map_err(|e| e.to_string())
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// Main function corrected
fn main() {
    panic::set_hook(Box::new(|info| {
        // panic 保持裸 eprintln：logger 初始化前的早期崩溃也要直达 stderr
        eprintln!("[panic] {}", info);
    }));
    // Create a new HTTP client instance to be managed by Tauri
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
        .http1_only()
        .connect_timeout(Duration::from_secs(15))
        .no_proxy()
        .timeout(Duration::from_secs(45))
        .build()
        .expect("Failed to create reqwest client");
    let follow_http_client = FollowHttpClient::new().expect("Failed to create follow http client");

    tauri::Builder::default()
        .plugin(logging::build_plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .on_window_event(|window, event| {
            // 独立播放器窗口：拦截 OS 级关闭（Alt+F4/任务栏），先通知前端清理
            // 弹幕连接与 FLV 代理 session，前端处理完自行 destroy；3s 兜底强关，
            // 防止页面加载失败时窗口无法关闭。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label().starts_with("player-") {
                    use tauri::Emitter;
                    api.prevent_close();
                    // 只通知本窗口清理。Tauri v2 任意 WebviewWindow::emit 都是全局广播（manager 层打到所有窗口），
                    // 广播关闭事件会让其它独立直播窗口也执行清理并 self-destroy（停播/黑屏残留）；须 emit_to 本窗
                    // label，且前端监听以同样 label 限定 target，两侧配套才能真正隔离。
                    let _ = window.emit_to(window.label(), "dtv_player_window_close", ());
                    let win = window.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        let _ = win.destroy();
                    });
                } else if window.label() == "main" {
                    // 主窗口：同样拦截，让前端结清观看统计会话（React cleanup 在窗口
                    // 销毁时不执行）落盘后经 confirm_main_close_cmd 真正关闭。
                    use tauri::Emitter;
                    api.prevent_close();
                    let _ = window.emit_to(window.label(), "dtv_main_close_requested", ());
                    let win = window.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        let _ = win.destroy();
                    });
                }
            }
        })
        .setup(|_app| {
            // Apply macOS vibrancy to the main window when running on macOS
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                if let Some(window) = _app.get_webview_window("main") {
                    match apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None) {
                        Ok(_) => log::info!("vibrancy applied successfully"),
                        Err(e) => log::error!("vibrancy error: {:?}", e),
                    }
                }
            }
            Ok(())
        })
        .manage(client) // Manage the reqwest client
        .manage(follow_http_client) // 专用关注刷新客户端，避免占用默认连接池
        .manage(DouyuDanmakuHandles::default()) // Manage new DouyuDanmakuHandles
        .manage(DouyinDanmakuState::default()) // Manage DouyinDanmakuState
        .manage(HuyaDanmakuState::default()) // Manage HuyaDanmakuState
        .manage(platforms::common::BilibiliDanmakuState::default()) // Manage BilibiliDanmakuState
        .manage(StreamUrlStore::default())
        .manage(proxy::ProxyServerHandle::default())
        .manage(platforms::bilibili::state::BilibiliState::default())
        .manage(lan_sync::LanSyncServerState::default())
        .invoke_handler(tauri::generate_handler![
            get_stream_url_cmd,
            get_stream_url_with_quality_cmd,
            set_stream_url_cmd,
            search_anchor,
            sync_transfer::export_lan_sync_json_to_desktop,
            sync_transfer::pick_lan_sync_json_import,
            lan_sync::lan_sync_start_server,
            lan_sync::lan_sync_stop_server,
            lan_sync::lan_sync_status,
            lan_sync::lan_sync_discover,
            lan_sync::lan_sync_fetch_manifest,
            lan_sync::lan_sync_fetch_payload,
            start_danmaku_listener,      // Douyu danmaku start
            stop_danmaku_listener,       // Douyu danmaku stop
            start_douyin_danmu_listener, // Added Douyin danmaku listener command
            stop_douyin_danmu_listener,  // Added Douyin danmaku stop command
            start_huya_danmaku_listener, // Added Huya danmaku listener command
            stop_huya_danmaku_listener,  // Added Huya danmaku stop command
            platforms::bilibili::danmaku::start_bilibili_danmaku_listener,
            platforms::bilibili::danmaku::stop_bilibili_danmaku_listener,
            proxy::start_proxy,
            proxy::stop_proxy,
            proxy::start_static_proxy_server,
            fetch_categories,
            fetch_live_list,
            fetch_live_list_for_cate3,
            fetch_douyu_room_info,
            fetch_three_cate,
            generate_douyin_ms_token,
            fetch_douyin_partition_rooms,
            get_douyin_live_stream_url,
            get_douyin_live_stream_url_with_quality,
            fetch_douyin_streamer_info,
            fetch_huya_live_list,
            platforms::huya::stream_url::get_huya_unified_cmd,
            platforms::bilibili::live_list::fetch_bilibili_live_list,
            platforms::bilibili::stream_url::get_bilibili_live_stream_url_with_quality,
            platforms::bilibili::streamer_info::fetch_bilibili_streamer_info,
            platforms::bilibili::cookie::get_bilibili_cookie,
            platforms::bilibili::cookie::bootstrap_bilibili_cookie,
            platforms::bilibili::search::search_bilibili_rooms,
            platforms::huya::search::search_huya_anchors,
            open_in_default_browser,
            send_live_notification_cmd,
            logging::read_log_tail_cmd,
            logging::clear_log_files_cmd,
            logging::open_log_window_cmd,
            open_player_window_cmd,
            confirm_main_close_cmd,
            open_stats_window_cmd,
            open_player_in_main_cmd,
            version_check::check_version_cmd,
            watch_stats::read_watch_stats_cmd,
            watch_stats::append_watch_session_cmd,
            watch_stats::append_watch_event_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
