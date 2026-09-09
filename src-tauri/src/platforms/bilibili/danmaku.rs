use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::mpsc as tokio_mpsc;

use crate::platforms::bilibili::models::BiliMessage;
use crate::platforms::bilibili::websocket::BiliLiveClient;

#[tauri::command]
pub async fn start_bilibili_danmaku_listener(
    payload: crate::platforms::common::GetStreamUrlPayload,
    cookie: Option<String>,
    window: tauri::Window,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::platforms::common::BilibiliDanmakuState>,
) -> Result<(), String> {
    let room_id = payload.args.room_id_str.clone();

    // 引用计数共享：同窗口重复 start 先释放旧引用（保持重启语义）；
    // 跨窗口同房间复用现有连接，互不误停。
    let (need_spawn, stale_tx) = {
        let mut lock = state.inner().0.lock().unwrap();
        let stale_tx =
            crate::platforms::common::release_danmaku_room(&mut lock, &room_id, window.label());
        let need_spawn =
            crate::platforms::common::acquire_danmaku_room(&mut lock, &room_id, window.label());
        (need_spawn, stale_tx)
    };
    if let Some(tx) = stale_tx {
        if tx.send(()).await.is_err() {
            log::error!("[Bilibili Danmaku] 旧任务关闭失败，可能已退出。");
        }
    }
    if !need_spawn {
        return Ok(());
    }

    let (tx_shutdown, mut rx_shutdown) = tokio_mpsc::channel::<()>(1);
    {
        let mut lock = state.inner().0.lock().unwrap();
        crate::platforms::common::register_danmaku_stop_tx(&mut lock, &room_id, tx_shutdown.clone());
    }

    let app_handle_clone = app_handle.clone();
    let room_id_clone = room_id.clone();
    let cookie_clone = cookie.clone();

    // Use atomic flag to signal std::thread to stop
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_thread = stop_flag.clone();

    // Spawn std thread to run sync BiliLiveClient loop
    std::thread::spawn(move || {
        // 初始建连失败会 panic（connect 内部 unwrap），这里兜底重试直到成功或收到停止信号，
        // 否则线程静默死亡、弹幕从此无声。
        let mut client = loop {
            if stop_flag_for_thread.load(Ordering::Relaxed) {
                return;
            }
            let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut c = match cookie_clone.as_ref() {
                    Some(c) => BiliLiveClient::new_with_cookie(c.as_str(), room_id_clone.as_str()),
                    None => BiliLiveClient::new_without_cookie(room_id_clone.as_str()),
                };
                c.send_auth();
                c
            }));
            match attempt {
                Ok(c) => break c,
                Err(_) => {
                    log::error!("[Bilibili Danmaku] 初始连接失败，5 秒后重试");
                    std::thread::sleep(std::time::Duration::from_secs(5));
                }
            }
        };

        loop {
            if stop_flag_for_thread.load(Ordering::Relaxed) {
                break;
            }
            if let Some(msg) = client.read_once() {
                match msg {
                    BiliMessage::Danmu { user, text } => {
                        let _ = app_handle_clone.emit(
                            "danmaku-message",
                            crate::platforms::common::DanmakuFrontendPayload {
                                room_id: room_id_clone.clone(),
                                user,
                                content: text,
                                user_level: 0,
                                fans_club_level: 0,
                                color: None,
                            },
                        );
                    }
                    BiliMessage::Gift { user, gift } => {
                        let _ = app_handle_clone.emit(
                            "danmaku-message",
                            crate::platforms::common::DanmakuFrontendPayload {
                                room_id: room_id_clone.clone(),
                                user,
                                content: format!("[礼物] {}", gift),
                                user_level: 0,
                                fans_club_level: 0,
                                color: None,
                            },
                        );
                    }
                    BiliMessage::Unsupported { .. } => {
                        // ignore
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });

    // Spawn a tokio task to listen for shutdown and set stop flag,
    // and clean up the registry entry once the worker thread has exited.
    let stop_flag_for_task = stop_flag.clone();
    let state_for_cleanup = state.inner().clone();
    let room_id_for_cleanup = room_id.clone();
    let tx_for_guard = tx_shutdown.clone();
    tokio::spawn(async move {
        let _ = rx_shutdown.recv().await; // wait for shutdown signal
        stop_flag_for_task.store(true, Ordering::Relaxed);
        // std thread 轮询间隔最长 50ms，等待其退出后清理注册表条目
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let mut lock = state_for_cleanup.0.lock().unwrap();
        // 条目已被 release 移除或换成了新实例（same_channel 不符）时不动作，防误删
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

#[tauri::command]
pub async fn stop_bilibili_danmaku_listener(
    room_id: Option<String>,
    window: tauri::Window,
    state: tauri::State<'_, crate::platforms::common::BilibiliDanmakuState>,
) -> Result<(), String> {
    // `room_id` 为 None/空 = 停止该窗口全部；否则只减该窗口在该房间的引用，归零才真停。
    let senders = {
        let mut lock = state.inner().0.lock().unwrap();
        match room_id.as_deref() {
            None | Some("") => crate::platforms::common::release_all_danmaku_rooms(
                &mut lock,
                window.label(),
            ),
            Some(rid) => crate::platforms::common::release_danmaku_room(&mut lock, rid, window.label())
                .into_iter()
                .collect(),
        }
    };
    let mut had_error = false;
    for tx in senders {
        if tx.send(()).await.is_err() {
            had_error = true;
        }
    }
    if had_error {
        return Err("停止Bilibili弹幕监听失败：接收方已关闭".to_string());
    }
    Ok(())
}
