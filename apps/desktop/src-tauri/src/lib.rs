//! Dojix / Greenwick desktop shell. The Rust process owns all state: the in-memory journal,
//! the key, the vault and every file operation. The web view only renders.

pub mod backup;
pub mod brand;
pub mod cli;
pub mod commands;
pub mod crypto;
pub mod fsec;
pub mod instance;
pub mod journal;
pub mod keyvault;
pub mod ledger;
pub mod logging;
pub mod paths;
pub mod prefs;
pub mod restore;
pub mod screenshots;
pub mod seal;
pub mod selftest;
pub mod session;
pub mod snapshot;
pub mod throttle;
pub mod triggers;
pub mod vault;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;
use crate::crypto::KdfParams;
use crate::instance::LockOutcome;
use crate::paths::{DataPaths, OVERRIDES_ALLOWED};
use crate::session::{Config, Core, Notifier, Store};
use crate::throttle::SystemClock;
use crate::vault::{OsVault, SecretStore, UnavailableVault};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// How often the idle timer and the daily snapshot are checked (SPEC 6.7).
const TICK: Duration = Duration::from_secs(5);

fn exit_with(message: &str, code: i32) -> ! {
    eprintln!("{message}");
    std::process::exit(code);
}

/// The credential store for this data folder (SPEC 6.4). On Linux without a usable Secret
/// Service, a new data folder uses the data-folder store (App Lock mandatory); once chosen,
/// that mode sticks. A folder that already has a journal never switches silently: an
/// unusable vault then fails closed.
fn open_vault(service: &str, paths: &DataPaths) -> Arc<dyn SecretStore> {
    #[cfg(target_os = "linux")]
    if vault::FolderVault::in_use(&paths.root) {
        log::info!("no system keyring for this data folder: App Lock key kept in the folder");
        return Arc::new(vault::FolderVault::new(&paths.root));
    }
    #[cfg(target_os = "linux")]
    let new_folder = !paths.journal().exists();
    #[cfg(not(target_os = "linux"))]
    let _ = paths;
    match OsVault::new(service) {
        Ok(v) => {
            #[cfg(target_os = "linux")]
            if new_folder
                && matches!(
                    v.lookup(vault::SELF_TEST_PROBE),
                    vault::Lookup::Failed(_)
                )
            {
                log::warn!("the Secret Service does not answer; App Lock will be required");
                return Arc::new(vault::FolderVault::new(&paths.root));
            }
            Arc::new(v)
        }
        Err(reason) => {
            log::error!("credential vault unavailable: {reason}");
            #[cfg(target_os = "linux")]
            if new_folder {
                return Arc::new(vault::FolderVault::new(&paths.root));
            }
            Arc::new(UnavailableVault { reason })
        }
    }
}

/// Tells the window layer what the session did. The handle arrives once the app is built.
struct WindowNotifier {
    app: Arc<OnceLock<AppHandle>>,
}

impl Notifier for WindowNotifier {
    fn locked(&self) {
        let Some(app) = self.app.get() else {
            return;
        };
        let _ = app.emit("locked", ());
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        // SPEC 6.6: drop everything the web view cached, then render the lock route in a
        // fresh document so no journal rows stay reachable from the old one.
        if let Err(e) = window.clear_all_browsing_data() {
            log::warn!("could not clear the web view's data on lock: {e}");
        }
        match window.url() {
            Ok(mut url) => {
                url.set_query(None);
                url.set_fragment(None);
                url.set_path("/");
                if let Err(e) = window.navigate(url) {
                    log::warn!("could not reload the web view on lock: {e}");
                }
            }
            Err(e) => log::warn!("could not read the web view's address: {e}"),
        }
    }

    fn save_state(&self, failing: bool) {
        if let Some(app) = self.app.get() {
            let _ = app.emit("save_failed", failing);
        }
    }
}

