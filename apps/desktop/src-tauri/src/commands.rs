//! The IPC surface. Every command is allow-listed in `capabilities/main.json`; test-only
//! commands exist only with the `e2e` feature (and its capability overlay).
//!
//! No command returns a key, a password or a secret. Passwords arrive as strings and are
//! wrapped in `Zeroizing` at once. Every journal operation runs on the store thread (the
//! single writer); blocking work runs off the async runtime's workers.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use zeroize::Zeroizing;

use crate::backup::{BackupKind, MAX_BACKUP_BYTES};
use crate::fsec;
use crate::instance::InstanceLock;
use crate::journal::{JournalRow, SCHEMA_VERSION};
use crate::restore::RestoreSummary;
use crate::session::{LockStatus, OpError, Outcome, Phase, Store};

/// Startup status shown by the UI. Never contains paths, keys or trade data.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub brand: &'static str,
    pub product_name: &'static str,
    pub version: &'static str,
    pub data_dir_source: &'static str,
    pub vault_backend: &'static str,
    pub storage: StorageState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StorageState {
    Ready {
        encrypted: bool,
        schema_version: usize,
        set_aside: bool,
    },
    Error {
        code: &'static str,
        message: String,
    },
}

/// A backup file chosen for restore (the path stays in Rust).
struct Picked {
    path: PathBuf,
    file_name: String,
}

pub struct AppState {
    pub brand: &'static str,
    pub product_name: &'static str,
    pub version: &'static str,
    pub data_dir_source: &'static str,
    pub vault_backend: &'static str,
    /// None when another copy holds the data folder (or start-up failed early).
    pub store: Option<Store>,
    pub startup_error: Option<(&'static str, String)>,
    /// Held for the life of the process: one running copy per data folder.
    pub _instance_lock: Option<InstanceLock>,
    picked: Mutex<Option<Picked>>,
    #[cfg(feature = "e2e")]
    pub data_dir_is_override: bool,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        brand: &'static str,
        product_name: &'static str,
        version: &'static str,
        data_dir_source: &'static str,
        vault_backend: &'static str,
        store: Option<Store>,
        startup_error: Option<(&'static str, String)>,
        instance_lock: Option<InstanceLock>,
    ) -> Self {
        Self {
            brand,
            product_name,
            version,
            data_dir_source,
            vault_backend,
            store,
            startup_error,
            _instance_lock: instance_lock,
            picked: Mutex::new(None),
            #[cfg(feature = "e2e")]
            data_dir_is_override: data_dir_source == "override",
        }
    }

    fn store(&self) -> Result<Store, OpError> {
        match (&self.store, &self.startup_error) {
            (Some(store), _) => Ok(store.clone()),
            (None, Some((code, message))) => Err(OpError::new(code, message.clone())),
            (None, None) => Err(OpError::new("store", "The journal is not open.")),
        }
    }
}

/// Runs blocking work (store calls, dialogs, file I/O) off the async runtime's workers.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, OpError> + Send + 'static,
) -> Result<T, OpError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| OpError::new("store", "The operation stopped unexpectedly."))?
}

