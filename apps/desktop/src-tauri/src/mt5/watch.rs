//! The MT5 folder watcher (SPEC 5.4).
//!
//! One thread per running watcher. It finds trade files in the enabled folders and queues each
//! new or changed one for import; the web view then reads the queued bytes, parses them with
//! `packages/importers` and commits the result (`mt5_import_commit`).
//!
//! - **Triggers:** folder events (`notify`: ReadDirectoryChangesW / inotify) plus a start-up
//!   scan and a poll (60 s), which catches in-place rewrites, network drives, Wine and folders
//!   created after start.
//! - **Debounce:** a burst of events waits until the file has been quiet for 2 s.
//! - **Stable file:** size and modification time must be unchanged across two looks 1 s apart.
//!   A file whose last line isn't finished (no trailing newline) waits for the next poll; after
//!   [`Timing::partial_passes`] unchanged polls it is imported as it is.
//! - **Busy files:** a file another program holds without sharing is retried (5 s, doubling up
//!   to the poll interval). Deleted files leave the queue.
//! - **Idempotent:** a ledger of (path, size, mtime, SHA-256) per file. An unchanged file is
//!   never read again; a touched file whose bytes didn't change is not imported again. Tickets
//!   dedupe what remains (a rewritten daily file is imported whole; old rows are duplicates).
//! - **Read-only:** every file access goes through [`super::ro`].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::Watcher as _;
use serde::Serialize;

use super::ro::{self, ReadError, Stat};

/// File-name prefix of `DojixExport.mq5` output.
pub const EXPORT_PREFIX: &str = "DojixExport_";
/// The 32-column MT5 CSV's file-name prefix until the user sets one in Settings: none, so
/// only `DojixExport_*.csv` files are picked up by default. The program that writes 32-column
/// files is not part of this project, so its file names are the user's to enter.
pub const DEFAULT_32COL_PREFIX: &str = "";

/// At most this many file records are kept for the status view.
const MAX_FILE_RECORDS: usize = 500;

/// The watcher's clocks. [`Timing::default`] is what the app uses; tests shorten it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Timing {
    pub debounce: Duration,
    pub stable_gap: Duration,
    pub poll: Duration,
    pub busy_retry: Duration,
    /// Polls an unfinished last line waits before the file is imported anyway.
    pub partial_passes: u32,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            debounce: Duration::from_secs(2),
            stable_gap: Duration::from_secs(1),
            poll: Duration::from_secs(60),
            busy_retry: Duration::from_secs(5),
            partial_passes: 2,
        }
    }
}

/// A folder the watcher reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folder {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
}

/// What the ledger remembers about a file that was handled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerEntry {
    pub size: u64,
    pub mtime_ns: u128,
    pub sha256: String,
    /// `imported`, `not_trade_file` or `failed`.
    pub result: String,
}

/// What a file name is to the watcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    /// A 32-column export or a `DojixExport` file.
    Trade,
    /// Any other CSV (listed once as "not a trade file").
    OtherCsv,
}

fn starts_with_ignore_case(name: &str, prefix: &str) -> bool {
    name.len() >= prefix.len()
        && name.is_char_boundary(prefix.len())
        && name[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// Classifies a file name. `prefix32` is the 32-column export's prefix.
pub fn file_kind(name: &str, prefix32: &str) -> Option<FileKind> {
    if !name.to_ascii_lowercase().ends_with(".csv") {
        return None;
    }
    let trade = starts_with_ignore_case(name, EXPORT_PREFIX)
        || (!prefix32.is_empty() && starts_with_ignore_case(name, prefix32));
    Some(if trade {
        FileKind::Trade
    } else {
        FileKind::OtherCsv
    })
}

/// A file's state, as shown in Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileState {
    /// Seen; waiting for it to stop changing.
    Waiting,
    /// The last line isn't finished yet.
    Partial,
    /// Another program holds it; retrying.
    Busy,
    /// Read and queued for import.
    Pending,
    Imported,
    /// Touched, but the bytes are the same as last time.
    Unchanged,
    Deleted,
    NotTradeFile,
    Failed,
    Denied,
    TooLarge,
}

fn state_of_result(result: &str) -> FileState {
    match result {
        "imported" => FileState::Imported,
        "not_trade_file" => FileState::NotTradeFile,
        _ => FileState::Failed,
    }
}

/// One file's latest state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub folder_id: String,
    pub file_name: String,
    pub state: FileState,
    pub detail: Option<String>,
    pub at_ms: i64,
}

