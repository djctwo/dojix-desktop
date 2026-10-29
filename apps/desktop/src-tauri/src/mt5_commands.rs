//! MT5 auto-import commands (SPEC 5.4, 7.4). The feature is compiled only into Dojix; a
//! Greenwick build has the same command names, each answering `unsupported`, so both brands
//! share one capability file.
//!
//! Flow: `mt5_status` (re)starts the watcher for the enabled folders whenever the journal is
//! unlocked; the watcher emits `mt5_file_ready`; the web view reads each queued file with
//! `mt5_read`, parses it with `packages/importers` and hands the result to
//! `mt5_import_commit`, which commits it and emits `mt5_imported` (and `trades_changed` when
//! trades were added). The web view can read only files the watcher queued.
//!
//! Commands: `mt5_discover`, `mt5_status`, `mt5_watch_set`, `mt5_add_folder`,
//! `mt5_remove_folder`, `mt5_set_prefix`, `mt5_rescan`, `mt5_read`, `mt5_import_commit`;
//! test-only (`e2e` feature): `e2e_mt5_roots`, `e2e_mt5_add_folder`.

#[cfg(feature = "brand-dojix")]
pub mod dojix {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Arc, OnceLock};

    use tauri::{AppHandle, Emitter, State};

    use crate::commands::{blocking, AppState};
    use crate::mt5::discover::Roots;
    use crate::mt5::watch::{Sink, TakeError, Timing};
    use crate::mt5::{self, Config, ImportSummary, LocationView, Service, Status};
    use crate::mt5_journal::{self, Outcome};
    use crate::session::{OpError, Store};

    /// The MT5 service, managed by Tauri in Dojix builds.
    pub struct Mt5State {
        pub service: Arc<Service>,
    }

    /// Emits `mt5_file_ready` (the number of queued files) to the window.
    pub struct EventSink {
        pub app: Arc<OnceLock<AppHandle>>,
    }

    impl Sink for EventSink {
        fn files_ready(&self, pending: usize) {
            if let Some(app) = self.app.get() {
                let _ = app.emit("mt5_file_ready", pending);
            }
        }
    }

    /// The app's service: real discovery roots, the default timing.
    pub fn new_service(app: Arc<OnceLock<AppHandle>>) -> Arc<Service> {
        Arc::new(Service::new(
            Arc::new(EventSink { app }),
            Roots::system(),
            Timing::default(),
        ))
    }

    fn read_failed(e: impl std::fmt::Display) -> OpError {
        log::error!("MT5 settings could not be read: {e}");
        OpError::new("read", "The journal could not be read.")
    }

    fn config_of(store: &Store) -> Result<Config, OpError> {
        store.call(|c| {
            let j = c.journal()?;
            mt5_journal::read_config(j.conn()).map_err(read_failed)
        })?
    }

    fn save_config(store: &Store, config: Config) -> Result<(), OpError> {
        store.call(move |c| {
            c.with_journal(|j| j.write(|tx| mt5_journal::write_config(tx, &config)))
        })?
    }

    /// Reads the settings and makes the watcher match them (the journal must be unlocked).
    fn sync(store: &Store, service: &Service) -> Result<Config, OpError> {
        let config = config_of(store)?;
        let ledger = if config.enabled.is_empty() || service.matches(&config) {
            HashMap::new()
        } else {
            store.call(|c| {
                let j = c.journal()?;
                mt5_journal::read_ledger(j.conn()).map_err(read_failed)
            })??
        };
        service.reconcile(&config, move || ledger).map_err(|e| {
            log::error!("MT5 watcher could not start: {e}");
            OpError::new("mt5_start", "MetaTrader 5 auto-import could not start.")
        })?;
        Ok(config)
    }

    fn take_error(e: TakeError) -> OpError {
        match e {
            TakeError::Unknown => OpError::new(
                "not_pending",
                "That file is no longer waiting to be imported.",
            ),
            TakeError::Changed => OpError::new(
                "changed",
                "The file changed while it was being read; it will be read again.",
            ),
            TakeError::Gone => OpError::new("gone", "The file was deleted."),
            TakeError::Busy => OpError::new(
                "busy_file",
                "MetaTrader 5 is still writing the file; it will be read again.",
            ),
            TakeError::Unreadable(why) => OpError::new("unreadable", why),
        }
    }

    /// Every MT5 folder found on this computer, plus the user's own, with a preview of the
    /// files in each. Nothing is watched until a folder is enabled.
    #[tauri::command]
    pub async fn mt5_discover(
        state: State<'_, AppState>,
        mt5: State<'_, Mt5State>,
    ) -> Result<Vec<LocationView>, OpError> {
        let store = state.store()?;
        let service = mt5.service.clone();
        blocking(move || {
            let config = config_of(&store)?;
            Ok(service.locations(&config))
        })
        .await
    }

    /// The watcher's state. Also starts it after an unlock (the UI calls this then).
    #[tauri::command]
    pub async fn mt5_status(
        state: State<'_, AppState>,
        mt5: State<'_, Mt5State>,
    ) -> Result<Status, OpError> {
        let store = state.store()?;
        let service = mt5.service.clone();
        blocking(move || {
            let config = sync(&store, &service)?;
            Ok(service.status(&config))
        })
        .await
    }

    /// Turns watching one listed folder on or off.
    #[tauri::command]
    pub async fn mt5_watch_set(
        state: State<'_, AppState>,
        mt5: State<'_, Mt5State>,
        id: String,
        enabled: bool,
    ) -> Result<Status, OpError> {
        let store = state.store()?;
        let service = mt5.service.clone();
        blocking(move || {
            let mut config = config_of(&store)?;
            let location = service
                .find(&config, &id)
                .ok_or_else(|| OpError::new("not_found", "That folder is no longer listed."))?;
            config.enabled.retain(|p| p != &location.path);
            if enabled {
                config.enabled.push(location.path.clone());
            }
            save_config(&store, config.sanitized())?;
            log::info!(
                "MT5 folder {} {}",
                location.id,
                if enabled { "on" } else { "off" }
            );
            let config = sync(&store, &service)?;
            Ok(service.status(&config))
        })
        .await
    }

    fn add_folder(
        store: &Store,
        service: &Service,
        path: PathBuf,
    ) -> Result<LocationView, OpError> {
        let path_text = path.to_string_lossy().into_owned();
        // Checked before the folder is touched at all: no network shares or device paths.
        if mt5::safe_path::path_problem(&path_text).is_some() {
            return Err(OpError::new(
                "unsafe_folder",
                "Choose a folder on this computer (network shares can't be watched).",
            ));
        }
        if !mt5::ro::is_dir(&path) {
            return Err(OpError::new("not_found", "That folder can't be opened."));
        }
        let mut config = config_of(store)?;
        if !config.custom.contains(&path_text) {
            config.custom.push(path_text.clone());
        }
        let config = config.sanitized();
        save_config(store, config.clone())?;
        service
            .locations(&config)
            .into_iter()
            .find(|v| v.location.path == path_text)
            .ok_or_else(|| OpError::new("not_found", "That folder can't be used."))
    }

    /// "Add folder…": a folder dialog opens in Rust. The folder is listed (with its preview)
    /// but not watched until it is enabled. `None` when cancelled.
    #[tauri::command]
    pub async fn mt5_add_folder(
        app: AppHandle,
        state: State<'_, AppState>,
        mt5: State<'_, Mt5State>,
    ) -> Result<Option<LocationView>, OpError> {
        use tauri_plugin_dialog::DialogExt;
        let store = state.store()?;
        let service = mt5.service.clone();
        blocking(move || {
            let Some(chosen) = app.dialog().file().blocking_pick_folder() else {
                return Ok(None);
            };
            let path = chosen
                .into_path()
                .map_err(|_| OpError::new("not_found", "That folder can't be used."))?;
            add_folder(&store, &service, path).map(Some)
        })
        .await
    }

    /// Removes a folder the user added (and stops watching it).
    #[tauri::command]
    pub async fn mt5_remove_folder(
        state: State<'_, AppState>,
        mt5: State<'_, Mt5State>,
        id: String,
    ) -> Result<Status, OpError> {
        let store = state.store()?;
        let service = mt5.service.clone();
        blocking(move || {
            let mut config = config_of(&store)?;
            let id_of = |p: &String| mt5::discover::location_id(&PathBuf::from(p));
            config.custom.retain(|p| id_of(p) != id);
            config.enabled.retain(|p| id_of(p) != id);
            save_config(&store, config)?;
            let config = sync(&store, &service)?;
            Ok(service.status(&config))
        })
        .await
    }

    /// Sets the 32-column export's file-name prefix (`None` = the default).
    #[tauri::command]
    pub async fn mt5_set_prefix(
        state: State<'_, AppState>,
        mt5: State<'_, Mt5State>,
        prefix: Option<String>,
    ) -> Result<Status, OpError> {
        if let Some(problem) = prefix.as_deref().and_then(mt5::prefix_problem) {
            return Err(OpError::new("invalid_prefix", problem));
        }
        let store = state.store()?;
        let service = mt5.service.clone();
        blocking(move || {
            let mut config = config_of(&store)?;
            config.prefix32 = prefix;
            save_config(&store, config)?;
            let config = sync(&store, &service)?;
            Ok(service.status(&config))
        })
        .await
    }

    /// Looks at the enabled folders now instead of at the next poll.
    #[tauri::command]
    pub async fn mt5_rescan(
        state: State<'_, AppState>,
        mt5: State<'_, Mt5State>,
    ) -> Result<Status, OpError> {
        let store = state.store()?;
        let service = mt5.service.clone();
        blocking(move || {
            let config = sync(&store, &service)?;
            service.rescan();
            Ok(service.status(&config))
        })
        .await
    }

    /// The bytes of a queued file (raw, not JSON).
    #[tauri::command]
    pub async fn mt5_read(
        state: State<'_, AppState>,
        mt5: State<'_, Mt5State>,
        token: u64,
    ) -> Result<tauri::ipc::Response, OpError> {
        let store = state.store()?;
        let service = mt5.service.clone();
        blocking(move || {
            // Only while unlocked (the watcher is stopped while locked anyway).
            store.call(|c| c.journal().map(|_| ()))??;
            let (_, bytes) = service.read(token).map_err(take_error)?;
            Ok(tauri::ipc::Response::new(bytes))
        })
        .await
    }

    /// Commits what the web view made of a queued file (see `mt5_journal::commit`).
    #[tauri::command]
    pub async fn mt5_import_commit(
        app: AppHandle,
        state: State<'_, AppState>,
        mt5: State<'_, Mt5State>,
        token: u64,
        outcome: Outcome,
    ) -> Result<ImportSummary, OpError> {
        let store = state.store()?;
        let service = mt5.service.clone();
        let summary = blocking(move || {
            let file = service
                .pending(token)
                .ok_or_else(|| take_error(TakeError::Unknown))?;
            let prepared =
                mt5_journal::prepare(outcome).map_err(|r| OpError::new("invalid_import", r.0))?;
            let now_ms = crate::journal::now_ms();
            let commit_file = file.clone();
            let summary = store.call(move |c| {
                c.with_journal(|j| mt5_journal::apply(j, &commit_file, prepared, now_ms))
            })??;
            service.finish(token, summary.clone());
            log::info!(
                "MT5 auto-import: {} ({} added, {} duplicates, {} skipped)",
                summary.result,
                summary.inserted,
                summary.duplicates,
                summary.skipped
            );
            Ok(summary)
        })
        .await?;
        if summary.inserted > 0 {
            let _ = app.emit("trades_changed", ());
        }
        let _ = app.emit("mt5_imported", summary.clone());
        Ok(summary)
    }

    /// Test-only: discovery roots (a synthetic MT5 tree).
    #[cfg(feature = "e2e")]
    #[tauri::command]
    pub fn e2e_mt5_roots(
        mt5: State<'_, Mt5State>,
        appdata: Vec<String>,
        program_files: Vec<String>,
        wine_prefixes: Vec<String>,
    ) {
        let paths = |v: Vec<String>| v.into_iter().map(PathBuf::from).collect();
        mt5.service.set_roots(Roots {
            appdata: paths(appdata),
            program_files: paths(program_files),
            wine_prefixes: paths(wine_prefixes),
        });
    }

    /// Test-only: "Add folder…" without the dialog.
    #[cfg(feature = "e2e")]
    #[tauri::command]
    pub async fn e2e_mt5_add_folder(
        state: State<'_, AppState>,
        mt5: State<'_, Mt5State>,
        path: String,
    ) -> Result<LocationView, OpError> {
        let store = state.store()?;
        let service = mt5.service.clone();
        blocking(move || add_folder(&store, &service, PathBuf::from(path))).await
    }
}

