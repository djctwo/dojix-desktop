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
