fn main() {
    // App commands the web view may call, each gated by a capability (capabilities/main.json).
    // Test-only commands exist only in builds made with the `e2e` feature.
    const COMMANDS: &[&str] = &[
        "app_info",
        "journal_query",
        "lock_status",
        "lock_unlock",
        "lock_setup",
        "lock_enable",
        "lock_change",
        "lock_disable",
        "lock_now",
        "lock_activity",
        "older_copy_open",
        "prefs_set_idle",
        "erase_all",
        "save_retry",
        "app_quit",
        "backup_export",
        "backup_pick",
        "backup_restore",
        // MT5 auto-import (Dojix; Greenwick answers "unsupported").
        "mt5_discover",
        "mt5_status",
        "mt5_watch_set",
        "mt5_add_folder",
        "mt5_remove_folder",
        "mt5_set_prefix",
        "mt5_rescan",
        "mt5_read",
        "mt5_import_commit",
    ];
    // The same list plus the test-only hooks.
    const COMMANDS_E2E: &[&str] = &[
        "app_info",
        "journal_query",
        "lock_status",
        "lock_unlock",
        "lock_setup",
        "lock_enable",
        "lock_change",
        "lock_disable",
        "lock_now",
        "lock_activity",
        "older_copy_open",
        "prefs_set_idle",
        "erase_all",
        "save_retry",
        "app_quit",
        "backup_export",
        "backup_pick",
        "backup_restore",
        "mt5_discover",
        "mt5_status",
        "mt5_watch_set",
        "mt5_add_folder",
        "mt5_remove_folder",
        "mt5_set_prefix",
        "mt5_rescan",
        "mt5_read",
        "mt5_import_commit",
        "e2e_status",
        "e2e_add_trade",
        "e2e_set_idle_seconds",
        "e2e_backup_export",
        "e2e_backup_pick",
        "e2e_mt5_roots",
        "e2e_mt5_add_folder",
    ];
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
