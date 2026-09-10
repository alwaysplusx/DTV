use std::fs;
use std::io::Result;

fn main() -> Result<()> {
    let out_path = "src/platforms/douyin/danmu/gen";

    // Ensure the output directory exists
    fs::create_dir_all(out_path)?;

    prost_build::Config::new()
        .out_dir(out_path) // Specify the output directory within the project
        .compile_protos(
            &["src/platforms/douyin/danmu/douyin.proto"], // Corrected path
            &["src/platforms/douyin/danmu/"], // Kept include path, ensure it's correct for any imports in douyin.proto
        )
        .expect("Failed to compile danmu protos");

  // macOS 26 (Tahoe) 只对 LC_BUILD_VERSION 记录 sdk>=26 的二进制启用新版窗口控件
  // （更大的红绿灯，圆点 12pt→14pt）；本机/CI 常常只有旧 CommandLineTools SDK（如 15.x），
  // 链接出的包在 Tahoe 上红绿灯保持旧样式。这里在链接期把记录的 sdk 抬到 26.0，
  // 效果等同于用 Xcode 26 构建。
  // min（部署目标）必须钳到架构下限而非透传环境值：rustc 对 aarch64 的下限是 11.0
  // （MACOSX_DEPLOYMENT_TARGET 更低会被 rustc 忽略，但这里若照传，链接 min 就低于
  // 预编译 rlib / cc 产物的 11.0，___chkstk_darwin 只在 libSystem 11+ 存在 → 断链）。
  // x86_64 下限取 Tauri 支持的 10.13。此参数是最后一个 -platform_version，会覆盖 rustc 的默认。
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    let floor = if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64") {
      (11, 0)
    } else {
      (10, 13)
    };
    let min = std::env::var("MACOSX_DEPLOYMENT_TARGET")
      .ok()
      .and_then(|s| {
        let mut it = s.split('.');
        let major = it.next()?.parse().ok()?;
        let minor = it.next().map_or(Ok(0), |m| m.parse()).unwrap_or(0);
        Some((major, minor))
      })
      .map(|v| if v < floor { floor } else { v })
      .unwrap_or(floor);
    println!("cargo:rustc-link-arg=-Wl,-platform_version,macos,{}.{},26.0", min.0, min.1);
  }

    tauri_build::build(); // Call this if it's needed by your Tauri setup, otherwise can be removed if you handle tauri specific build steps elsewhere.

    Ok(())
}
