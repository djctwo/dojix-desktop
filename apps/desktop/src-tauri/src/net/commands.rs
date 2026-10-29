//! IPC commands for the online features (SPEC 7.4 "Secrets and network"). Each is allow-listed
//! in `build.rs` and `capabilities/main.json`.
//!
//! Thin wrappers: they check that the journal is unlocked, read or write the online settings
//! in the journal, and call [`Online`]. **No command returns a key**: the return types are the
//! fixed result shapes below, none of which has a field a key could be in (tested in
//! `net/tests.rs`), and no command reads a key from the vault.
//!
//! Events: `quote_tick` ([`PriceTick`]) and `quote_status` ([`StreamStatus`]).

use std::sync::{Arc, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::anthropic::{AiPreview, ModelInfo};
use super::calendar::CalendarWeek;
use super::finnhub::{CompanyProfile, StockQuote, SymbolSearchResult};
use super::oanda::OandaHistory;
use super::online::{Online, OnlineSettingsView, TestResult};
use super::quotes::{PriceTick, QuotesStatus, StreamStatus, TickSink};
use super::settings::{self, OnlineSettings, OnlineSettingsPatch};
use super::{journal_time, NetError};
use crate::prefs;
use crate::session::Store;

/// Sends price events to the window (the handle arrives once the app is built).
pub struct WindowSink {
    pub app: Arc<OnceLock<AppHandle>>,
}

impl TickSink for WindowSink {
    fn tick(&self, tick: PriceTick) {
        if let Some(app) = self.app.get() {
            let _ = app.emit("quote_tick", tick);
        }
    }

    fn status(&self, status: StreamStatus) {
        if let Some(app) = self.app.get() {
            let _ = app.emit("quote_status", status);
        }
    }
}

/// Managed state for the online commands.
pub struct OnlineState {
    pub online: Arc<Online>,
    store: Option<Store>,
    data_root: std::path::PathBuf,
}

impl OnlineState {
    pub fn new(online: Arc<Online>, store: Option<Store>, data_root: std::path::PathBuf) -> Self {
        Self {
            online,
            store,
            data_root,
        }
    }

    /// Called when the journal locks: stops the stream and forgets cached provider data.
    pub fn on_lock(&self) {
        self.online.on_lock();
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, NetError> + Send + 'static,
) -> Result<T, NetError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| NetError::new("store", "The operation stopped unexpectedly."))?
}

fn store(state: &OnlineState) -> Result<Store, NetError> {
    state
        .store
        .clone()
        .ok_or_else(|| NetError::new("store", "The journal is not open."))
}

/// The online settings from the journal (fails while locked).
async fn load_settings(state: &OnlineState) -> Result<OnlineSettings, NetError> {
    let store = store(state)?;
    blocking(move || {
        store.call(|c| -> Result<OnlineSettings, NetError> {
            let journal = c.journal()?;
            settings::load(journal.conn()).map_err(|e| {
                log::error!("online settings not read: {e}");
                NetError::new("read", "The settings could not be read.")
            })
        })?
    })
    .await
}

async fn save_settings(state: &OnlineState, s: OnlineSettings) -> Result<(), NetError> {
    let store = store(state)?;
    blocking(move || {
        store.call(move |c| -> Result<(), NetError> {
            c.with_journal(|j| j.write(|tx| settings::save(tx, &s)))?;
            Ok(())
        })?
    })
    .await
}

/// Requires an unlocked journal (keys are managed only while unlocked).
async fn unlocked(state: &OnlineState) -> Result<(), NetError> {
    load_settings(state).await.map(|_| ())
}

fn calendar_enabled(state: &OnlineState) -> bool {
    prefs::load(&state.data_root).economic_calendar
}

#[tauri::command]
pub async fn online_settings_get(
    state: State<'_, OnlineState>,
) -> Result<OnlineSettingsView, NetError> {
    let s = load_settings(&state).await?;
    Ok(state.online.settings_view(&s, calendar_enabled(&state)))
}

