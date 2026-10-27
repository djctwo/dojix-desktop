//! Dojix / Greenwick desktop shell. The Rust process owns all state: the in-memory journal,
//! the key, the vault and every file operation. The web view only renders.

pub mod brand;
pub mod cli;
pub mod commands;
pub mod fsec;
pub mod instance;
pub mod journal;
pub mod logging;
pub mod paths;
pub mod seal;
pub mod selftest;
pub mod startup;
pub mod vault;

use std::sync::Mutex;

use tauri::Manager;

use crate::commands::{AppInfo, AppState, StorageState};
use crate::instance::LockOutcome;
use crate::paths::{DataPaths, OVERRIDES_ALLOWED};
use crate::vault::{OsVault, SecretStore, UnavailableVault};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn exit_with(message: &str, code: i32) -> ! {
    eprintln!("{message}");
    std::process::exit(code);
}

fn open_vault(service: &str) -> Box<dyn SecretStore> {
    match OsVault::new(service) {
        Ok(v) => Box::new(v),
        Err(reason) => {
            log::error!("credential vault unavailable: {reason}");
            Box::new(UnavailableVault { reason })
        }
    }
}

/// Opens storage for the GUI. Failures become a visible error state, never a silent fallback.
fn start(brand: &brand::Brand, paths: &DataPaths, vault: &dyn SecretStore) -> AppState {
    let base = |storage: StorageState| AppInfo {
        brand: brand.id,
        product_name: brand.product_name,
        version: VERSION,
        data_dir_source: paths.source.as_str(),
        vault_backend: vault.backend(),
        storage,
    };
    let error = |code: &'static str, message: String| AppState {
        info: base(StorageState::Error { code, message }),
        journal: None,
        _instance_lock: None,
        #[cfg(feature = "e2e")]
        data_dir_is_override: paths.source == crate::paths::DataDirSource::Override,
    };

    let lock = match instance::acquire(&paths.lock_file()) {
        Ok(LockOutcome::Held(lock)) => Some(lock),
        Ok(LockOutcome::AlreadyOpen) => {
            log::warn!("another copy already has this data folder open");
            return error(
                "already_open",
                format!("{} is already open.", brand.product_name),
            );
        }
        Ok(LockOutcome::Unsupported(e)) => {
            log::warn!("the data folder does not support file locks ({e}); opening anyway");
            None
        }
        Err(e) => {
            log::error!("could not open the lock file: {e}");
            return error(
                "io",
                format!("{} could not use its data folder.", brand.product_name),
            );
        }
    };

    match startup::open_journal(brand, paths, vault) {
        Ok(opened) => {
            log::info!(
                "journal open (created: {}, set aside: {}, generation {})",
                opened.created,
                opened.set_aside,
                opened.journal.generation()
            );
            let schema_version = opened.journal.schema_version().unwrap_or(0);
            AppState {
                info: base(StorageState::Ready {
                    encrypted: true,
                    schema_version,
                    set_aside: opened.set_aside,
                }),
                journal: Some(Mutex::new(opened.journal)),
                _instance_lock: lock,
                #[cfg(feature = "e2e")]
                data_dir_is_override: paths.source == crate::paths::DataDirSource::Override,
            }
        }
        Err(failure) => {
            log::error!("journal not opened: {}", failure.code);
            let mut state = error(failure.code, failure.message);
            state._instance_lock = lock;
            state
        }
    }
}

/// The WebView2 arguments Tauri uses when none are given (mini menu and SmartScreen off).
#[cfg(any(test, all(windows, feature = "e2e")))]
const TAURI_DEFAULT_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Joins two WebView2 switch lists, combining their `--disable-features=` lists into one.
#[cfg(any(test, all(windows, feature = "e2e")))]
fn merge_browser_args(base: &str, extra: &str) -> String {
    const KEY: &str = "--disable-features=";
    let mut features: Vec<&str> = Vec::new();
    let mut others: Vec<&str> = Vec::new();
    for arg in base.split_whitespace().chain(extra.split_whitespace()) {
        match arg.strip_prefix(KEY) {
            Some(list) => features.extend(list.split(',').filter(|f| !f.is_empty())),
            None => others.push(arg),
        }
    }
    let mut seen = std::collections::HashSet::new();
    features.retain(|f| seen.insert(*f));
    let mut out = others.join(" ");
    if !features.is_empty() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(KEY);
        out.push_str(&features.join(","));
    }
    out
}

