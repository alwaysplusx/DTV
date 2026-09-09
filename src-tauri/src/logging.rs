use tauri_plugin_log::{Target, TargetKind, TimezoneStrategy};

/// 日志插件：stderr（终端可见）+ LogDir 落盘（应用内「运行日志」面板读取）。
/// 防堆积：单文件 5MB 触发滚动，滚动副本按日期命名保留 1 份 → 磁盘占用硬上限 10MB。
pub fn build_plugin() -> impl tauri::plugin::Plugin<tauri::Wry> {
    // 级别策略对齐原 env_logger 默认值：
    // - Debug 构建：全局 info，本 crate（dtv）开 debug
    // - Release 构建：全局 info（debug 不落盘）
    let mut builder = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        // 常见 HTTP 栈依赖保持安静，避免刷屏（对齐原 filter_module）
        .level_for("hyper", log::LevelFilter::Info)
        .level_for("h2", log::LevelFilter::Info)
        .level_for("reqwest", log::LevelFilter::Info)
        .targets([
            Target::new(TargetKind::Stderr),
            Target::new(TargetKind::LogDir {
                file_name: Some("dtv".into()),
            }),
        ])
        // 本地时区时间戳（默认 UTC，对 zh-CN 用户不友好）
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .max_file_size(5 * 1024 * 1024)
        // KeepSome(1)：滚动时旧文件重命名为 dtv_{date}.log 保留 1 份（KeepOne 是直接删除、
        // 无历史可读——日志面板在滚动瞬间会整段丢失，当初误用，勿改回）
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(1));

    if cfg!(debug_assertions) {
        builder = builder.level_for("dtv", log::LevelFilter::Debug);
    }

    builder.build()
}

/// 滚动副本命名：KeepSome 滚动时旧文件重命名为 `dtv_{date}.log`（同秒再滚会追加 `.bak`）。
fn is_rolled_log_name(name: &str) -> bool {
    name.starts_with("dtv_") && (name.ends_with(".log") || name.ends_with(".log.bak"))
}

/// 从 `max` 字节边界后的第一个换行处开始截取尾部，避免切出半行。
fn tail_from_line_start(data: &[u8], max: usize) -> &[u8] {
    if data.len() <= max {
        return data;
    }
    let start = data.len() - max;
    let start = data[start..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| start + i + 1)
        .unwrap_or(start);
    &data[start..]
}

/// 读取当前日志尾部（应用内日志面板用）。
/// 优先读活动文件 dtv.log；刚滚动后活动文件很小，再从滚动副本（按 mtime 取最新）
/// 补前缀拼出 tail，避免面板在滚动瞬间突然只剩几行。
#[tauri::command]
pub fn read_log_tail_cmd(app: tauri::AppHandle, max_bytes: Option<u64>) -> Result<String, String> {
    use std::fs;
    use std::path::PathBuf;
    use tauri::Manager;

    let max = max_bytes
        .unwrap_or(256 * 1024)
        .clamp(4 * 1024, 4 * 1024 * 1024) as usize;

    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("resolve log dir failed: {e}"))?;

    // NotFound（目录被外部清理等）视为「无日志」
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => Some(entries),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read log dir failed: {e}")),
    };

    let active = match fs::read(dir.join("dtv.log")) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("read log file failed: {e}")),
    };
    if active.len() >= max {
        return Ok(String::from_utf8_lossy(tail_from_line_start(&active, max)).into_owned());
    }

    let mut rolled: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    if let Some(entries) = entries {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_rolled_log_name(&name) {
                continue;
            }
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            rolled.push((mtime, entry.path()));
        }
    }
    rolled.sort();
    let Some((_, prev_path)) = rolled.last() else {
        return Ok(String::from_utf8_lossy(&active).into_owned());
    };
    let prev = fs::read(prev_path).map_err(|e| format!("read log file failed: {e}"))?;

    let need = max - active.len();
    let mut out = tail_from_line_start(&prev, need).to_vec();
    out.extend_from_slice(&active);
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// 清除日志：滚动副本直接删除；活动文件 dtv.log 用 truncate 清零。
/// 不能 remove 活动文件——插件持有其写入句柄（Windows 下 FILE_SHARE_DELETE 允许删除），
/// 删除后日志会继续写进孤儿句柄，从此不再落盘。
/// 返回值是「处理（清零/删除）的文件数」。
#[tauri::command]
pub fn clear_log_files_cmd(app: tauri::AppHandle) -> Result<u32, String> {
    use std::fs;
    use tauri::Manager;

    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("resolve log dir failed: {e}"))?;

    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("read log dir failed: {e}")),
    };

    let mut handled = 0u32;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if name == "dtv.log" {
            match fs::OpenOptions::new().write(true).truncate(true).open(&path) {
                Ok(_) => handled += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("truncate dtv.log failed: {e}")),
            }
        } else if is_rolled_log_name(&name) {
            match fs::remove_file(&path) {
                Ok(_) => handled += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("remove {name} failed: {e}")),
            }
        }
    }
    Ok(handled)
}

/// 打开「运行日志」独立窗口（单例）。在 Rust 侧创建而不是 web 侧，
/// 绕开 webview 创建的 capability 白名单需求。
/// 必须 async：同步命令在主线程（事件循环）上执行，build() 会阻塞等待
/// 事件循环完成窗口创建 → 自死锁，窗口停在 about:blank 空白且整个 IPC 冻结。
#[tauri::command]
pub async fn open_log_window_cmd(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    const LABEL: &str = "logs";

    let focus_existing = |win: &tauri::WebviewWindow| {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    };

    if let Some(win) = app.get_webview_window(LABEL) {
        focus_existing(&win);
        return Ok(());
    }

    let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("logs/".into()))
        .title("运行日志")
        .inner_size(880.0, 640.0)
        .min_inner_size(560.0, 380.0)
        .build();
    match built {
        Ok(_) => Ok(()),
        // 快速双击菜单项会并发创建两次：第二个因 label 已存在失败，此时前置已建窗口即可
        Err(e) => {
            if let Some(win) = app.get_webview_window(LABEL) {
                focus_existing(&win);
                Ok(())
            } else {
                Err(format!("create log window failed: {e}"))
            }
        }
    }
}