#[tauri::command]
pub async fn online_settings_set(
    state: State<'_, OnlineState>,
    patch: OnlineSettingsPatch,
) -> Result<OnlineSettingsView, NetError> {
    let mut s = load_settings(&state).await?;
    let before = s.clone();
    s.apply(&patch, state.online.brand_id)?;
    if s != before {
        save_settings(&state, s.clone()).await?;
    }
    if s.live_source != before.live_source || s.oanda_live != before.oanda_live {
        state.online.quotes_stop();
    }
    if let Some(on) = patch.calendar_enabled {
        let mut p = prefs::load(&state.data_root);
        if p.economic_calendar != on {
            p.economic_calendar = on;
            prefs::save(&state.data_root, &p).map_err(|e| {
                log::error!("could not save prefs.json: {e}");
                NetError::new("prefs", "The setting could not be saved.")
            })?;
        }
        if !on {
            state.online.calendar_clear();
        }
    }
    Ok(state.online.settings_view(&s, calendar_enabled(&state)))
}

#[tauri::command]
pub async fn set_secret(
    state: State<'_, OnlineState>,
    account: String,
    value: String,
) -> Result<(), NetError> {
    let value = zeroize::Zeroizing::new(value);
    unlocked(&state).await?;
    let online = state.online.clone();
    blocking(move || online.set_secret(&account, &value)).await
}

#[tauri::command]
pub async fn has_secret(state: State<'_, OnlineState>, account: String) -> Result<bool, NetError> {
    unlocked(&state).await?;
    let online = state.online.clone();
    blocking(move || online.has_secret(&account)).await
}

#[tauri::command]
pub async fn delete_secret(state: State<'_, OnlineState>, account: String) -> Result<(), NetError> {
    unlocked(&state).await?;
    let online = state.online.clone();
    blocking(move || online.delete_secret(&account)).await
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, OnlineState>,
    provider: String,
) -> Result<TestResult, NetError> {
    let s = load_settings(&state).await?;
    state.online.test_connection(&provider, &s).await
}

#[tauri::command]
pub async fn ai_models(state: State<'_, OnlineState>) -> Result<Vec<ModelInfo>, NetError> {
    unlocked(&state).await?;
    state.online.ai_models().await
}

#[tauri::command]
pub async fn ai_preview(
    state: State<'_, OnlineState>,
    prompt: String,
) -> Result<AiPreview, NetError> {
    let s = load_settings(&state).await?;
    state.online.ai_preview(&s, &prompt)
}

/// A saved AI report (`ai_reports`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReport {
    pub id: i64,
    pub created_at: String,
    pub model: String,
    pub request_sha256: String,
    /// The exact request body that was sent (aggregated statistics only).
    pub request_preview: String,
    pub response_text: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
}

/// Run Analysis. The first run needs `consent: true` (recorded in the journal).
#[tauri::command]
pub async fn ai_run(
    state: State<'_, OnlineState>,
    prompt: String,
    request_sha256: String,
    consent: bool,
) -> Result<AiReport, NetError> {
    let mut s = load_settings(&state).await?;
    if !s.ai_enabled {
        return Err(NetError::off("AI analysis"));
    }
    if s.ai_consented_at.is_none() {
        if !consent {
            return Err(NetError::new(
                "consent_required",
                "Review what will be sent and agree before the first analysis.",
            ));
        }
        s.ai_consented_at = Some(crate::journal::now_ms());
        save_settings(&state, s.clone()).await?;
    }
    let (request, answer) = state.online.ai_run(&s, &prompt, &request_sha256).await?;
    let report = AiReport {
        id: 0,
        created_at: journal_time(crate::journal::now_ms()),
        model: answer.model,
        request_sha256: request.sha256,
        request_preview: String::from_utf8_lossy(&request.body).into_owned(),
        response_text: answer.text,
        input_tokens: answer.input_tokens.and_then(|n| i64::try_from(n).ok()),
        output_tokens: answer.output_tokens.and_then(|n| i64::try_from(n).ok()),
    };
    let store = store(&state)?;
    let row = report.clone();
    let id = blocking(move || {
        store.call(move |c| -> Result<i64, NetError> {
            Ok(c.with_journal(|j| j.write(|tx| insert_report(tx, &row)))?)
        })?
    })
    .await?;
    Ok(AiReport { id, ..report })
}