/// One folder's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderState {
    /// Folder events and the poll.
    Watching,
    /// The poll only (folder events unavailable here).
    Polling,
    /// The folder doesn't exist (yet).
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStatus {
    pub id: String,
    pub label: String,
    pub path: String,
    pub state: FolderState,
}

/// A file queued for import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFile {
    pub token: u64,
    pub folder_id: String,
    pub file_name: String,
    pub size: u64,
    #[serde(skip)]
    pub path: PathBuf,
    #[serde(skip)]
    pub mtime_ns: u128,
    #[serde(skip)]
    pub sha256: String,
}

/// The watcher's view for Settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub folders: Vec<FolderStatus>,
    /// Newest first.
    pub files: Vec<FileStatus>,
    pub pending: Vec<PendingFile>,
}

/// Why queued bytes couldn't be handed over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TakeError {
    /// No such token (already handled, or replaced by a newer version of the file).
    Unknown,
    /// The file changed since it was queued; it will be queued again.
    Changed,
    Gone,
    Busy,
    Unreadable(String),
}

/// Told when files are queued (the app emits `mt5_file_ready`).
pub trait Sink: Send + Sync {
    fn files_ready(&self, pending: usize);
}

/// The SHA-256 of `bytes`, lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    crate::crypto::hex(&crate::crypto::sha256(bytes))
}

fn wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
struct Candidate {
    folder_id: String,
    file_name: String,
    due: Instant,
    /// The stat seen at the last look (None before the first look).
    last: Option<Stat>,
    partial_passes: u32,
    busy_tries: u32,
    /// Bumped by every folder event; an outcome computed before an event is discarded.
    events: u64,
}