/// Opens storage for the GUI. Failures become a visible error state, never a silent fallback.
fn start(
    brand: &brand::Brand,
    paths: &DataPaths,
    vault: Arc<dyn SecretStore>,
    app_slot: Arc<OnceLock<AppHandle>>,
) -> AppState {
    let state = |store: Option<Store>,
                 error: Option<(&'static str, String)>,
                 lock: Option<instance::InstanceLock>| {
        AppState::new(
            brand.id,
            brand.product_name,
            VERSION,
            paths.source.as_str(),
            vault.backend(),
            store,
            error,
            lock,
        )
    };
    let lock = match instance::acquire(&paths.lock_file()) {
        Ok(LockOutcome::Held(lock)) => Some(lock),
        Ok(LockOutcome::AlreadyOpen) => {
            log::warn!("another copy already has this data folder open");
            let message = format!("{} is already open.", brand.product_name);
            return state(None, Some(("already_open", message)), None);
        }
        Ok(LockOutcome::Unsupported(e)) => {
            log::warn!("the data folder does not support file locks ({e}); opening anyway");
            None
        }
        Err(e) => {
            log::error!("could not open the lock file: {e}");
            let message = format!("{} could not use its data folder.", brand.product_name);
            return state(None, Some(("io", message)), None);
        }
    };
    let core = Core::new(
        Config {
            brand: *brand,
            paths: paths.clone(),
            vault: vault.clone(),
            kdf: KdfParams::DEFAULT,
            clock: Arc::new(SystemClock),
        },
        Box::new(WindowNotifier { app: app_slot }),
    );
    match Store::spawn(core) {
        Ok(store) => state(Some(store), None, lock),
        Err(e) => {
            log::error!("could not start the journal thread: {e}");
            let message = format!("{} could not start.", brand.product_name);
            state(None, Some(("io", message)), lock)
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

/// Starts the 5-second ticker (idle lock, daily snapshot).
fn start_ticker(store: Store) {
    let spawned = std::thread::Builder::new()
        .name("idle-ticker".into())
        .spawn(move || loop {
            std::thread::sleep(TICK);
            store.post(|c| c.tick());
        });
    if let Err(e) = spawned {
        log::error!("could not start the idle timer: {e}");
    }
}

/// A lock request from the OS (session lock, sleep, user switch) or the window (minimize).
fn os_lock(store: &Store) -> triggers::OnTrigger {
    let store = store.clone();
    Arc::new(move |why: &'static str| {
        store.post(move |c| {
            c.lock(why);
        });
    })
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

    let vault = open_vault(&service, &paths);

    if args.self_test {
        let report = selftest::run(&brand, &paths, vault.as_ref());
        log::info!("self-test finished (ok: {})", report.ok);
        let json = serde_json::to_string(&report).unwrap_or_else(|_| "{\"ok\":false}".into());
        println!("{json}");
        log::logger().flush();
        std::process::exit(if report.ok { 0 } else { 1 });
    }

    let app_slot: Arc<OnceLock<AppHandle>> = Arc::new(OnceLock::new());
    let state = start(&brand, &paths, vault, app_slot.clone());
    let store = state.store.clone();
    let webview_dir = paths.webview_dir(&brand);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
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
            let _ = app_slot.set(app.handle().clone());
            // The main window is created here rather than from the config, so the webview can
            // be adjusted per build before it exists.
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("no window configured")?;
            // SPEC 6.2: the web view's own files (caches, cookies, IndexedDB: plain SQLite)
            // never live in the journal's data folder, and private mode keeps most of them
            // off the disk entirely.
            let mut window =
                tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?.incognito(true);
            if let Some(dir) = webview_dir.clone() {
                if let Err(e) = fsec::create_private_dir(&dir) {
                    log::warn!("could not prepare the web view folder: {e}");
                }
                window = window.data_directory(dir);
            }
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
            #[allow(unused_variables)]
            let window = window.build()?;

            if let Some(store) = store.clone() {
                start_ticker(store.clone());
                #[cfg(windows)]
                match window.hwnd() {
                    Ok(hwnd) => {
                        if let Err(e) = triggers::install_windows(hwnd.0, os_lock(&store)) {
                            log::warn!("OS lock triggers unavailable: {e}");
                        }
                    }
                    Err(e) => log::warn!("OS lock triggers unavailable: {e}"),
                }
                #[cfg(target_os = "linux")]
                triggers::install_linux(os_lock(&store));

                let events = store.clone();
                let on_minimize = os_lock(&store);
                let handle = app.handle().clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::Focused(true) => events.post(|c| c.activity()),
                    tauri::WindowEvent::Resized(_) => {
                        let minimized = handle
                            .get_webview_window("main")
                            .and_then(|w| w.is_minimized().ok())
                            .unwrap_or(false);
                        if minimized {
                            on_minimize("minimize");
                        }
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        // SPEC 6.3: quitting with unsaved changes asks first.
                        if events.has_unsaved() {
                            api.prevent_close();
                            let _ = handle.emit("unsaved_close", ());
                        }
                    }
                    _ => {}
                });
            }
            Ok(())
        });

    #[cfg(feature = "e2e")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::app_info,
        commands::journal_query,
        commands::lock_status,
        commands::lock_unlock,
        commands::lock_setup,
        commands::lock_enable,
        commands::lock_change,
        commands::lock_disable,
        commands::lock_now,
        commands::lock_activity,
        commands::older_copy_open,
        commands::prefs_set_idle,
        commands::erase_all,
        commands::save_retry,
        commands::app_quit,
        commands::backup_export,
        commands::backup_pick,
        commands::backup_restore,
        commands::e2e_status,
        commands::e2e_add_trade,
        commands::e2e_set_idle_seconds,
        commands::e2e_backup_export,
        commands::e2e_backup_pick
    ]);
    #[cfg(not(feature = "e2e"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::app_info,
        commands::journal_query,
        commands::lock_status,
        commands::lock_unlock,
        commands::lock_setup,
        commands::lock_enable,
        commands::lock_change,
        commands::lock_disable,
        commands::lock_now,
        commands::lock_activity,
        commands::older_copy_open,
        commands::prefs_set_idle,
        commands::erase_all,
        commands::save_retry,
        commands::app_quit,
        commands::backup_export,
        commands::backup_pick,
        commands::backup_restore
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