pub fn run() {
    let brand = brand::CURRENT;
    let args = cli::parse(std::env::args_os()).unwrap_or_else(|msg| exit_with(&msg, 2));
    let paths = paths::resolve(
        &brand,
        OVERRIDES_ALLOWED,
        args.data_dir.as_deref(),
        std::env::var_os(brand.data_dir_env),
    )
    .unwrap_or_else(|e| exit_with(&e.to_string(), 2));
    let service = match args.vault_service.as_deref() {
        Some(name) if OVERRIDES_ALLOWED => name.to_string(),
        _ => brand.identifier.to_string(),
    };

    if let Err(e) = paths.ensure() {
        exit_with(&format!("could not create the data folder: {e}"), 1);
    }
    logging::init(
        &paths.logs(),
        brand.id,
        logging::default_redactions(&paths.root),
    );
    log::info!(
        "{} {VERSION} starting (data folder: {}, overrides allowed: {OVERRIDES_ALLOWED})",
        brand.product_name,
        paths.source.as_str()
    );

    #[cfg(all(windows, feature = "e2e"))]
    log::info!(
        "e2e build; WebDriver user-data folder set: {}",
        std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some()
    );

    let vault = open_vault(&service);

    if args.self_test {
        let report = selftest::run(&brand, &paths, vault.as_ref());
        log::info!("self-test finished (ok: {})", report.ok);
        let json = serde_json::to_string(&report).unwrap_or_else(|_| "{\"ok\":false}".into());
        println!("{json}");
        log::logger().flush();
        std::process::exit(if report.ok { 0 } else { 1 });
    }

    let state = start(&brand, &paths, vault.as_ref());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(state)
        .setup(move |app| {
            let configured = app.config().identifier.clone();
            if configured != brand.identifier {
                log::error!("configuration identifier does not match the build's brand");
                return Err(format!(
                    "built for {} but configured as {configured}",
                    brand.identifier
                )
                .into());
            }
            // The main window is created here rather than from the config, so the webview can
            // be adjusted per build before it exists.
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("no window configured")?;
            #[allow(unused_mut)]
            let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
            // e2e builds on Windows: msedgedriver watches its own WebView2 user-data folder for
            // the DevTools port file, but Tauri always passes a folder of its own. Use the
            // driver's folder so the WebDriver session can connect. Release builds never do this.
            #[cfg(all(windows, feature = "e2e"))]
            if let Some(dir) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
                window = window.data_directory(dir.into());
            }
            // Tauri passes its own WebView2 browser arguments, which take the place of the
            // driver's (including --remote-debugging-port), so merge the two in e2e builds.
            #[cfg(all(windows, feature = "e2e"))]
            if let Some(extra) = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
                let merged =
                    merge_browser_args(TAURI_DEFAULT_BROWSER_ARGS, &extra.to_string_lossy());
                window = window.additional_browser_args(&merged);
            }
            window.build()?;
            Ok(())
        });

    #[cfg(feature = "e2e")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::app_info,
        commands::journal_query,
        commands::e2e_status,
        commands::e2e_add_trade
    ]);
    #[cfg(not(feature = "e2e"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::app_info,
        commands::journal_query
    ]);

    if let Err(e) = builder.run(tauri::generate_context!()) {
        log::error!("the window system failed: {e}");
        exit_with("the window system failed", 1);
    }
}

#[cfg(test)]
mod tests {
    use super::{merge_browser_args, TAURI_DEFAULT_BROWSER_ARGS};

    #[test]
    fn merges_disable_features_and_keeps_the_driver_switches() {
        let merged = merge_browser_args(
            TAURI_DEFAULT_BROWSER_ARGS,
            "--enable-automation --disable-features=Prewarm,msWebOOUI --remote-debugging-port=0",
        );
        assert_eq!(
            merged,
            "--enable-automation --remote-debugging-port=0 \
             --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Prewarm"
        );
        assert_eq!(merge_browser_args("", ""), "");
    }
}