impl Candidate {
    fn new(folder_id: String, file_name: String, due: Instant) -> Self {
        Self {
            folder_id,
            file_name,
            due,
            last: None,
            partial_passes: 0,
            busy_tries: 0,
            events: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct FileRecord {
    status: FileStatus,
    /// The stat the state was recorded for.
    stat: Option<Stat>,
}

struct State {
    folders: Vec<Folder>,
    prefix32: String,
    timing: Timing,
    ledger: HashMap<PathBuf, LedgerEntry>,
    candidates: HashMap<PathBuf, Candidate>,
    pending: BTreeMap<u64, PendingFile>,
    files: HashMap<PathBuf, FileRecord>,
    watched: HashSet<PathBuf>,
    events_available: bool,
    next_token: u64,
    next_poll: Instant,
    wake: bool,
    stop: bool,
}

impl State {
    fn record(
        &mut self,
        path: &Path,
        folder_id: &str,
        file_name: &str,
        state: FileState,
        detail: Option<String>,
        stat: Option<Stat>,
    ) {
        self.files.insert(
            path.to_path_buf(),
            FileRecord {
                status: FileStatus {
                    folder_id: folder_id.to_string(),
                    file_name: file_name.to_string(),
                    state,
                    detail,
                    at_ms: wall_ms(),
                },
                stat,
            },
        );
        if self.files.len() > MAX_FILE_RECORDS {
            // Drop the oldest record of a file that is neither queued nor in progress.
            let busy: HashSet<&PathBuf> = self
                .candidates
                .keys()
                .chain(self.pending.values().map(|p| &p.path))
                .collect();
            let oldest = self
                .files
                .iter()
                .filter(|(p, _)| !busy.contains(p))
                .min_by_key(|(_, r)| r.status.at_ms)
                .map(|(p, _)| p.clone());
            if let Some(p) = oldest {
                self.files.remove(&p);
            }
        }
    }

    fn pending_for(&self, path: &Path) -> Option<u64> {
        self.pending
            .iter()
            .find(|(_, p)| p.path == path)
            .map(|(t, _)| *t)
    }

    fn drop_pending_for(&mut self, path: &Path) {
        self.pending.retain(|_, p| p.path != path);
    }

    /// Applies one poll pass's listings.
    fn apply_poll(&mut self, listings: Vec<(Folder, Option<Vec<ro::Entry>>)>, now: Instant) {
        for (folder, entries) in listings {
            // A folder that can't be listed (missing, unplugged drive) changes nothing.
            let Some(entries) = entries else { continue };
            let mut present: HashSet<PathBuf> = HashSet::new();
            for entry in entries {
                let path = folder.path.join(&entry.name);
                match file_kind(&entry.name, &self.prefix32) {
                    None => continue,
                    Some(FileKind::OtherCsv) => {
                        present.insert(path.clone());
                        if !self.files.contains_key(&path) {
                            self.record(
                                &path,
                                &folder.id,
                                &entry.name,
                                FileState::NotTradeFile,
                                Some("not a trade file".to_string()),
                                Some(entry.stat),
                            );
                        }
                        continue;
                    }
                    Some(FileKind::Trade) => {}
                }
                present.insert(path.clone());
                if self.candidates.contains_key(&path) {
                    continue;
                }
                if let Some(token) = self.pending_for(&path) {
                    let same = self.pending.get(&token).is_some_and(|p| {
                        p.size == entry.stat.size && p.mtime_ns == entry.stat.mtime_ns
                    });
                    if same {
                        continue;
                    }
                    self.pending.remove(&token);
                }
                if let Some(l) = self.ledger.get(&path) {
                    if l.size == entry.stat.size && l.mtime_ns == entry.stat.mtime_ns {
                        if !self.files.contains_key(&path) {
                            let state = state_of_result(&l.result);
                            self.record(
                                &path,
                                &folder.id,
                                &entry.name,
                                state,
                                None,
                                Some(entry.stat),
                            );
                        }
                        continue;
                    }
                }
                if let Some(rec) = self.files.get(&path) {
                    // Settled refusals are looked at again only when the file changes.
                    let settled =
                        matches!(rec.status.state, FileState::TooLarge | FileState::Failed);
                    if settled && rec.stat == Some(entry.stat) {
                        continue;
                    }
                }
                self.candidates.insert(
                    path,
                    Candidate::new(folder.id.clone(), entry.name.clone(), now),
                );
            }
            // Files of this folder that disappeared.
            let gone: Vec<PathBuf> = self
                .files
                .iter()
                .filter(|(p, r)| {
                    r.status.folder_id == folder.id
                        && r.status.state != FileState::Deleted
                        && !present.contains(*p)
                })
                .map(|(p, _)| p.clone())
                .collect();
            for path in gone {
                self.candidates.remove(&path);
                self.drop_pending_for(&path);
                let not_trade = self
                    .files
                    .get(&path)
                    .is_some_and(|r| r.status.state == FileState::NotTradeFile);
                if not_trade {
                    self.files.remove(&path);
                } else if let Some(rec) = self.files.get_mut(&path) {
                    rec.status.state = FileState::Deleted;
                    rec.status.detail = None;
                    rec.status.at_ms = wall_ms();
                    rec.stat = None;
                }
            }
        }
    }

    fn next_due(&self) -> Instant {
        self.candidates
            .values()
            .map(|c| c.due)
            .fold(self.next_poll, |a, b| a.min(b))
    }
}

/// What one look at a candidate found.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Outcome {
    Gone,
    /// First look, or it changed: look again after the stable gap.
    Recheck(Stat),
    /// Held by another program: retry later.
    Busy(String),
    /// Nothing to do until the file changes.
    Settled(FileState, Option<String>, Option<Stat>),
    /// The last line isn't finished.
    Partial(Stat),
    /// The bytes are the same as the ledger's.
    Same(Stat),
    Ready {
        stat: Stat,
        sha256: String,
    },
}

fn examine(path: &Path, c: &Candidate, ledger: Option<&LedgerEntry>, timing: &Timing) -> Outcome {
    let stat = match ro::stat(path) {
        Ok(s) => s,
        Err(ReadError::Gone) => return Outcome::Gone,
        Err(ReadError::Busy) => return Outcome::Busy(ReadError::Busy.to_string()),
        Err(ReadError::Denied) => {
            return Outcome::Settled(FileState::Denied, Some(ReadError::Denied.to_string()), None)
        }
        Err(e) => return Outcome::Settled(FileState::Failed, Some(e.to_string()), None),
    };
    if c.last != Some(stat) {
        return Outcome::Recheck(stat);
    }
    if let Some(l) = ledger {
        if l.size == stat.size && l.mtime_ns == stat.mtime_ns {
            return Outcome::Settled(state_of_result(&l.result), None, Some(stat));
        }
    }
    if stat.size > ro::MAX_READ_BYTES {
        let detail = Some(ReadError::TooLarge.to_string());
        return Outcome::Settled(FileState::TooLarge, detail, Some(stat));
    }
    let (bytes, seen) = match ro::read(path, ro::MAX_READ_BYTES) {
        Ok(read) => read,
        Err(ReadError::Gone) => return Outcome::Gone,
        Err(ReadError::Busy) => return Outcome::Busy(ReadError::Busy.to_string()),
        Err(ReadError::Denied) => {
            let detail = Some(ReadError::Denied.to_string());
            return Outcome::Settled(FileState::Denied, detail, Some(stat));
        }
        Err(ReadError::TooLarge) => {
            let detail = Some(ReadError::TooLarge.to_string());
            return Outcome::Settled(FileState::TooLarge, detail, Some(stat));
        }
        Err(e) => return Outcome::Settled(FileState::Failed, Some(e.to_string()), Some(stat)),
    };
    if seen != stat {
        return Outcome::Recheck(seen);
    }
    let sha256 = sha256_hex(&bytes);
    if ledger.is_some_and(|l| l.sha256 == sha256) {
        return Outcome::Same(stat);
    }
    if !bytes.ends_with(b"\n") && c.partial_passes < timing.partial_passes {
        return Outcome::Partial(stat);
    }
    Outcome::Ready { stat, sha256 }
}

struct Shared {
    state: Mutex<State>,
    cv: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // A panic while holding the lock can't leave the state inconsistent in a way that
        // matters more than stopping the watcher would; keep going.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wake(&self, mut st: MutexGuard<'_, State>) {
        st.wake = true;
        drop(st);
        self.cv.notify_all();
    }

    /// A folder event from `notify`.
    fn on_event(&self, res: notify::Result<notify::Event>) {
        let mut guard = self.lock();
        let st = &mut *guard;
        let now = Instant::now();
        let event = match res {
            Ok(event) => event,
            Err(e) => {
                log::warn!("MT5 folder event error ({}); rescanning", error_kind(&e));
                st.next_poll = now;
                self.wake(guard);
                return;
            }
        };
        if event.need_rescan() {
            st.next_poll = now;
        }
        for path in &event.paths {
            let Some(parent) = path.parent() else {
                continue;
            };
            let Some(folder) = st.folders.iter().find(|f| f.path == parent) else {
                continue;
            };
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if file_kind(name, &st.prefix32) != Some(FileKind::Trade) {
                continue;
            }
            let folder_id = folder.id.clone();
            let due = now + st.timing.debounce;
            let c = st
                .candidates
                .entry(path.clone())
                .or_insert_with(|| Candidate::new(folder_id, name.to_string(), due));
            c.due = due;
            c.events += 1;
        }
        self.wake(guard);
    }
}

/// A running watcher. Dropping it stops the thread.
pub struct Watcher {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    /// Starts watching `folders`. `ledger` is what earlier runs handled.
    pub fn start(
        folders: Vec<Folder>,
        prefix32: String,
        ledger: HashMap<PathBuf, LedgerEntry>,
        timing: Timing,
        sink: Arc<dyn Sink>,
    ) -> std::io::Result<Self> {
        // Defence in depth: never watch a path that fails the checks (see `safe_path`).
        if let Some(f) = folders
            .iter()
            .find(|f| !super::safe_path::is_acceptable(&f.path.to_string_lossy()))
        {
            log::warn!("MT5 folder {} refused: not a local folder path", f.id);
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "not a local folder path",
            ));
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                folders,
                prefix32,
                timing,
                ledger,
                candidates: HashMap::new(),
                pending: BTreeMap::new(),
                files: HashMap::new(),
                watched: HashSet::new(),
                events_available: false,
                next_token: 1,
                next_poll: Instant::now(),
                wake: false,
                stop: false,
            }),
            cv: Condvar::new(),
        });
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("mt5-watch".into())
            .spawn(move || run(thread_shared, sink))?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }

    /// Stops the thread and waits for it.
    pub fn stop(&mut self) {
        {
            let mut st = self.shared.lock();
            st.stop = true;
        }
        self.shared.cv.notify_all();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }

    /// The folders this watcher reads.
    pub fn folders(&self) -> Vec<Folder> {
        self.shared.lock().folders.clone()
    }

    pub fn prefix32(&self) -> String {
        self.shared.lock().prefix32.clone()
    }

    pub fn status(&self) -> WatchStatus {
        let st = self.shared.lock();
        let folders = st
            .folders
            .iter()
            .map(|f| FolderStatus {
                id: f.id.clone(),
                label: f.label.clone(),
                path: f.path.to_string_lossy().into_owned(),
                state: if !ro::is_dir(&f.path) {
                    FolderState::Missing
                } else if st.events_available && st.watched.contains(&f.path) {
                    FolderState::Watching
                } else {
                    FolderState::Polling
                },
            })
            .collect();
        let mut files: Vec<FileStatus> = st.files.values().map(|r| r.status.clone()).collect();
        files.sort_by(|a, b| {
            b.at_ms
                .cmp(&a.at_ms)
                .then_with(|| a.file_name.cmp(&b.file_name))
        });
        WatchStatus {
            folders,
            files,
            pending: st.pending.values().cloned().collect(),
        }
    }

    /// The queued file for `token`.
    pub fn pending(&self, token: u64) -> Option<PendingFile> {
        self.shared.lock().pending.get(&token).cloned()
    }

    /// Reads a queued file's bytes again and checks they are the bytes that were queued.
    pub fn read_pending(&self, token: u64) -> Result<(PendingFile, Vec<u8>), TakeError> {
        let file = self.pending(token).ok_or(TakeError::Unknown)?;
        match ro::read(&file.path, ro::MAX_READ_BYTES) {
            Ok((bytes, _)) if sha256_hex(&bytes) == file.sha256 => Ok((file, bytes)),
            Ok(_) => {
                let mut st = self.shared.lock();
                st.pending.remove(&token);
                let now = Instant::now();
                st.candidates.insert(
                    file.path.clone(),
                    Candidate::new(file.folder_id.clone(), file.file_name.clone(), now),
                );
                self.shared.wake(st);
                Err(TakeError::Changed)
            }
            Err(ReadError::Gone) => {
                let mut st = self.shared.lock();
                st.pending.remove(&token);
                st.record(
                    &file.path,
                    &file.folder_id,
                    &file.file_name,
                    FileState::Deleted,
                    None,
                    None,
                );
                Err(TakeError::Gone)
            }
            Err(ReadError::Busy) => Err(TakeError::Busy),
            Err(e) => Err(TakeError::Unreadable(e.to_string())),
        }
    }

    /// Marks a queued file as handled: it leaves the queue and enters the ledger.
    pub fn finish(&self, token: u64, result: &str, detail: Option<String>) -> Option<PendingFile> {
        let mut st = self.shared.lock();
        let file = st.pending.remove(&token)?;
        st.ledger.insert(
            file.path.clone(),
            LedgerEntry {
                size: file.size,
                mtime_ns: file.mtime_ns,
                sha256: file.sha256.clone(),
                result: result.to_string(),
            },
        );
        let stat = Stat {
            size: file.size,
            mtime_ns: file.mtime_ns,
        };
        st.record(
            &file.path,
            &file.folder_id,
            &file.file_name,
            state_of_result(result),
            detail,
            Some(stat),
        );
        Some(file)
    }

    /// Asks for a poll pass now (tests, "Scan now").
    pub fn rescan(&self) {
        let mut st = self.shared.lock();
        st.next_poll = Instant::now();
        self.shared.wake(st);
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop();
    }
}

