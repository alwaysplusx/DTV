use serde::{Deserialize, Serialize};

// Wrapper for payload like { args: { room_id_str: "..." } }
// Used by get_douyin_live_stream_url and start_douyin_danmaku_listener
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct PayloadWrapperForRoomId {
    pub args: RoomIdDetail,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct RoomIdDetail {
    #[serde(alias = "roomIdStr")]
    pub room_id_str: String,
}

// New payload wrapper specifically for get_douyin_live_stream_url
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct GetStreamUrlArgs {
    pub room_id_str: String,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct GetStreamUrlPayload {
    pub args: GetStreamUrlArgs,
}

// 描述一个可用的播放流变体（用于调试/导出所有地址）
#[derive(Serialize, Clone, Debug)]
pub struct StreamVariant {
    pub url: String,
    pub format: Option<String>,   // e.g. flv, ts, mp4
    pub desc: Option<String>,     // e.g. 原画/高清
    pub qn: Option<i32>,          // B 站的清晰度编号
    pub protocol: Option<String>, // e.g. http, https, ws/hls
}

// For the return type of get_douyin_live_stream_url
// Matches LiveStreamInfo interface in DouyinLive.vue
#[derive(Serialize, Clone, Debug)]
pub struct LiveStreamInfo {
    pub title: Option<String>,
    pub anchor_name: Option<String>,
    pub avatar: Option<String>,
    pub stream_url: Option<String>,
    pub status: Option<i32>,
    pub error_message: Option<String>,
    // 新增：上游真实地址（未经过本地代理）
    pub upstream_url: Option<String>,
    // 新增：所有可用的播放地址列表（调试/导出用）
    pub available_streams: Option<Vec<StreamVariant>>,
    // 新增：规范化后的房间ID（例如从 web_id 提取出的 room.id_str）
    pub normalized_room_id: Option<String>,
    // 新增：直播间的 web_rid（用于关注列表以 web_id 为主键）
    pub web_rid: Option<String>,
    // 新增：房间快照封面 URL（直播中为平台截帧，随开播状态变化）
    pub cover_url: Option<String>,
    // 新增：观看人气展示串（已格式化如 "1.2万"）
    pub viewer_count_str: Option<String>,
}

#[derive(Default, Clone)]
#[allow(dead_code)]
pub struct StreamUrlStore {
    pub url: std::sync::Arc<std::sync::Mutex<String>>,
}

// Moved from main.rs
// State for the Douyin Danmaku listener (multi-room capable)
// 外层 Arc 使 spawned task 可持有共享句柄做退出清理；Tauri State 管理的是外层结构。
#[derive(Default, Clone)]
#[allow(dead_code)]
pub struct DouyinDanmakuState(pub std::sync::Arc<std::sync::Mutex<DanmakuStopSignals>>);

// State for the Bilibili Danmaku listener (multi-room capable)
#[derive(Default, Clone)]
#[allow(dead_code)]
pub struct BilibiliDanmakuState(pub std::sync::Arc<std::sync::Mutex<DanmakuStopSignals>>);

// State for the Huya Danmaku listener (multi-room capable)
#[derive(Default, Clone)]
#[allow(dead_code)]
pub struct HuyaDanmakuState(pub std::sync::Arc<std::sync::Mutex<DanmakuStopSignals>>);

/// 单房间共享监听条目：stop sender（spawn 后登记）+ 按窗口的引用计数。
/// 跨窗口看同一房间时共享一条连接：start 计数、stop 减计数、归零才真正停止，
/// 一方退出不再杀死另一方仍在使用的监听。
#[derive(Default)]
pub struct SharedDanmakuRoom<S> {
    pub stop_tx: Option<S>,
    pub owners: std::collections::HashMap<String, usize>,
}

/// 多房间弹幕共享注册表：room_id -> 共享监听条目。
pub type DanmakuStopSignals<S = tokio::sync::mpsc::Sender<()>> =
    std::collections::HashMap<String, SharedDanmakuRoom<S>>;

/// start 登记窗口引用。返回 true 表示房间尚无连接，调用方需 spawn 监听并通过
/// `register_danmaku_stop_tx` 登记 sender；false 表示复用现有连接（无需 spawn）。
pub fn acquire_danmaku_room<S>(
    map: &mut DanmakuStopSignals<S>,
    room_id: &str,
    window_label: &str,
) -> bool {
    match map.get_mut(room_id) {
        Some(room) => {
            *room.owners.entry(window_label.to_string()).or_insert(0) += 1;
            false
        }
        None => {
            let mut owners = std::collections::HashMap::new();
            owners.insert(window_label.to_string(), 1);
            map.insert(
                room_id.to_string(),
                SharedDanmakuRoom {
                    stop_tx: None,
                    owners,
                },
            );
            true
        }
    }
}

pub fn register_danmaku_stop_tx<S>(map: &mut DanmakuStopSignals<S>, room_id: &str, tx: S) {
    if let Some(room) = map.get_mut(room_id) {
        room.stop_tx = Some(tx);
    }
}

/// stop 减窗口引用；引用归零时移除条目并返回 stop sender（调用方发送停止信号）。
/// 窗口名下没有该房间引用时不做任何事。
pub fn release_danmaku_room<S>(
    map: &mut DanmakuStopSignals<S>,
    room_id: &str,
    window_label: &str,
) -> Option<S> {
    let should_stop = {
        let room = map.get_mut(room_id)?;
        match room.owners.get_mut(window_label) {
            None => false,
            Some(count) => {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    room.owners.remove(window_label);
                }
                room.owners.is_empty()
            }
        }
    };
    if should_stop {
        map.remove(room_id)?.stop_tx
    } else {
        None
    }
}

/// 停止窗口名下全部房间（窗口级清理）；返回需要发送停止信号的 sender 列表。
pub fn release_all_danmaku_rooms<S>(map: &mut DanmakuStopSignals<S>, window_label: &str) -> Vec<S> {
    let mut dead_rooms: Vec<String> = Vec::new();
    for (room_id, room) in map.iter_mut() {
        let had_owner = match room.owners.get_mut(window_label) {
            Some(count) => {
                *count = 0;
                true
            }
            None => false,
        };
        if had_owner {
            room.owners.remove(window_label);
        }
        if room.owners.is_empty() {
            dead_rooms.push(room_id.clone());
        }
    }
    dead_rooms
        .into_iter()
        .filter_map(|rid| map.remove(&rid).and_then(|r| r.stop_tx))
        .collect()
}

#[derive(Serialize, Clone, Debug, specta::Type)]
pub struct DanmakuFrontendPayload {
    pub room_id: String,
    pub user: String,
    pub content: String,
    pub user_level: i64,
    pub fans_club_level: i32,
    pub color: Option<String>,
}