pub fn insert_report(tx: &rusqlite::Transaction<'_>, r: &AiReport) -> rusqlite::Result<i64> {
    tx.execute(
        "INSERT INTO ai_reports (created_at, model, request_sha256, request_preview, \
         response_text, input_tokens, output_tokens) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            r.created_at,
            r.model,
            r.request_sha256,
            r.request_preview,
            r.response_text,
            r.input_tokens,
            r.output_tokens
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

pub fn list_reports(conn: &rusqlite::Connection, limit: u32) -> rusqlite::Result<Vec<AiReport>> {
    let mut stmt = conn.prepare(
        "SELECT id, created_at, model, request_sha256, request_preview, response_text, \
         input_tokens, output_tokens FROM ai_reports ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([i64::from(limit.min(500))], |row| {
        Ok(AiReport {
            id: row.get(0)?,
            created_at: row.get(1)?,
            model: row.get(2)?,
            request_sha256: row.get(3)?,
            request_preview: row.get(4)?,
            response_text: row.get(5)?,
            input_tokens: row.get(6)?,
            output_tokens: row.get(7)?,
        })
    })?;
    rows.collect()
}

/// Saved AI reports, newest first (at most 500).
#[tauri::command]
pub async fn ai_reports_list(
    state: State<'_, OnlineState>,
    limit: u32,
) -> Result<Vec<AiReport>, NetError> {
    let store = store(&state)?;
    blocking(move || {
        store.call(move |c| -> Result<Vec<AiReport>, NetError> {
            list_reports(c.journal()?.conn(), limit)
                .map_err(|_| NetError::new("read", "The AI reports could not be read."))
        })?
    })
    .await
}

#[tauri::command]
pub async fn ai_report_delete(state: State<'_, OnlineState>, id: i64) -> Result<(), NetError> {
    let store = store(&state)?;
    blocking(move || {
        store.call(move |c| -> Result<(), NetError> {
            c.with_journal(|j| {
                j.write(|tx| tx.execute("DELETE FROM ai_reports WHERE id = ?1", [id]))
            })?;
            Ok(())
        })?
    })
    .await
}

#[tauri::command]
pub async fn quotes_start(
    state: State<'_, OnlineState>,
    symbols: Vec<String>,
) -> Result<QuotesStatus, NetError> {
    let s = load_settings(&state).await?;
    state.online.quotes_start(&s, &symbols)
}

#[tauri::command]
pub fn quotes_stop(state: State<'_, OnlineState>) {
    state.online.quotes_stop();
}

#[tauri::command]
pub async fn quotes_status(state: State<'_, OnlineState>) -> Result<QuotesStatus, NetError> {
    unlocked(&state).await?;
    Ok(state.online.quotes_status())
}

/// This week's economic events. The UI calls it every 2 minutes; the feed is fetched only when
/// the copy is older than 15 minutes (`force`: older than 2 minutes).
#[tauri::command]
pub async fn calendar_week(
    state: State<'_, OnlineState>,
    force: bool,
) -> Result<CalendarWeek, NetError> {
    unlocked(&state).await?;
    state
        .online
        .calendar_week(calendar_enabled(&state), force)
        .await
}

#[tauri::command]
pub async fn finnhub_quote(
    state: State<'_, OnlineState>,
    symbol: String,
) -> Result<StockQuote, NetError> {
    let s = load_settings(&state).await?;
    state.online.finnhub_quote(&s, &symbol).await
}

#[tauri::command]
pub async fn finnhub_profile(
    state: State<'_, OnlineState>,
    symbol: String,
) -> Result<CompanyProfile, NetError> {
    let s = load_settings(&state).await?;
    state.online.finnhub_profile(&s, &symbol).await
}

#[tauri::command]
pub async fn finnhub_search(
    state: State<'_, OnlineState>,
    query: String,
) -> Result<Vec<SymbolSearchResult>, NetError> {
    let s = load_settings(&state).await?;
    state.online.finnhub_search(&s, &query).await
}

/// OANDA history import, step 1: fetch the transactions. The web view maps them
/// (`mapOandaTransactions`) and commits them like any other import.
#[tauri::command]
pub async fn oanda_fetch_history(
    state: State<'_, OnlineState>,
    days: Option<u32>,
) -> Result<OandaHistory, NetError> {
    let s = load_settings(&state).await?;
    state.online.oanda_history(&s, days).await
}

/// Every online command name (kept equal to `build.rs` and `capabilities/main.json` by a test).
pub const COMMANDS: &[&str] = &[
    "online_settings_get",
    "online_settings_set",
    "set_secret",
    "has_secret",
    "delete_secret",
    "test_connection",
    "ai_models",
    "ai_preview",
    "ai_run",
    "ai_reports_list",
    "ai_report_delete",
    "quotes_start",
    "quotes_stop",
    "quotes_status",
    "calendar_week",
    "finnhub_quote",
    "finnhub_profile",
    "finnhub_search",
    "oanda_fetch_history",
];
