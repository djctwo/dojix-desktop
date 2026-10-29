//! MetaTrader 5 auto-import (Dojix only; SPEC 5.4). Off by default, opt-in per folder, and
//! strictly read-only: everything in this folder reaches MT5's files through [`ro`] (list,
//! stat, read). Journal persistence for the feature (settings, the `watched_files` ledger,
//! commits) lives outside this folder, in `mt5_journal.rs`.
//!
//! - [`discover`] finds the folders MT5 writes to;
//! - [`watch`] watches the enabled ones and queues new or changed trade files;
//! - [`Service`] ties the two to the app: which folders run, the queue, the last result.

pub mod discover;
pub mod ro;
pub mod watch;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use discover::{Kind, Location, Roots};
use watch::{Folder, LedgerEntry, PendingFile, Sink, TakeError, Timing, WatchStatus, Watcher};

/// At most this many preview files per location.
const PREVIEW_FILES: usize = 20;
/// Longest accepted 32-column prefix.
const PREFIX_MAX: usize = 64;

/// The feature's settings (journal `settings` key `mt5`). Everything is off by default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Folders the watcher reads (paths). Empty = auto-import off.
    pub enabled: Vec<String>,
    /// Folders the user added with "Add folder…" (paths).
    pub custom: Vec<String>,
    /// The 32-column export's file-name prefix; `None` = none (only `DojixExport_*.csv`).
    pub prefix32: Option<String>,
}

impl Config {
    pub fn prefix32(&self) -> String {
        self.prefix32
            .clone()
            .unwrap_or_else(|| watch::DEFAULT_32COL_PREFIX.to_string())
    }

    /// Bounds what a settings row can make the app do (it comes from a restorable journal).
    pub fn sanitized(mut self) -> Self {
        let clean = |list: &mut Vec<String>| {
            let mut seen = std::collections::HashSet::new();
            *list = list
                .iter()
                .filter(|p| !p.is_empty() && p.len() <= 4096 && !p.contains('\0'))
                .filter(|p| seen.insert((*p).clone()))
                .take(64)
                .cloned()
                .collect();
        };
        clean(&mut self.enabled);
        clean(&mut self.custom);
        if self.prefix32.as_deref().is_some_and(|p| prefix_problem(p).is_some()) {
            self.prefix32 = None;
        }
        self
    }
}

/// Why a 32-column prefix is refused, if it is.
pub fn prefix_problem(prefix: &str) -> Option<&'static str> {
    if prefix.trim().is_empty() {
        Some("The prefix can't be empty.")
    } else if prefix.chars().count() > PREFIX_MAX {
        Some("The prefix is too long (64 characters at most).")
    } else if prefix
        .chars()
        .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        Some("The prefix can't contain path separators, wildcards or control characters.")
    } else {
        None
    }
}

/// A file shown in a location's preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    pub file_name: String,
    pub size: u64,
    pub modified_ms: i64,
    /// `trade_file` or `other_csv`.
    pub kind: &'static str,
}

/// A location as Settings shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationView {
    #[serde(flatten)]
    pub location: Location,
    pub enabled: bool,
    /// Trade files in the folder now (a 32-column export or `DojixExport_*.csv`).
    pub trade_files: u32,
    /// Other CSV files (never imported).
    pub other_csv_files: u32,
    /// Newest trade files first, then other CSVs; at most 20.
    pub preview: Vec<PreviewFile>,
}

/// The result of the last handled file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub file_name: String,
    pub folder_id: String,
    /// The detected format (`mt5_32col`, `dojix_export`, `mt5_report`, …), when known.
    pub format: Option<String>,
    /// `imported`, `not_trade_file` or `failed`.
    pub result: String,
    pub message: Option<String>,
    pub parsed: u64,
    pub inserted: u64,
    pub duplicates: u64,
    pub skipped: u64,
    pub at_ms: i64,
}

/// Everything Settings shows about the watcher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// True while at least one folder is watched.
    pub active: bool,
    pub prefix32: String,
    #[serde(flatten)]
    pub watch: WatchStatus,
    pub last_import: Option<ImportSummary>,
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn preview(path: &Path, prefix32: &str) -> (u32, u32, Vec<PreviewFile>) {
    let Ok(entries) = ro::list_files(path) else {
        return (0, 0, Vec::new());
    };
    let mut trade = Vec::new();
    let mut other = Vec::new();
    for e in entries {
        let file = |kind| PreviewFile {
            file_name: e.name.clone(),
            size: e.stat.size,
            modified_ms: e.stat.mtime_ms(),
            kind,
        };
        match watch::file_kind(&e.name, prefix32) {
            Some(watch::FileKind::Trade) => trade.push(file("trade_file")),
            Some(watch::FileKind::OtherCsv) => other.push(file("other_csv")),
            None => {}
        }
    }
    let counts = (
        u32::try_from(trade.len()).unwrap_or(u32::MAX),
        u32::try_from(other.len()).unwrap_or(u32::MAX),
    );
    trade.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    other.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    let files = trade.into_iter().chain(other).take(PREVIEW_FILES).collect();
    (counts.0, counts.1, files)
}

struct Running {
    watcher: Watcher,
    paths: Vec<String>,
    prefix32: String,
}

