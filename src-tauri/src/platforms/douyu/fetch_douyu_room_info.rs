// Douyu specific API logic will go here
// NOTE: This module already uses reqwest and is consistent with the unified Douyu HTTP client approach.

use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::platforms::common::FollowHttpClient;

// Define the structure to be returned to TypeScript
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct DouyuFollowInfo {
    room_id: String,
    room_name: Option<String>,
    nickname: Option<String>,
    avatar_url: Option<String>,
    video_loop: Option<i64>,
    show_status: Option<i64>,
    cover_url: Option<String>,
    viewer_count_str: Option<String>,
}

#[tauri::command]
pub async fn fetch_douyu_room_info(
    room_id: String,
    follow_http: State<'_, FollowHttpClient>,
) -> Result<DouyuFollowInfo, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "Accept",
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(
        "Accept-Language",
        HeaderValue::from_static("zh-CN,zh;q=0.9"),
    );
    headers.insert("Cache-Control", HeaderValue::from_static("no-cache"));
    headers.insert("Pragma", HeaderValue::from_static("no-cache"));
    headers.insert(
        "Referer",
        HeaderValue::from_str(&format!("https://www.douyu.com/{}", room_id)).unwrap(),
    );
    headers.insert("User-Agent", HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"));

    let response_result = follow_http
        .0
        .inner
        .get(format!("https://www.douyu.com/betard/{}", room_id))
        .headers(headers)
        .send()
        .await;

    let response = match response_result {
        Ok(res) => res,
        Err(e) => {
            return Err(format!(
                "Network request failed for room {}: {}",
                room_id,
                e.to_string()
            ))
        }
    };

    if !response.status().is_success() {
        return Err(format!(
            "API request for room {} failed with status: {}",
            room_id,
            response.status()
        ));
    }

    let full_json_value = match response.json::<Value>().await {
        Ok(val) => val,
        Err(e) => {
            return Err(format!(
                "Failed to parse JSON for room {}: {}. Ensure API returns valid JSON.",
                room_id,
                e.to_string()
            ))
        }
    };
    let room_data_ref = full_json_value
        .get("data")
        .and_then(|d| d.get("room")) // Path 1: { data: { room: { ... } } }
        .or_else(|| full_json_value.get("data")) // Path 2: { data: { ...room_info... } }
        .or_else(|| full_json_value.get("room")) // Path 3: { room: { ... } }
        .or_else(|| Some(&full_json_value)); // Path 4: { ...room_info... } (root is room object)

    let room_data = match room_data_ref {
        Some(data) => data,
        None => {
            return Err(format!(
                "Could not locate room data block in JSON response for room {}",
                room_id
            ))
        }
    };

    let get_str = |val: &Value, key: &str| val.get(key).and_then(|v| v.as_str()).map(String::from);
    let get_i64 = |val: &Value, key: &str| val.get(key).and_then(|v| v.as_i64());
    let get_nested_str = |val: &Value, path: &[&str]| {
        let mut current = val;
        for key_part in path.iter() {
            current = current.get(key_part)?;
        }
        current.as_str().map(String::from)
    };

    // Prioritize avatar_mid if it exists at the room_data level, then try avatar.middle
    let avatar_final_url = get_str(room_data, "avatar_mid")
        .or_else(|| get_nested_str(room_data, &["avatar", "middle"]));

    // If API provides its own room_id, prefer that. Otherwise, use the input room_id.
    let final_room_id = get_str(room_data, "room_id").unwrap_or_else(|| room_id.clone());

    // betard 的 room_src 是相对片段（asrpic/.../dy4），可加载的绝对地址在同级 room_pic / coverSrc
    let cover_url = get_str(room_data, "room_pic")
        .or_else(|| get_str(room_data, "coverSrc"))
        .or_else(|| get_str(room_data, "room_src").filter(|u| u.starts_with("http")));

    // betard 的人气键随版本漂移：online 优先，hn 兜底（数字或数字串皆可）
    let online = get_i64(room_data, "online")
        .or_else(|| get_i64(room_data, "hn"))
        .or_else(|| get_str(room_data, "hn").and_then(|s| s.trim().parse::<i64>().ok()))
        .unwrap_or(0);
    let viewer_count_str = if online > 0 {
        Some(if online >= 10_000 {
            format!("{:.1}万", (online as f64) / 10_000.0)
        } else {
            online.to_string()
        })
    } else {
        None
    };

    let info = DouyuFollowInfo {
        room_id: final_room_id,
        room_name: get_str(room_data, "room_name"),
        nickname: get_str(room_data, "nickname"),
        avatar_url: avatar_final_url,
        video_loop: get_i64(room_data, "videoLoop"),
        show_status: get_i64(room_data, "show_status"),
        cover_url,
        viewer_count_str,
    };

    Ok(info)
}
