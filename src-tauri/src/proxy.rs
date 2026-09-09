use actix_web::{dev::ServerHandle, web, App, HttpRequest, HttpResponse, HttpServer, Responder};
use futures_util::TryStreamExt;
use reqwest::Client;
// awc removed for now due to API differences; using reqwest streaming
use crate::StreamUrlStore;
use serde::Deserialize;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::{AppHandle, State};

// Define a struct to hold the server handle in a Tauri managed state
#[derive(Default)]
pub struct ProxyServerHandle(pub StdMutex<Option<ServerHandle>>);

// Align with pure_live-master's Huya playback UA
const HUYA_HYSDK_UA: &str =
    "HYSDK(Windows,30000002)_APP(pc_exe&7080000&official)_SDK(trans&2.34.0.5795)";

async fn find_free_port() -> u16 {
    // Using a fixed port as requested by the user for easier debugging
    34719
}

#[derive(Deserialize)]
struct ImageQuery {
    url: String,
}

async fn image_proxy_handler(
    query: web::Query<ImageQuery>,
    client: web::Data<Client>,
) -> impl Responder {
    let url = query.url.clone();
    if url.is_empty() {
        return HttpResponse::BadRequest().body("Missing url query parameter");
    }

    let mut req = client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/*;q=0.8,*/*;q=0.5",
        );

    // Set a Referer to bypass hotlink protections
    if url.contains("hdslb.com") || url.contains("bilibili.com") {
        req = req
            .header("Referer", "https://live.bilibili.com/")
            .header("Origin", "https://live.bilibili.com");
    } else if url.contains("huya.com") {
        req = req
            .header("Referer", "https://www.huya.com/")
            .header("Origin", "https://www.huya.com");
    } else if url.contains("douyin") || url.contains("douyinpic.com") {
        req = req.header("Referer", "https://www.douyin.com/");
    }

    match req.send().await {
        Ok(upstream_response) => {
            let content_type = upstream_response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();

            // 为避免 Windows 下 chunked 传输的 Early-EOF，改为一次性读取 bytes 并返回
            if upstream_response.status().is_success() {
                match upstream_response.bytes().await {
                    Ok(bytes) => HttpResponse::Ok()
                        .content_type(content_type)
                        .insert_header(("Content-Length", bytes.len().to_string()))
                        // Allow the WebView to cache proxied images to avoid re-downloading covers/avatars
                        // when switching routes or scrolling lists.
                        .insert_header(("Cache-Control", "public, max-age=86400, immutable"))
                        .body(bytes),
                    Err(e) => {
                        log::error!("[Rust/proxy.rs image] Failed to read bytes: {}", e);
                        HttpResponse::InternalServerError()
                            .body(format!("Failed to read image bytes: {}", e))
                    }
                }
            } else {
                let status_from_reqwest = upstream_response.status();
                let error_text = upstream_response
                    .text()
                    .await
                    .unwrap_or_else(|e| format!("Failed to read error body from upstream: {}", e));
                log::error!(
                    "[Rust/proxy.rs image] Upstream request to {} failed with status: {}. Body: {}",
                    url,
                    status_from_reqwest,
                    error_text
                );
                let actix_status_code =
                    actix_web::http::StatusCode::from_u16(status_from_reqwest.as_u16())
                        .unwrap_or(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR);

                HttpResponse::build(actix_status_code).body(format!(
                    "Error fetching IMAGE from upstream (reqwest): {}. Status: {}. Details: {}",
                    url, status_from_reqwest, error_text
                ))
            }
        }
        Err(e) => {
            log::error!(
                "[Rust/proxy.rs image] Failed to send request to upstream {}: {}",
                url,
                e
            );
            HttpResponse::InternalServerError()
                .body(format!("Error connecting to upstream IMAGE {}: {}", url, e))
        }
    }
}

