use crate::platforms::douyin::web_api::normalize_douyin_live_id;
use rand::Rng;
use tokio::sync::mpsc as tokio_mpsc;
use tokio::time::{sleep, Duration};

enum ConnectionOutcome {
    Stop,
    Disconnected,
}

#[tauri::command]
pub async fn stop_douyin_danmu_listener(
    room_id: Option<String>,
    window: tauri::Window,
    state: tauri::State<'_, crate::platforms::common::DouyinDanmakuState>,
) -> Result<(), String> {
    // `room_id` 为 None/空 = 停止该窗口全部；否则只减该窗口引用，归零才真停（跨窗口共享连接）。
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

    for tx in senders {
        if tx.send(()).await.is_err() {
            log::error!("[Douyin Danmaku] Failed to send shutdown. Task might have already completed or panicked.");
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn start_douyin_danmu_listener(
    payload: crate::platforms::common::GetStreamUrlPayload,
    window: tauri::Window,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::platforms::common::DouyinDanmakuState>,
) -> Result<(), String> {
    let room_id_or_url = payload.args.room_id_str;
    log::info!(
        "[Douyin Danmaku] Received request for room_id_or_url: {}",
        room_id_or_url
    );

    // 引用计数共享：同窗口重复 start 先释放旧引用（保持重启语义）；
    // 跨窗口同房间复用现有连接，互不误停。
    let normalized_room_id = normalize_douyin_live_id(&room_id_or_url);
    let (need_spawn, stale_tx) = {
        let mut lock = state.inner().0.lock().unwrap();
        let stale_tx = crate::platforms::common::release_danmaku_room(
            &mut lock,
            &normalized_room_id,
            window.label(),
        );
        let need_spawn = crate::platforms::common::acquire_danmaku_room(
            &mut lock,
            &normalized_room_id,
            window.label(),
        );
        (need_spawn, stale_tx)
    };
    if let Some(tx) = stale_tx {
        log::info!(
            "[Douyin Danmaku] Sending shutdown to previous Douyin listener task for room {}.",
            normalized_room_id
        );
        if tx.send(()).await.is_err() {
            log::error!("[Douyin Danmaku] Failed to send shutdown. Task might have already completed or panicked.");
        }
    }
    if !need_spawn {
        log::info!(
            "[Douyin Danmaku] Reusing existing listener for room {}.",
            normalized_room_id
        );
        return Ok(());
    }

    if room_id_or_url == "stop_listening" {
        log::info!(
            "[Douyin Danmaku] Received stop_listening signal. Listener will not be restarted."
        );
        return Ok(());
    }

    let (tx_shutdown, mut rx_shutdown) = tokio_mpsc::channel::<()>(1);
    {
        let mut lock = state.inner().0.lock().unwrap();
        crate::platforms::common::register_danmaku_stop_tx(
            &mut lock,
            &normalized_room_id,
            tx_shutdown.clone(),
        );
    }

    let app_handle_clone = app_handle.clone();
    let room_id_str_clone = normalized_room_id.clone();
    // 注册表句柄克隆给 spawned task，用于退出兜底清理（Arc 内部共享，State 不能跨 await 持有）
    let state_for_cleanup = state.inner().clone();
    let room_id_for_cleanup = normalized_room_id.clone();
    let tx_for_guard = tx_shutdown.clone();

    tokio::spawn(async move {
        log::info!(
            "[Douyin Danmaku] Spawning listener for room: {}",
            room_id_str_clone
        );

        let mut backoff_secs = 1u64;

        loop {
            let mut increase_backoff = true;
            let mut max_backoff_secs = 30u64;
            let result = async {
                let mut fetcher = crate::platforms::douyin::danmu::web_fetcher::DouyinLiveWebFetcher::new(&room_id_str_clone)?;
                fetcher
                    .fetch_room_details()
                    .await
                    .map_err(|e| format!("Failed to fetch room details: {}", e))?;

                let actual_room_id = fetcher.get_room_id().await?;
                let cookie_header = fetcher.get_dy_cookie().await?;
                let user_unique_id = fetcher.get_user_unique_id().await?;
                log::info!(
                    "[Douyin Danmaku] Using: room_id={}, user_unique_id={}",
                    actual_room_id, user_unique_id
                );

                let (read_stream, ack_tx, shutdown_tx) = crate::platforms::douyin::danmu::websocket_connection::connect_and_manage_websocket(
                    &fetcher,
                    &actual_room_id,
                    &cookie_header,
                    &user_unique_id,
                )
                .await?;

                log::info!(
                    "[Douyin Danmaku] WebSocket connected for room: {}",
                    actual_room_id
                );

                let shutdown_tx_for_msg = shutdown_tx.clone();
                tokio::select! {
                    res = crate::platforms::douyin::danmu::message_handler::handle_received_messages(
                        read_stream,
                        ack_tx,
                        app_handle_clone.clone(),
                        actual_room_id.clone()
                    ) => {
                        let _ = shutdown_tx_for_msg.send(true);
                        if let Err(e) = res {
                            return Err(e);
                        }
                        Ok(ConnectionOutcome::Disconnected)
                    }
                    _ = rx_shutdown.recv() => {
                        log::info!(
                            "[Douyin Danmaku] Received shutdown signal for room {}.",
                            actual_room_id
                        );
                        let _ = shutdown_tx.send(true);
                        Ok(ConnectionOutcome::Stop)
                    }
                }
            }
            .await;

            match result {
                Ok(ConnectionOutcome::Stop) => break,
                Ok(ConnectionOutcome::Disconnected) => {
                    log::error!(
                        "[Douyin Danmaku] Disconnected, retrying in {}s.",
                        backoff_secs
                    );
                    // We had a successful session; reset backoff to minimize downtime on reconnect.
                    backoff_secs = 1;
                    increase_backoff = false;
                }
                Err(e) => {
                    let err_text = e.to_string();
                    // If the server is explicitly throttling / blocking, avoid hammering the same egress IP.
                    if err_text.contains("http_status=429") || err_text.contains("http_status=403")
                    {
                        max_backoff_secs = 300;
                        backoff_secs = backoff_secs.max(60);
                    } else if err_text.contains("http_status=504")
                        || err_text.contains(" 504 ")
                        || err_text.contains("504 Gateway Timeout")
                    {
                        max_backoff_secs = 120;
                        backoff_secs = backoff_secs.max(10);
                    }
                    log::error!(
                        "[Douyin Danmaku] Connection error: {}. Retrying in {}s.",
                        e,
                        backoff_secs
                    );
                }
            }

            let jitter_ms: u64 = rand::thread_rng().gen_range(0..=800);
            let sleep_fut =
                sleep(Duration::from_secs(backoff_secs) + Duration::from_millis(jitter_ms));
            tokio::select! {
                _ = sleep_fut => {}
                _ = rx_shutdown.recv() => break,
            }
            if increase_backoff {
                backoff_secs = (backoff_secs * 2).min(max_backoff_secs);
            }
        }

        // 任务退出后兜底清理注册表（正常 stop 路径已被 release 移除）。
        // 条目已换成新实例（same_channel 不符）时不动作，防误删。
        let mut lock = state_for_cleanup.0.lock().unwrap();
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