/// Greenwick: the MT5 commands exist (one shared capability file) and answer `unsupported`.
#[cfg(not(feature = "brand-dojix"))]
pub mod greenwick {
    use crate::session::OpError;

    fn unsupported() -> Result<(), OpError> {
        Err(OpError::new(
            "unsupported",
            "MetaTrader 5 import is part of Dojix.",
        ))
    }

    #[tauri::command]
    pub fn mt5_discover() -> Result<(), OpError> {
        unsupported()
    }
    #[tauri::command]
    pub fn mt5_status() -> Result<(), OpError> {
        unsupported()
    }
    #[tauri::command]
    pub fn mt5_watch_set() -> Result<(), OpError> {
        unsupported()
    }
    #[tauri::command]
    pub fn mt5_add_folder() -> Result<(), OpError> {
        unsupported()
    }
    #[tauri::command]
    pub fn mt5_remove_folder() -> Result<(), OpError> {
        unsupported()
    }
    #[tauri::command]
    pub fn mt5_set_prefix() -> Result<(), OpError> {
        unsupported()
    }
    #[tauri::command]
    pub fn mt5_rescan() -> Result<(), OpError> {
        unsupported()
    }
    #[tauri::command]
    pub fn mt5_read() -> Result<(), OpError> {
        unsupported()
    }
    #[tauri::command]
    pub fn mt5_import_commit() -> Result<(), OpError> {
        unsupported()
    }
    #[cfg(feature = "e2e")]
    #[tauri::command]
    pub fn e2e_mt5_roots() -> Result<(), OpError> {
        unsupported()
    }
    #[cfg(feature = "e2e")]
    #[tauri::command]
    pub fn e2e_mt5_add_folder() -> Result<(), OpError> {
        unsupported()
    }
}