/// What went wrong, without the paths a `notify` error carries (logs never hold paths).
fn error_kind(e: &notify::Error) -> &'static str {
    match &e.kind {
        notify::ErrorKind::Generic(_) => "generic",
        notify::ErrorKind::Io(_) => "i/o",
        notify::ErrorKind::PathNotFound => "path not found",
        notify::ErrorKind::WatchNotFound => "watch not found",
        notify::ErrorKind::InvalidConfig(_) => "invalid configuration",
        notify::ErrorKind::MaxFilesWatch => "too many watches",
    }
}

fn make_event_source(shared: &Arc<Shared>) -> Option<notify::RecommendedWatcher> {
    let weak = Arc::downgrade(shared);
    let handler = move |res: notify::Result<notify::Event>| {
        if let Some(shared) = weak.upgrade() {
            shared.on_event(res);
        }
    };
    match notify::recommended_watcher(handler) {
        Ok(w) => Some(w),
        Err(e) => {
            log::warn!(
                "MT5 folder events unavailable ({}); polling only",
                error_kind(&e)
            );
            None
        }
    }
}

/// Starts folder events for folders that exist now, and forgets those that disappeared.
fn sync_event_watches(
    source: &mut Option<notify::RecommendedWatcher>,
    shared: &Shared,
    folders: &[Folder],
) {
    let Some(w) = source.as_mut() else { return };
    let watched: HashSet<PathBuf> = shared.lock().watched.clone();
    let mut now_watched = watched.clone();
    for f in folders {
        let exists = ro::is_dir(&f.path);
        if exists && !watched.contains(&f.path) {
            match w.watch(&f.path, notify::RecursiveMode::NonRecursive) {
                Ok(()) => {
                    now_watched.insert(f.path.clone());
                }
                Err(e) => log::warn!(
                    "MT5 folder events unavailable for a folder ({}); polling it",
                    error_kind(&e)
                ),
            }
        } else if !exists && watched.contains(&f.path) {
            let _ = w.unwatch(&f.path);
            now_watched.remove(&f.path);
        }
    }
    shared.lock().watched = now_watched;
}