fn secret(value: String) -> Zeroizing<String> {
    Zeroizing::new(value)
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> Result<AppInfo, OpError> {
    let storage = match state.store() {
        Err(e) => StorageState::Error {
            code: e.code,
            message: e.message,
        },
        Ok(store) => {
            let status = blocking(move || store.call(|c| c.status())).await?;
            match status.phase {
                Phase::Failed { code, message } => StorageState::Error { code, message },
                _ => StorageState::Ready {
                    encrypted: true,
                    schema_version: SCHEMA_VERSION,
                    set_aside: status.set_aside,
                },
            }
        }
    };
    Ok(AppInfo {
        brand: state.brand,
        product_name: state.product_name,
        version: state.version,
        data_dir_source: state.data_dir_source,
        vault_backend: state.vault_backend,
        storage,
    })
}

const MAX_ROWS: u32 = 5_000;

/// The newest trades, at most `limit` (capped at 5,000).
#[tauri::command]
pub async fn journal_query(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<JournalRow>, OpError> {
    let store = state.store()?;
    blocking(move || {
        store.call(move |c| {
            c.journal()?.recent(limit.min(MAX_ROWS)).map_err(|e| {
                log::error!("journal_query failed: {e}");
                OpError::new("read", "The journal could not be read.")
            })
        })?
    })
    .await
}

#[tauri::command]
pub async fn lock_status(state: State<'_, AppState>) -> Result<LockStatus, OpError> {
    let store = state.store()?;
    blocking(move || store.call(|c| c.status())).await
}

#[tauri::command]
pub async fn lock_unlock(
    state: State<'_, AppState>,
    password: String,
) -> Result<LockStatus, OpError> {
    let store = state.store()?;
    let password = secret(password);
    blocking(move || store.key_op(move |c| c.unlock(&password))).await
}

#[tauri::command]
pub async fn lock_setup(
    state: State<'_, AppState>,
    password: String,
    confirmation: String,
) -> Result<LockStatus, OpError> {
    let store = state.store()?;
    let (password, confirmation) = (secret(password), secret(confirmation));
    blocking(move || store.key_op(move |c| c.setup(&password, &confirmation))).await
}

#[tauri::command]
pub async fn lock_enable(
    state: State<'_, AppState>,
    password: String,
    confirmation: String,
) -> Result<Outcome, OpError> {
    let store = state.store()?;
    let (password, confirmation) = (secret(password), secret(confirmation));
    blocking(move || store.key_op(move |c| c.enable(&password, &confirmation))).await
}

#[tauri::command]
pub async fn lock_change(
    state: State<'_, AppState>,
    current: String,
    password: String,
    confirmation: String,
) -> Result<Outcome, OpError> {
    let store = state.store()?;
    let (current, password, confirmation) =
        (secret(current), secret(password), secret(confirmation));
    blocking(move || store.key_op(move |c| c.change(&current, &password, &confirmation))).await
}

#[tauri::command]
pub async fn lock_disable(
    state: State<'_, AppState>,
    password: String,
) -> Result<LockStatus, OpError> {
    let store = state.store()?;
    let password = secret(password);
    blocking(move || store.key_op(move |c| c.disable(&password))).await
}

#[tauri::command]
pub async fn lock_now(state: State<'_, AppState>) -> Result<bool, OpError> {
    let store = state.store()?;
    blocking(move || store.call(|c| c.lock("lock now"))).await
}

/// Input in the web view (throttled there to one call every few seconds).
#[tauri::command]
pub fn lock_activity(state: State<'_, AppState>) {
    if let Ok(store) = state.store() {
        store.post(|c| c.activity());
    }
}

#[tauri::command]
pub async fn older_copy_open(
    state: State<'_, AppState>,
    password: Option<String>,
    confirmed: bool,
) -> Result<LockStatus, OpError> {
    let store = state.store()?;
    let password = password.map(secret);
    blocking(move || {
        store.key_op(move |c| c.open_older(password.as_ref().map(|p| p.as_str()), confirmed))
    })
    .await
}

#[tauri::command]
pub async fn prefs_set_idle(state: State<'_, AppState>, minutes: u32) -> Result<(), OpError> {
    let store = state.store()?;
    blocking(move || store.call(move |c| c.set_idle_minutes(minutes))?).await
}

/// "Erase all local data" (also "Forgot password?"). `confirmation` = the product name.
#[tauri::command]
pub async fn erase_all(
    state: State<'_, AppState>,
    confirmation: String,
) -> Result<LockStatus, OpError> {
    let store = state.store()?;
    blocking(move || store.call(move |c| c.erase(&confirmation))?).await
}

#[tauri::command]
pub async fn save_retry(state: State<'_, AppState>) -> Result<(), OpError> {
    let store = state.store()?;
    blocking(move || store.call(|c| c.retry_save())?).await
}

/// Quits. Without `force`, a failed save is tried again first and the quit is refused if it
/// still fails (the UI then offers "Quit anyway").
#[tauri::command]
pub async fn app_quit(
    app: AppHandle,
    state: State<'_, AppState>,
    force: bool,
) -> Result<(), OpError> {
    if !force {
        if let Ok(store) = state.store() {
            blocking(move || store.call(|c| c.retry_save())?).await?;
        }
    } else {
        log::warn!("quitting with unsaved changes at the user's request");
    }
    app.exit(0);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------------------------

fn today() -> String {
    let ms = crate::journal::now_ms().max(0) as u64;
    crate::logging::utc_timestamp(ms / 1000)[..10].to_string()
}

/// Makes the backup bytes on the store thread and writes them owner-only to `path`.
fn write_backup(
    store: &Store,
    path: PathBuf,
    password: Option<(Zeroizing<String>, Zeroizing<String>)>,
) -> Result<(), OpError> {
    let bytes = store.call(move |c| {
        c.backup_bytes(
            password
                .as_ref()
                .map(|(p, confirm)| (p.as_str(), confirm.as_str())),
        )
    })??;
    fsec::write_atomic(&path, &bytes).map_err(|e| {
        log::error!("backup not written: {e}");
        OpError::new("backup_failed", "The backup file could not be written.")
    })
}

/// Export Backup: the save dialog opens from Rust (the web view has no file access).
/// Returns the chosen file name, or `None` when cancelled.
#[tauri::command]
pub async fn backup_export(
    app: AppHandle,
    state: State<'_, AppState>,
    password: Option<String>,
    confirmation: Option<String>,
) -> Result<Option<String>, OpError> {
    use tauri_plugin_dialog::DialogExt;
    let store = state.store()?;
    let product = state.product_name;
    let password = password.map(|p| (secret(p), secret(confirmation.unwrap_or_default())));
    if let Some((p, c)) = password.as_ref() {
        if let Some(problem) = crate::session::password_problem(p, c) {
            return Err(OpError::new("invalid_password", problem));
        }
    }
    blocking(move || {
        let (ext, label) = if password.is_some() {
            ("dxbk", "Password-protected backup")
        } else {
            ("db", "Unencrypted backup")
        };
        let chosen = app
            .dialog()
            .file()
            .set_file_name(format!("{product} backup {}.{ext}", today()))
            .add_filter(label, &[ext])
            .blocking_save_file();
        let Some(chosen) = chosen else {
            return Ok(None);
        };
        let path = chosen
            .into_path()
            .map_err(|_| OpError::new("backup_failed", "That location can't be used."))?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        write_backup(&store, path, password)?;
        log::info!("backup exported");
        Ok(Some(name))
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedBackup {
    pub file_name: String,
    pub kind: BackupKind,
    pub needs_password: bool,
}

fn pick(path: PathBuf, state: &AppState) -> Result<PickedBackup, OpError> {
    let meta = std::fs::metadata(&path)
        .map_err(|_| OpError::new("restore_refused", "The file could not be read."))?;
    if meta.len() > MAX_BACKUP_BYTES {
        return Err(OpError::new(
            "restore_refused",
            "The backup is larger than 512 MB, so it was not restored.",
        ));
    }
    let mut head = [0u8; 16];
    let n = {
        use std::io::Read;
        let mut file = std::fs::File::open(&path)
            .map_err(|_| OpError::new("restore_refused", "The file could not be read."))?;
        file.read(&mut head)
            .map_err(|_| OpError::new("restore_refused", "The file could not be read."))?
    };
    let kind = crate::backup::kind(&head[..n]);
    if kind == BackupKind::Unknown {
        return Err(OpError::new(
            "restore_refused",
            "The selected file is not a backup.",
        ));
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    *state
        .picked
        .lock()
        .map_err(|_| OpError::new("store", "Try again."))? = Some(Picked {
        path,
        file_name: file_name.clone(),
    });
    Ok(PickedBackup {
        file_name,
        kind,
        needs_password: kind.needs_password(),
    })
}

/// Restore, step 1: choose the file (open dialog in Rust). `None` when cancelled.
#[tauri::command]
pub async fn backup_pick(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<PickedBackup>, OpError> {
    use tauri_plugin_dialog::DialogExt;
    let chosen = blocking(move || {
        Ok(app
            .dialog()
            .file()
            .add_filter(
                "Backups",
                &["dxbk", "db", "sqlite", "dojixbackup", "gwbackup", "backup"],
            )
            .blocking_pick_file())
    })
    .await?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|_| OpError::new("restore_refused", "That file can't be used."))?;
    pick(path, &state).map(Some)
}

/// Restore, step 2: validate and replace the journal's contents (one transaction).
#[tauri::command]
pub async fn backup_restore(
    state: State<'_, AppState>,
    password: Option<String>,
) -> Result<RestoreSummary, OpError> {
    let store = state.store()?;
    let (path, file_name) = {
        let picked = state
            .picked
            .lock()
            .map_err(|_| OpError::new("store", "Try again."))?;
        let picked = picked
            .as_ref()
            .ok_or_else(|| OpError::new("restore_refused", "Choose a backup file first."))?;
        (picked.path.clone(), picked.file_name.clone())
    };
    let password = password.map(secret);
    let summary = blocking(move || {
        let bytes = Zeroizing::new(std::fs::read(&path).map_err(|e| {
            log::error!("backup not read: {e}");
            OpError::new("restore_refused", "The backup file could not be read.")
        })?);
        if bytes.len() as u64 > MAX_BACKUP_BYTES {
            return Err(OpError::new(
                "restore_refused",
                "The backup is larger than 512 MB, so it was not restored.",
            ));
        }
        store.call(move |c| {
            c.restore(
                &bytes,
                Some(&file_name),
                password.as_ref().map(|p| p.as_str()),
            )
        })?
    })
    .await?;
    if let Ok(mut picked) = state.picked.lock() {
        *picked = None;
    }
    Ok(summary)
}

// ---------------------------------------------------------------------------------------------
// Test-only hooks (`e2e` feature)
// ---------------------------------------------------------------------------------------------

#[cfg(feature = "e2e")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eStatus {
    pub data_dir_is_override: bool,
    pub generation: u64,
    pub schema_version: usize,
    pub trades: i64,
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn e2e_status(state: State<'_, AppState>) -> Result<E2eStatus, OpError> {
    let store = state.store()?;
    let data_dir_is_override = state.data_dir_is_override;
    blocking(move || {
        store.call(move |c| {
            let j = c.journal()?;
            Ok(E2eStatus {
                data_dir_is_override,
                generation: j.generation(),
                schema_version: j
                    .schema_version()
                    .map_err(|e| OpError::new("read", e.to_string()))?,
                trades: j
                    .trade_count()
                    .map_err(|e| OpError::new("read", e.to_string()))?,
            })
        })?
    })
    .await
}

/// Adds one fictional trade through the real write path (transaction, then a durable save).
#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn e2e_add_trade(state: State<'_, AppState>) -> Result<i64, OpError> {
    let store = state.store()?;
    blocking(move || store.call(|c| c.with_journal(|j| j.add_sample_trade()))?).await
}

/// An idle timeout in seconds (`None` = back to the setting): the injected short timeout.
#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn e2e_set_idle_seconds(
    state: State<'_, AppState>,
    seconds: Option<u64>,
) -> Result<(), OpError> {
    let store = state.store()?;
    blocking(move || store.call(move |c| c.set_idle_override(seconds))).await
}

/// Export Backup to a given path (no dialog).
#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn e2e_backup_export(
    state: State<'_, AppState>,
    path: String,
    password: Option<String>,
) -> Result<(), OpError> {
    let store = state.store()?;
    let password = password.map(|p| (secret(p.clone()), secret(p)));
    blocking(move || write_backup(&store, PathBuf::from(path), password)).await
}

/// Restore step 1 with a given path (no dialog).
#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_backup_pick(state: State<'_, AppState>, path: String) -> Result<PickedBackup, OpError> {
    pick(PathBuf::from(path), &state)
}
