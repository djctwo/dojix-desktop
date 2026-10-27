fn main() {
    // App commands the web view may call, each gated by a capability (capabilities/main.json).
    // Test-only commands exist only in builds made with the `e2e` feature.
    const COMMANDS: &[&str] = &["app_info", "journal_query"];
    const COMMANDS_E2E: &[&str] = &["app_info", "journal_query", "e2e_status", "e2e_add_trade"];
    let commands = if std::env::var_os("CARGO_FEATURE_E2E").is_some() {
        COMMANDS_E2E
    } else {
        COMMANDS
    };
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("tauri-build failed");
}