// Your actual proxy logic - this is a simplified placeholder
// 多路代理：/live.flv/{session} 按 session 取各自的 上游 URL，互不干扰。
async fn flv_proxy_handler(
    req: HttpRequest,
    stream_url_store: web::Data<StreamUrlStore>,
    client: web::Data<Client>,
) -> impl Responder {
    let path = req.path(); // e.g. /live.flv/abc123 或 /live.flv
    let session = path
        .strip_prefix("/live.flv")
        .unwrap_or("")
        .trim_start_matches('/')
        .to_string();

    let url = {
        let store = stream_url_store.url.lock().unwrap();
        if session.is_empty() {
            store.get("").cloned() // 兼容无 session 的旧调用
        } else {
            store.get(&session).cloned()
        }
    };

    let Some(url) = url else {
        return HttpResponse::NotFound().body("Stream URL is not set or empty.");
    };

    log::info!(
        "[Rust/proxy.rs handler] Incoming FLV proxy request (session={}) -> {}",
        session,
        url
    );

    let mut req = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Accept", "video/x-flv,application/octet-stream,*/*")
        .header("Range", "bytes=0-")
        .header("Connection", "keep-alive");

    // 如果是虎牙域名，添加必要的 Referer/Origin 头
    if url.contains("huya.com") || url.contains("hy-cdn.com") || url.contains("huyaimg.com") {
        req = req
            .header("User-Agent", HUYA_HYSDK_UA)
            .header("Referer", "https://www.huya.com/")
            .header("Origin", "https://www.huya.com");
    }
    // 如果是B站域名，添加必要的 Referer 头
    if url.contains("bilivideo") || url.contains("bilibili.com") || url.contains("hdslb.com") {
        req = req.header("Referer", "https://live.bilibili.com/");
    }

    match req.send().await {
        Ok(upstream_response) => {
            if upstream_response.status().is_success() {
                let mut response_builder = HttpResponse::Ok();
                response_builder
                    .content_type("video/x-flv")
                    .insert_header(("Connection", "keep-alive"))
                    .insert_header(("Cache-Control", "no-store"))
                    .insert_header(("Accept-Ranges", "bytes"));

                let byte_stream = upstream_response.bytes_stream().map_err(|e| {
                    log::error!(
                        "[Rust/proxy.rs handler] Error reading bytes from upstream: {}",
                        e
                    );
                    actix_web::error::ErrorInternalServerError(format!(
                        "Upstream stream error: {}",
                        e
                    ))
                });

                response_builder.streaming(byte_stream)
            } else {
                let status_from_reqwest = upstream_response.status(); // Renamed for clarity
                let error_text = upstream_response
                    .text()
                    .await
                    .unwrap_or_else(|e| format!("Failed to read error body from upstream: {}", e));
                log::error!(
                    "[Rust/proxy.rs handler] Upstream request to {} failed with status: {}. Body: {}",
                    url, status_from_reqwest, error_text
                );
                // Convert reqwest::StatusCode to actix_web::http::StatusCode
                let actix_status_code =
                    actix_web::http::StatusCode::from_u16(status_from_reqwest.as_u16())
                        .unwrap_or(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR);

                HttpResponse::build(actix_status_code).body(format!(
                    "Error fetching FLV stream from upstream (reqwest): {}. Status: {}. Details: {}",
                    url, status_from_reqwest, error_text
                ))
            }
        }
        Err(e) => {
            log::error!(
                "[Rust/proxy.rs handler] Failed to send request to upstream {} with reqwest: {}",
                url,
                e
            );
            HttpResponse::InternalServerError().body(format!(
                "Error connecting to upstream FLV stream {} with reqwest: {}",
                url, e
            ))
        }
    }
}

#[tauri::command]
pub async fn start_proxy(
    _app_handle: AppHandle,
    server_handle_state: State<'_, ProxyServerHandle>,
    stream_url_store: State<'_, StreamUrlStore>,
) -> Result<String, String> {
    let port = find_free_port().await;

    // 多路代理：服务器是共享的，若已存在直接复用，不再停旧启新（避免顶掉其他 session 的流）。
    {
        let handle = server_handle_state.0.lock().unwrap();
        if let Some(_existing) = handle.as_ref() {
            // 服务器已在运行 —— 幂等返回代理 URL
            return Ok(format!("http://127.0.0.1:{}/live.flv", port));
        }
    }

    let stream_url_data_for_actix = web::Data::new(stream_url_store.inner().clone());

    let server = match HttpServer::new(move || {
        let app_data_stream_url = stream_url_data_for_actix.clone();
        // Create reqwest::Client inside the closure for each worker thread (for images)
        let app_data_reqwest_client = web::Data::new(
            Client::builder()
                .no_proxy()
                .http1_only()
                .gzip(false)
                .brotli(false)
                .no_deflate()
                .pool_idle_timeout(None)
                .pool_max_idle_per_host(4)
                .tcp_keepalive(Duration::from_secs(60))
                .timeout(Duration::from_secs(7200))
                .build()
                .expect("failed to build client"),
        );
        App::new()
            .app_data(app_data_stream_url)
            .app_data(app_data_reqwest_client)
            .wrap(actix_cors::Cors::permissive())
            .route("/live.flv", web::get().to(flv_proxy_handler))
            .route("/live.flv/{session}", web::get().to(flv_proxy_handler))
            .route("/image", web::get().to(image_proxy_handler))
    })
    .keep_alive(Duration::from_secs(120))
    .bind(("127.0.0.1", port))
    {
        Ok(srv) => srv,
        Err(e) => {
            // 端口被占 = 代理已在跑（可能是上一会话残留），幂等返回
            if e.kind() == ErrorKind::AddrInUse {
                log::error!(
                    "[Rust/proxy.rs] Port {} already in use; assuming proxy server running.",
                    port
                );
                return Ok(format!("http://127.0.0.1:{}/live.flv", port));
            }
            let err_msg = format!(
                "[Rust/proxy.rs] Failed to bind server to port {}: {}",
                port, e
            );
            log::error!("{}", err_msg);
            return Err(err_msg);
        }
    }
    .run();

    let server_handle_for_state = server.handle();
    *server_handle_state.0.lock().unwrap() = Some(server_handle_for_state);

    // Use tauri::async_runtime::spawn directly
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server.await {
            log::error!("[Rust/proxy.rs] Proxy server run error: {}", e);
        } else {
            log::info!("[Rust/proxy.rs] Proxy server on port {} shut down.", port);
        }
    });

    let proxy_url = format!("http://127.0.0.1:{}/live.flv", port);
    Ok(proxy_url)
}

#[tauri::command]
pub async fn start_static_proxy_server(
    _app_handle: AppHandle,
    stream_url_store: State<'_, StreamUrlStore>,
) -> Result<String, String> {
    // Use a dedicated port for static image proxy to avoid interfering with FLV stream proxy
    let port: u16 = 34721;

    // If the server is already running, just return the base URL (idempotent behavior)
    if TcpStream::connect(("127.0.0.1", port)).is_ok() {
        return Ok(format!("http://127.0.0.1:{}", port));
    }

    let stream_url_data_for_actix = web::Data::new(stream_url_store.inner().clone());

    let server = match HttpServer::new(move || {
        let app_data_stream_url = stream_url_data_for_actix.clone();
        let app_data_reqwest_client = web::Data::new(
            Client::builder()
                .no_proxy()
                .http1_only()
                .gzip(false)
                .brotli(false)
                .no_deflate()
                .pool_idle_timeout(None)
                .pool_max_idle_per_host(4)
                .tcp_keepalive(Duration::from_secs(60))
                .timeout(Duration::from_secs(7200))
                .build()
                .expect("failed to build client"),
        );
        App::new()
            .app_data(app_data_stream_url)
            .app_data(app_data_reqwest_client)
            .wrap(actix_cors::Cors::permissive())
            .route("/live.flv", web::get().to(flv_proxy_handler))
            .route("/image", web::get().to(image_proxy_handler))
    })
    .keep_alive(Duration::from_secs(120))
    .bind(("127.0.0.1", port))
    {
        Ok(srv) => srv,
        Err(e) => {
            // If address already in use, assume server is running and return OK base URL
            if e.kind() == ErrorKind::AddrInUse {
                log::error!(
                    "[Rust/proxy.rs] Port {} already in use; assuming static proxy running.",
                    port
                );
                return Ok(format!("http://127.0.0.1:{}", port));
            }
            let err_msg = format!(
                "[Rust/proxy.rs] Failed to bind server to port {}: {}",
                port, e
            );
            log::error!("{}", err_msg);
            return Err(err_msg);
        }
    }
    .run();

    // Do NOT overwrite the main proxy server handle; run static proxy independently

    tauri::async_runtime::spawn(async move {
        if let Err(e) = server.await {
            log::error!("[Rust/proxy.rs] Proxy server run error: {}", e);
        } else {
            log::info!("[Rust/proxy.rs] Proxy server on port {} shut down.", port);
        }
    });

    Ok(format!("http://127.0.0.1:{}", port))
}

#[tauri::command]
pub async fn stop_proxy(
    session: Option<String>,
    server_handle_state: State<'_, ProxyServerHandle>,
    stream_url_store: State<'_, StreamUrlStore>,
) -> Result<(), String> {
    let key = session.unwrap_or_default();
    // 只移除该 session 的流地址；服务器是共享的，除非没有剩余 session 才整机停掉。
    let remaining;
    {
        let mut store = stream_url_store.url.lock().unwrap();
        store.remove(&key);
        remaining = store.len();
    }

    if remaining == 0 {
        let handle_to_stop = { server_handle_state.0.lock().unwrap().take() };
        if let Some(handle) = handle_to_stop {
            handle.stop(false).await;
            log::info!("[Rust/proxy.rs] stop_proxy: no sessions left, shutting down server.");
        }
    } else {
        log::info!(
            "[Rust/proxy.rs] stop_proxy: removed session '{}' ({} sessions remain).",
            key,
            remaining
        );
    }
    Ok(())
}
