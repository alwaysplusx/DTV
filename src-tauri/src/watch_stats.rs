use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

static WATCH_HISTORY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchSession {
    pub platform: String,
    pub room_id: String,
    pub anchor_name: Option<String>,
    pub title: Option<String>,
    pub avatar: Option<String>,
    pub began_at: u64,
    pub ended_at: u64,
    pub seconds: u64,
    /// "playing" | "offline_visit"
    pub reason: String,
    pub multiview_slot: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub platform: String,
    pub room_id: String,
    pub anchor_name: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub at: u64,
    pub approx: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WatchHistory {
    pub version: u32,
    pub sessions: Vec<WatchSession>,
    pub events: Vec<WatchEvent>,
}

fn history_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(dir.join("watch-history.json"))
}

fn load_history(path: &PathBuf) -> Result<WatchHistory, String> {
    if !path.exists() {
        return Ok(WatchHistory::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Failed to read watch history: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(WatchHistory::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse watch history: {e}"))
}

fn save_history(path: &PathBuf, history: &WatchHistory) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(history).map_err(|e| format!("Failed to serialize: {e}"))?;
    fs::write(path, raw).map_err(|e| format!("Failed to write watch history: {e}"))
}

#[tauri::command]
pub fn read_watch_stats_cmd(app: tauri::AppHandle) -> Result<WatchHistory, String> {
    let _guard = WATCH_HISTORY_LOCK.lock().unwrap();
    let path = history_path(&app)?;
    load_history(&path)
}

#[tauri::command]
pub fn append_watch_session_cmd(app: tauri::AppHandle, session: WatchSession) -> Result<(), String> {
    let _guard = WATCH_HISTORY_LOCK.lock().unwrap();
    let path = history_path(&app)?;
    let mut history = load_history(&path)?;
    if history.version == 0 {
        history.version = 1;
    }
    history.sessions.push(session);
    save_history(&path, &history)
}

#[tauri::command]
pub fn append_watch_event_cmd(app: tauri::AppHandle, event: WatchEvent) -> Result<(), String> {
    let _guard = WATCH_HISTORY_LOCK.lock().unwrap();
    let path = history_path(&app)?;
    let mut history = load_history(&path)?;
    if history.version == 0 {
        history.version = 1;
    }
    history.events.push(event);
    save_history(&path, &history)
}