fn run(shared: Arc<Shared>, sink: Arc<dyn Sink>) {
    let mut source = make_event_source(&shared);
    shared.lock().events_available = source.is_some();
    loop {
        let (poll_due, folders, timing) = {
            let st = shared.lock();
            if st.stop {
                return;
            }
            (
                Instant::now() >= st.next_poll,
                st.folders.clone(),
                st.timing.clone(),
            )
        };

        if poll_due {
            sync_event_watches(&mut source, &shared, &folders);
            let listings: Vec<(Folder, Option<Vec<ro::Entry>>)> = folders
                .iter()
                .map(|f| (f.clone(), ro::list_files(&f.path).ok()))
                .collect();
            let mut st = shared.lock();
            st.apply_poll(listings, Instant::now());
            st.next_poll = Instant::now() + timing.poll;
        }

        // Look at every candidate that is due, without holding the lock.
        let now = Instant::now();
        let due: Vec<(PathBuf, Candidate, Option<LedgerEntry>)> = {
            let st = shared.lock();
            st.candidates
                .iter()
                .filter(|(_, c)| c.due <= now)
                .map(|(p, c)| (p.clone(), c.clone(), st.ledger.get(p).cloned()))
                .collect()
        };
        let looked: Vec<(PathBuf, Candidate, Outcome)> = due
            .into_iter()
            .map(|(path, c, ledger)| {
                let outcome = examine(&path, &c, ledger.as_ref(), &timing);
                (path, c, outcome)
            })
            .collect();
        let ready = {
            let mut st = shared.lock();
            let mut queued = false;
            for (path, seen, outcome) in looked {
                queued |= apply_outcome(&mut st, &path, &seen, outcome);
            }
            if queued {
                Some(st.pending.len())
            } else {
                None
            }
        };
        if let Some(count) = ready {
            sink.files_ready(count);
        }

        // Sleep until the next due time, a folder event, or stop.
        let mut st = shared.lock();
        loop {
            if st.stop {
                return;
            }
            if st.wake {
                st.wake = false;
                break;
            }
            let now = Instant::now();
            let next = st.next_due();
            if next <= now {
                break;
            }
            let (guard, _) = shared
                .cv
                .wait_timeout(st, next - now)
                .unwrap_or_else(|e| e.into_inner());
            st = guard;
        }
    }
}

