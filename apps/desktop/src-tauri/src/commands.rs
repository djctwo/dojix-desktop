//! The IPC surface. Every command is allow-listed in `capabilities/main.json`; test-only
//! commands exist only with the `e2e` feature (and its capability overlay).

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::instance::InstanceLock;
use crate::journal::{Journal, JournalRow};

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
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
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

pub struct AppState {
    pub info: AppInfo,
    pub journal: Option<Mutex<Journal>>,
    /// Held for the life of the process: one running copy per data folder.
    pub _instance_lock: Option<InstanceLock>,
    #[cfg(feature = "e2e")]
    pub data_dir_is_override: bool,
}

const MAX_ROWS: u32 = 5_000;

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    state.info.clone()
}

/// The newest trades, at most `limit` (capped at 5,000).
#[tauri::command]
pub async fn journal_query(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<JournalRow>, String> {
    let journal = state
        .journal
        .as_ref()
        .ok_or_else(|| "The journal is not open.".to_string())?;
    let journal = journal
        .lock()
        .map_err(|_| "The journal is unavailable.".to_string())?;
    journal.recent(limit.min(MAX_ROWS)).map_err(|e| {
        log::error!("journal_query failed: {e}");
        "The journal could not be read.".to_string()
    })
}

#[cfg(feature = "e2e")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eStatus {
    pub data_dir_is_override: bool,
    pub generation: u64,
    pub schema_version: usize,
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_status(state: State<'_, AppState>) -> Result<E2eStatus, String> {
    let journal = state.journal.as_ref().ok_or("journal not open")?;
    let journal = journal.lock().map_err(|_| "poisoned")?;
    Ok(E2eStatus {
        data_dir_is_override: state.data_dir_is_override,
        generation: journal.generation(),
        schema_version: journal.schema_version().map_err(|e| e.to_string())?,
    })
}

/// Adds one fictional trade through the real write path (transaction, then a durable save).
#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_add_trade(state: State<'_, AppState>) -> Result<i64, String> {
    let journal = state.journal.as_ref().ok_or("journal not open")?;
    let mut journal = journal.lock().map_err(|_| "poisoned")?;
    journal.add_sample_trade().map_err(|e| e.to_string())
}