/// The MT5 feature's live state. One per app.
pub struct Service {
    sink: Arc<dyn Sink>,
    timing: Timing,
    roots: Mutex<Roots>,
    running: Mutex<Option<Running>>,
    last: Mutex<Option<ImportSummary>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Service {
    pub fn new(sink: Arc<dyn Sink>, roots: Roots, timing: Timing) -> Self {
        Self {
            sink,
            timing,
            roots: Mutex::new(roots),
            running: Mutex::new(None),
            last: Mutex::new(None),
        }
    }

    /// Replaces the discovery roots (tests and e2e builds).
    pub fn set_roots(&self, roots: Roots) {
        *lock(&self.roots) = roots;
    }

    /// Every location Settings lists: discovered folders, the user's own folders, and
    /// enabled folders that are no longer found (so they can be turned off).
    pub fn locations(&self, config: &Config) -> Vec<LocationView> {
        let roots = lock(&self.roots).clone();
        let mut found: Vec<Location> = discover::discover(&roots);
        for path in config.custom.iter().chain(config.enabled.iter()) {
            let p = PathBuf::from(path);
            let id = discover::location_id(&p);
            if !found.iter().any(|l| l.id == id) {
                found.push(discover::location(
                    Kind::Custom,
                    folder_name(&p),
                    &p,
                    None,
                    None,
                    None,
                ));
            }
        }
        let prefix32 = config.prefix32();
        found
            .into_iter()
            .map(|location| {
                let (trade_files, other_csv_files, preview) =
                    preview(Path::new(&location.path), &prefix32);
                LocationView {
                    enabled: config.enabled.contains(&location.path),
                    location,
                    trade_files,
                    other_csv_files,
                    preview,
                }
            })
            .collect()
    }

    /// The location with `id`, if Settings lists it.
    pub fn find(&self, config: &Config, id: &str) -> Option<Location> {
        self.locations(config)
            .into_iter()
            .map(|v| v.location)
            .find(|l| l.id == id)
    }

    /// Makes the running watcher match `config`: starts, restarts or stops it. `ledger` is
    /// called only when a watcher starts.
    pub fn reconcile(
        &self,
        config: &Config,
        ledger: impl FnOnce() -> HashMap<PathBuf, LedgerEntry>,
    ) -> std::io::Result<()> {
        let prefix32 = config.prefix32();
        let mut running = lock(&self.running);
        if let Some(r) = running.as_ref() {
            if r.paths == config.enabled && r.prefix32 == prefix32 {
                return Ok(());
            }
        }
        // Stop the old watcher before starting the new one.
        *running = None;
        if config.enabled.is_empty() {
            log::info!("MT5 auto-import is off");
            return Ok(());
        }
        let labels: HashMap<String, String> = self
            .locations(config)
            .into_iter()
            .map(|v| (v.location.path, v.location.label))
            .collect();
        let folders = config
            .enabled
            .iter()
            .map(|path| {
                let p = PathBuf::from(path);
                Folder {
                    id: discover::location_id(&p),
                    label: labels.get(path).cloned().unwrap_or_else(|| folder_name(&p)),
                    path: p,
                }
            })
            .collect();
        let watcher = Watcher::start(
            folders,
            prefix32.clone(),
            ledger(),
            self.timing.clone(),
            self.sink.clone(),
        )?;
        log::info!("MT5 auto-import watching {} folder(s)", config.enabled.len());
        *running = Some(Running {
            watcher,
            paths: config.enabled.clone(),
            prefix32,
        });
        Ok(())
    }

    /// True when the running watcher (or the absence of one) already matches `config`.
    pub fn matches(&self, config: &Config) -> bool {
        match lock(&self.running).as_ref() {
            Some(r) => r.paths == config.enabled && r.prefix32 == config.prefix32(),
            None => config.enabled.is_empty(),
        }
    }

    /// Stops watching (the journal locked). Nothing in MT5's folders is touched until the
    /// next [`Service::reconcile`] after unlocking.
    pub fn suspend(&self) {
        if lock(&self.running).take().is_some() {
            log::info!("MT5 auto-import paused while the journal is locked");
        }
    }

    pub fn is_running(&self) -> bool {
        lock(&self.running).is_some()
    }

    pub fn status(&self, config: &Config) -> Status {
        let running = lock(&self.running);
        let watch = running
            .as_ref()
            .map(|r| r.watcher.status())
            .unwrap_or_default();
        Status {
            active: running.is_some(),
            prefix32: config.prefix32(),
            watch,
            last_import: lock(&self.last).clone(),
        }
    }

    /// The queued file for `token`.
    pub fn pending(&self, token: u64) -> Option<PendingFile> {
        lock(&self.running)
            .as_ref()
            .and_then(|r| r.watcher.pending(token))
    }

    /// The queued file's bytes, checked against what was queued.
    pub fn read(&self, token: u64) -> Result<(PendingFile, Vec<u8>), TakeError> {
        let running = lock(&self.running);
        let r = running.as_ref().ok_or(TakeError::Unknown)?;
        r.watcher.read_pending(token)
    }

    /// Records a handled file: it leaves the queue, enters the ledger, and becomes the last
    /// result.
    pub fn finish(&self, token: u64, summary: ImportSummary) {
        if let Some(r) = lock(&self.running).as_ref() {
            r.watcher
                .finish(token, &summary.result, summary.message.clone());
        }
        *lock(&self.last) = Some(summary);
    }

    /// Asks the watcher for a poll pass now.
    pub fn rescan(&self) {
        if let Some(r) = lock(&self.running).as_ref() {
            r.watcher.rescan();
        }
    }
}