/// Applies one look's outcome. Returns true when a file was queued.
fn apply_outcome(st: &mut State, path: &Path, seen: &Candidate, outcome: Outcome) -> bool {
    let now = Instant::now();
    let timing = st.timing.clone();
    let current_events = st.candidates.get(path).map(|c| c.events);
    if outcome == Outcome::Gone {
        st.candidates.remove(path);
        st.drop_pending_for(path);
        if st.files.contains_key(path) {
            st.record(
                path,
                &seen.folder_id,
                &seen.file_name,
                FileState::Deleted,
                None,
                None,
            );
        }
        return false;
    }
    // An event arrived while the file was being looked at: its own look is already scheduled.
    if current_events != Some(seen.events) {
        return false;
    }
    let (folder_id, file_name) = (seen.folder_id.clone(), seen.file_name.clone());
    match outcome {
        Outcome::Gone => false,
        Outcome::Recheck(stat) => {
            if let Some(c) = st.candidates.get_mut(path) {
                if c.last.is_some() && c.last != Some(stat) {
                    c.partial_passes = 0;
                }
                c.last = Some(stat);
                c.due = now + timing.stable_gap;
            }
            st.record(
                path,
                &folder_id,
                &file_name,
                FileState::Waiting,
                None,
                Some(stat),
            );
            false
        }
        Outcome::Busy(detail) => {
            if let Some(c) = st.candidates.get_mut(path) {
                let factor = 1u32 << c.busy_tries.min(6);
                c.busy_tries += 1;
                c.due = now + (timing.busy_retry * factor).min(timing.poll);
            }
            st.record(
                path,
                &folder_id,
                &file_name,
                FileState::Busy,
                Some(detail),
                None,
            );
            false
        }
        Outcome::Settled(state, detail, stat) => {
            st.candidates.remove(path);
            st.record(path, &folder_id, &file_name, state, detail, stat);
            false
        }
        Outcome::Partial(stat) => {
            if let Some(c) = st.candidates.get_mut(path) {
                c.partial_passes += 1;
                c.last = Some(stat);
                c.due = now + timing.poll;
            }
            let detail = Some("the last line is still being written".to_string());
            st.record(
                path,
                &folder_id,
                &file_name,
                FileState::Partial,
                detail,
                Some(stat),
            );
            false
        }
        Outcome::Same(stat) => {
            st.candidates.remove(path);
            if let Some(l) = st.ledger.get_mut(path) {
                l.size = stat.size;
                l.mtime_ns = stat.mtime_ns;
            }
            st.record(
                path,
                &folder_id,
                &file_name,
                FileState::Unchanged,
                None,
                Some(stat),
            );
            false
        }
        Outcome::Ready { stat, sha256 } => {
            st.candidates.remove(path);
            st.drop_pending_for(path);
            let token = st.next_token;
            st.next_token += 1;
            st.pending.insert(
                token,
                PendingFile {
                    token,
                    folder_id: folder_id.clone(),
                    file_name: file_name.clone(),
                    size: stat.size,
                    path: path.to_path_buf(),
                    mtime_ns: stat.mtime_ns,
                    sha256,
                },
            );
            st.record(
                path,
                &folder_id,
                &file_name,
                FileState::Pending,
                None,
                Some(stat),
            );
            true
        }
    }
}
