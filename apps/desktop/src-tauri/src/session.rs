//! The journal session (SPEC 6.3–6.8): one state machine that owns the decrypted journal and
//! its key, and the single writer thread every operation goes through.
//!
//! - [`Core`] holds the state: unlocked, locked (optionally *holding* a journal whose last save
//!   failed), older copy, first-time password setup (no system keyring), or failed. Every App
//!   Lock operation, the rollback check, key rotation, erase, backups and restores live here,
//!   as plain synchronous methods so they can be tested directly.
//! - [`Store`] runs a `Core` on its own thread. IPC handlers, the idle timer and the OS
//!   triggers send it jobs; jobs run one at a time, in order (the single writer). Key
//!   operations are refused as `busy` while one is queued or running, and a lock requested
//!   meanwhile runs right after it (SPEC 6.6 "Lock deferral").
//!
//! In memory, whether App Lock is on is set by these operations and never re-read from the
//! vault to decide whether to lock.

use std::fs;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};

use serde::Serialize;
use zeroize::Zeroizing;

use crate::backup::{self, BackupKind};
use crate::brand::Brand;
use crate::crypto::KdfParams;
use crate::journal::{self, Journal, LoadError};
use crate::keyvault::{KeyState, KeyVault, VaultError, Wrapper};
use crate::ledger::{self, Ledger, SaveRecord, Verdict};
use crate::paths::DataPaths;
use crate::prefs;
use crate::restore::{self, RestoreSummary};
use crate::screenshots::Screenshots;
use crate::seal::{self, JournalKey, Stamp};
use crate::snapshot;
use crate::throttle::{Clock, Gate, Throttle, ThrottleStatus};
use crate::vault::{self, Lookup, SecretStore, DATABASE_KEY, WRAPPED_KEY};

/// An error the UI can show. `message` never contains paths, keys, passwords or trade data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpError {
    pub code: &'static str,
    pub message: String,
}

impl OpError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn busy() -> Self {
        Self::new(
            "busy",
            "Another password operation is still running. Try again in a moment.",
        )
    }
}

/// Password rule for App Lock and backups (SPEC 6.6): 8–128 Unicode scalars, confirmed.
pub fn password_problem(password: &str, confirmation: &str) -> Option<&'static str> {
    let count = password.chars().count();
    if password.is_empty() {
        Some("Password cannot be empty.")
    } else if password != confirmation {
        Some("Passwords do not match.")
    } else if count < 8 {
        Some("Password must be at least 8 characters.")
    } else if count > 128 {
        Some("Password must be at most 128 characters.")
    } else {
        None
    }
}

/// How a key rotation ended once the new key was stored (the new password is in force).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Every file is sealed with the new key; only it is stored.
    Complete,
    /// Some file still needs the old key, so both stay stored; the next unlock finishes.
    FinishesOnNextUnlock,
}

/// Where the session is.
#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Unlocked,
    /// App Lock on and locked. `vault_unreadable`: the wrapped key couldn't be read.
    Locked { vault_unreadable: bool },
    /// The journal file is older than the last save this computer recorded.
    OlderCopy { file: Stamp, record: SaveRecord },
    /// No system keyring and no key yet: a password must be set first.
    Setup,
    Failed { code: &'static str, message: String },
}

/// What the UI renders (`lock_status`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Phase {
    Unlocked,
    Locked {
        vault_unreadable: bool,
        /// A journal whose last save failed is held in memory behind the lock.
        held: bool,
    },
    OlderCopy {
        file_saved_at_ms: i64,
        file_generation: u64,
        record_saved_at_ms: i64,
        record_generation: u64,
        needs_password: bool,
    },
    Setup,
    Failed {
        code: &'static str,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    #[serde(flatten)]
    pub phase: Phase,
    pub lock_enabled: bool,
    /// App Lock can't be turned off (Linux without a Secret Service).
    pub lock_required: bool,
    pub vault_backend: &'static str,
    pub throttle: ThrottleStatus,
    pub idle_lock_minutes: u32,
    pub save_failing: bool,
    pub set_aside: bool,
}

/// What the session tells the window layer.
pub trait Notifier: Send {
    /// The journal and key were dropped: wipe the web view and show the lock screen.
    fn locked(&self) {}
    /// A save failed (`true`) or succeeded again (`false`).
    fn save_state(&self, _failing: bool) {}
}

pub struct Silent;
impl Notifier for Silent {}

/// Everything a session needs from its environment.
pub struct Config {
    pub brand: Brand,
    pub paths: DataPaths,
    pub vault: Arc<dyn SecretStore>,
    pub kdf: KdfParams,
    pub clock: Arc<dyn Clock>,
}

/// Test seam: points where a key rotation or erase can be "killed" (the process stops).
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashPoint {
    AfterBegin,
    AfterRekey,
    AfterReseal,
    AfterJournalDeleted,
}

pub struct Core {
    cfg: Config,
    state: State,
    journal: Option<Journal>,
    lock_enabled: bool,
    set_aside: bool,
    idle_minutes: u32,
    /// Overrides the idle timeout (e2e builds and tests): seconds.
    idle_override_secs: Option<u64>,
    last_activity_ms: i64,
    last_snapshot_day: Option<String>,
    notifier: Box<dyn Notifier>,
    dirty: Arc<AtomicBool>,
    #[cfg(test)]
    crash_at: Option<CrashPoint>,
}

fn copy_key(key: &JournalKey) -> JournalKey {
    JournalKey::from_bytes(key.as_bytes()).expect("32 bytes")
}

fn day_of(ms: i64) -> String {
    crate::logging::utc_timestamp(u64::try_from(ms / 1000).unwrap_or(0))[..10].to_string()
}

impl Core {
    pub fn new(cfg: Config, notifier: Box<dyn Notifier>) -> Self {
        let idle_minutes = prefs::load(&cfg.paths.root).idle_lock_minutes;
        let now = cfg.clock.now_ms();
        let mut core = Self {
            cfg,
            state: State::Setup,
            journal: None,
            lock_enabled: false,
            set_aside: false,
            idle_minutes,
            idle_override_secs: None,
            last_activity_ms: now,
            last_snapshot_day: None,
            notifier,
            dirty: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            crash_at: None,
        };
        core.boot();
        core
    }

    fn product(&self) -> &'static str {
        self.cfg.brand.product_name
    }

    fn keys(&self) -> KeyVault<'_> {
        KeyVault::new(self.cfg.vault.as_ref(), self.cfg.kdf)
    }

    fn throttle(&self) -> Throttle<'_> {
        Throttle::new(
            self.cfg.vault.as_ref(),
            self.cfg.clock.as_ref(),
            self.cfg.brand.product_name,
        )
    }

    fn ledger(&self) -> Ledger {
        Ledger::new(self.cfg.vault.clone())
    }

    fn screenshots(&self) -> Screenshots {
        Screenshots::new(&self.cfg.paths.screenshots())
    }

    #[cfg(test)]
    fn crash(&self, point: CrashPoint) -> bool {
        self.crash_at == Some(point)
    }

    fn fail(&mut self, code: &'static str, message: String) {
        log::error!("journal not opened: {code}");
        self.journal = None;
        self.state = State::Failed { code, message };
    }

    fn vault_message(&self) -> String {
        format!(
            "{} could not read the system keyring (Windows Credential Manager or the Secret \
             Service on Linux), so the journal was not opened. Nothing was changed.",
            self.product()
        )
    }

    /// The launch gate (SPEC 2.1): older copy → lock screen → setup → open.
    fn boot(&mut self) {
        self.journal = None;
        self.set_aside = false;
        let state = match self.keys().state() {
            Ok(state) => state,
            Err(_) => {
                // Fail closed: a wrapped key that can't be read keeps the app locked.
                if matches!(self.cfg.vault.lookup(WRAPPED_KEY), Lookup::Failed(_)) {
                    log::error!("the wrapped key is unreadable; staying locked");
                    self.lock_enabled = true;
                    self.state = State::Locked {
                        vault_unreadable: true,
                    };
                } else {
                    let message = self.vault_message();
                    self.fail("vault_unavailable", message);
                }
                return;
            }
        };
        self.lock_enabled = state == KeyState::Wrapped;
        if self.lock_enabled {
            self.keys().remove_plain_copy_if_wrapped();
        }
        let file = match journal::read_file(&self.cfg.paths.journal()) {
            Ok(file) => file,
            Err(e) => {
                log::error!("could not read the journal file: {e}");
                self.fail(
                    "io",
                    "The journal file could not be read. Nothing was changed.".into(),
                );
                return;
            }
        };
        match (file, state) {
            (Some(bytes), _) => {
                if let Ok(stamp) = seal::read_stamp(&bytes) {
                    if let Verdict::Older { file, record } =
                        ledger::verdict(&stamp, &bytes, self.ledger().last_saved().as_ref())
                    {
                        log::warn!("the journal file is older than the last recorded save");
                        self.state = State::OlderCopy { file, record };
                        return;
                    }
                }
                match state {
                    KeyState::Empty => {
                        let message = format!(
                            "The key for this {} journal is missing from the system keyring, so \
                             the journal was not opened. The journal file was left untouched.",
                            self.product()
                        );
                        self.fail("key_missing", message);
                    }
                    KeyState::Wrapped => {
                        self.state = State::Locked {
                            vault_unreadable: false,
                        }
                    }
                    KeyState::Plain => match self.keys().plain_key() {
                        Ok(Some(key)) => self.open_journal(key, None, true),
                        Ok(None) | Err(VaultError::Corrupt) => {
                            let message = format!(
                                "{} found its journal key in the system keyring but could not \
                                 read it. Nothing was changed.",
                                self.product()
                            );
                            self.fail("key_unreadable", message);
                        }
                        Err(_) => {
                            let message = self.vault_message();
                            self.fail("vault_unavailable", message);
                        }
                    },
                }
            }
            (None, KeyState::Empty) => {
                if self.cfg.vault.lock_required() {
                    self.state = State::Setup;
                    return;
                }
                match self.keys().create_plain_key() {
                    Ok(key) => self.create_journal(key),
                    Err(e) => {
                        log::error!("could not create a journal key: {e}");
                        let message = format!(
                            "{} could not save a key in the system keyring.",
                            self.product()
                        );
                        self.fail("vault_write", message);
                    }
                }
            }
            (None, KeyState::Plain) => match self.keys().plain_key() {
                Ok(Some(key)) => self.create_journal(key),
                _ => {
                    let message = self.vault_message();
                    self.fail("vault_unavailable", message);
                }
            },
            (None, KeyState::Wrapped) => {
                self.state = State::Locked {
                    vault_unreadable: false,
                }
            }
        }
    }

    fn create_journal(&mut self, key: JournalKey) {
        match Journal::create(
            &self.cfg.paths.journal(),
            key,
            self.cfg.brand.journal_byte,
            Some(self.ledger()),
        ) {
            Ok(journal) => {
                log::info!("created a new journal");
                self.became_unlocked(journal);
            }
            Err(e) => {
                log::error!("could not create the journal: {e}");
                let message = format!(
                    "{} could not save a new journal in its data folder.",
                    self.product()
                );
                self.fail("save_failed", message);
            }
        }
    }

    fn became_unlocked(&mut self, journal: Journal) {
        self.journal = Some(journal);
        self.state = State::Unlocked;
        self.last_activity_ms = self.cfg.clock.now_ms();
        self.daily_snapshot();
        self.sync_flags();
    }

    /// Opens the journal file with `current` (then `previous`). With `check_ledger`, an older
    /// copy moves to the older-copy screen instead. A file that fails to decrypt is set aside
    /// (never deleted) and a new journal is started.
    fn open_journal(&mut self, current: JournalKey, previous: Option<JournalKey>, check_ledger: bool) {
        let path = self.cfg.paths.journal();
        let bytes = match journal::read_file(&path) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return self.create_journal(current),
            Err(e) => {
                log::error!("could not read the journal file: {e}");
                return self.fail(
                    "io",
                    "The journal file could not be read. Nothing was changed.".into(),
                );
            }
        };
        if check_ledger {
            if let Ok(stamp) = seal::read_stamp(&bytes) {
                if let Verdict::Older { file, record } =
                    ledger::verdict(&stamp, &bytes, self.ledger().last_saved().as_ref())
                {
                    self.state = State::OlderCopy { file, record };
                    return;
                }
            }
        }
        match Journal::open(
            &path,
            &bytes,
            current,
            previous,
            self.cfg.brand.journal_byte,
            &self.cfg.paths.snapshots(),
            Some(self.ledger()),
        ) {
            Ok(loaded) => {
                let mut journal = loaded.journal;
                if let Some(target) = loaded.rekey_to {
                    if let Err(e) = journal.rekey(target) {
                        log::error!("could not re-seal the journal with the current key yet: {e}");
                    }
                }
                log::info!("journal open (generation {})", journal.generation());
                self.became_unlocked(journal);
            }
            Err((LoadError::Unreadable(e), key)) => {
                log::warn!("journal file is unreadable ({e}); setting it aside");
                let ms = self.cfg.clock.now_ms();
                let target = self.cfg.paths.set_aside().join(format!("journal-{ms}.sealed"));
                if let Err(e) = fs::rename(&path, target) {
                    log::error!("could not set the unreadable journal aside: {e}");
                    return self.fail(
                        "io",
                        "The journal file could not be read or moved. Nothing was deleted.".into(),
                    );
                }
                self.create_journal(key);
                self.set_aside = true;
            }
            Err((LoadError::Other(e), _)) => {
                log::error!("could not load the journal: {e}");
                let message = format!(
                    "{} could not open its journal file ({e}). The file was left untouched.",
                    self.product()
                );
                self.fail("load_failed", message);
            }
        }
    }

    fn sync_flags(&self) {
        let dirty = self.journal.as_ref().is_some_and(Journal::is_dirty);
        let before = self.dirty.swap(dirty, Ordering::SeqCst);
        if before != dirty {
            self.notifier.save_state(dirty);
        }
    }

    /// Shared flag for the window's close handler (no store round trip needed).
    pub fn dirty_flag(&self) -> Arc<AtomicBool> {
        self.dirty.clone()
    }

    // -----------------------------------------------------------------------------------------
    // Status
    // -----------------------------------------------------------------------------------------

    pub fn status(&self) -> LockStatus {
        let phase = match &self.state {
            State::Unlocked => Phase::Unlocked,
            State::Locked { vault_unreadable } => Phase::Locked {
                vault_unreadable: *vault_unreadable,
                held: self.journal.is_some(),
            },
            State::OlderCopy { file, record } => Phase::OlderCopy {
                file_saved_at_ms: file.saved_at_ms,
                file_generation: file.generation,
                record_saved_at_ms: record.saved_at_ms,
                record_generation: record.generation,
                needs_password: self.lock_enabled,
            },
            State::Setup => Phase::Setup,
            State::Failed { code, message } => Phase::Failed {
                code: *code,
                message: message.clone(),
            },
        };
        LockStatus {
            phase,
            lock_enabled: self.lock_enabled,
            lock_required: self.cfg.vault.lock_required(),
            vault_backend: self.cfg.vault.backend(),
            throttle: self.throttle().status(),
            idle_lock_minutes: self.idle_minutes,
            save_failing: self.journal.as_ref().is_some_and(Journal::is_dirty),
            set_aside: self.set_aside,
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.state == State::Unlocked
    }

    pub fn journal(&self) -> Result<&Journal, OpError> {
        match (&self.state, &self.journal) {
            (State::Unlocked, Some(j)) => Ok(j),
            _ => Err(OpError::new("locked", "The journal is locked.")),
        }
    }

    pub fn journal_mut(&mut self) -> Result<&mut Journal, OpError> {
        match (&self.state, &mut self.journal) {
            (State::Unlocked, Some(j)) => Ok(j),
            _ => Err(OpError::new("locked", "The journal is locked.")),
        }
    }

    /// Runs a write on the journal, then updates the save-failure flag.
    pub fn with_journal<T>(
        &mut self,
        f: impl FnOnce(&mut Journal) -> Result<T, journal::StoreError>,
    ) -> Result<T, OpError> {
        let journal = self.journal_mut()?;
        let result = f(journal);
        self.sync_flags();
        result.map_err(|e| {
            log::error!("journal write failed: {e}");
            OpError::new(
                "save_failed",
                "The change is kept in memory, but it could not be saved to disk yet.",
            )
        })
    }

    // -----------------------------------------------------------------------------------------
    // Throttled password checks
    // -----------------------------------------------------------------------------------------

    fn gate(&self) -> Result<(), OpError> {
        match self.throttle().check() {
            Gate::Allowed => Ok(()),
            Gate::Wait(s) => Err(OpError::new("throttled", crate::throttle::wait_message(s))),
            Gate::Unreadable => Err(OpError::new(
                "throttle_unreadable",
                self.throttle().unreadable_message(),
            )),
        }
    }

    fn vault_error(&self, e: VaultError) -> OpError {
        match e {
            VaultError::Unreadable(_) => OpError::new("vault_unreadable", self.vault_message()),
            VaultError::RotationPending => OpError::new(
                "rotation_pending",
                format!(
                    "{} hasn't finished re-encrypting some files with the current key yet, so \
                     nothing was changed. Make sure the data folder can be written to, then \
                     try again.",
                    self.product()
                ),
            ),
            VaultError::Corrupt => OpError::new("corrupt", "The stored key is damaged."),
            other => OpError::new("vault", other.to_string()),
        }
    }

    /// Checks the App Lock password through the shared throttle and returns the keys.
    fn check_password(&self, password: &str) -> Result<crate::keyvault::UnwrappedKeys, OpError> {
        self.gate()?;
        match self.keys().unwrap_keys(password) {
            Ok(keys) => {
                self.throttle().reset();
                Ok(keys)
            }
            Err(VaultError::WrongPassword) => {
                let message = self.throttle().record_failure();
                Err(OpError::new("wrong_password", message))
            }
            Err(e) => Err(self.vault_error(e)),
        }
    }

    // -----------------------------------------------------------------------------------------
    // Unlock, lock, older copy, setup
    // -----------------------------------------------------------------------------------------

    pub fn unlock(&mut self, password: &str) -> Result<LockStatus, OpError> {
        if !matches!(self.state, State::Locked { .. }) {
            return Err(OpError::new("not_locked", "The journal is not locked."));
        }
        self.gate()?;
        match self.keys().has_wrapped() {
            Err(_) => {
                self.state = State::Locked {
                    vault_unreadable: true,
                };
                return Err(OpError::new("vault_unreadable", self.vault_message()));
            }
            Ok(false) => {
                // No wrapped key and no legacy item: open as a lock-off launch would, unless
                // a journal is held (then stay locked: the vault is not trustworthy now).
                if self.journal.is_some() {
                    return Err(OpError::new("vault_unreadable", self.vault_message()));
                }
                self.lock_enabled = false;
                self.boot();
                return Ok(self.status());
            }
            Ok(true) => {}
        }
        let keys = self.check_password(password)?;
        if let Some(held) = self.journal.as_mut() {
            let ours = held.key().same_as(&keys.current)
                || keys.previous.as_ref().is_some_and(|p| held.key().same_as(p));
            if !ours {
                return Err(OpError::new(
                    "key_mismatch",
                    "The keyring holds a different key than the journal in memory, so it stays locked.",
                ));
            }
            if held.is_dirty() {
                if let Err(e) = held.save() {
                    log::error!("the held journal still can't be saved: {e}");
                }
            }
            self.state = State::Unlocked;
            self.last_activity_ms = self.cfg.clock.now_ms();
        } else {
            let current = copy_key(&keys.current);
            let previous = keys.previous.as_ref().map(copy_key);
            self.open_journal(current, previous, true);
        }
        if self.state == State::Unlocked && keys.previous.is_some() {
            let _ = self.finish_rotation(&keys, password);
        }
        self.sync_flags();
        Ok(self.status())
    }

    /// Locks (idle, OS trigger, minimize, "Lock now"). Saves first; if that fails the journal
    /// is held in memory behind the lock screen and saved at the next unlock.
    pub fn lock(&mut self, why: &str) -> bool {
        if self.state != State::Unlocked || !self.lock_enabled {
            return false;
        }
        let mut hold = false;
        if let Some(journal) = self.journal.as_mut() {
            if journal.is_dirty() {
                hold = journal.save().is_err();
            }
        }
        if !hold {
            // Drops the connection and the key (zeroized on drop).
            self.journal = None;
        }
        self.state = State::Locked {
            vault_unreadable: false,
        };
        log::info!("locked ({why}{})", if hold { ", journal held" } else { "" });
        self.sync_flags();
        self.notifier.locked();
        true
    }

    /// "Open this copy" on the older-copy screen: the App Lock password (lock on, throttled)
    /// or an explicit confirmation (lock off). Starts a new epoch; the count never goes down.
    pub fn open_older(&mut self, password: Option<&str>, confirmed: bool) -> Result<LockStatus, OpError> {
        let State::OlderCopy { file, record } = self.state.clone() else {
            return Err(OpError::new("not_older", "There is no older copy to open."));
        };
        let (current, previous, keys_for_finish) = if self.lock_enabled {
            let keys = self.check_password(password.unwrap_or(""))?;
            (
                copy_key(&keys.current),
                keys.previous.as_ref().map(copy_key),
                Some(keys),
            )
        } else {
            if !confirmed {
                return Err(OpError::new("confirm", "Confirm that you want to open this copy."));
            }
            match self.keys().plain_key() {
                Ok(Some(key)) => (key, None, None),
                Ok(None) => {
                    return Err(OpError::new(
                        "key_missing",
                        "The key for this journal is missing from the system keyring.",
                    ))
                }
                Err(e) => return Err(self.vault_error(e)),
            }
        };
        self.open_journal(current, previous, false);
        if self.state != State::Unlocked {
            return Ok(self.status());
        }
        let at_least = file.generation.max(record.generation);
        if let Some(journal) = self.journal.as_mut() {
            if let Err(e) = journal.start_new_epoch(at_least) {
                log::error!("the new line of saves could not be saved yet: {e}");
            }
        }
        log::warn!("an older copy was opened on purpose; a new epoch started");
        if let (Some(keys), Some(pw)) = (keys_for_finish.as_ref(), password) {
            if keys.previous.is_some() {
                let _ = self.finish_rotation(keys, pw);
            }
        }
        self.sync_flags();
        Ok(self.status())
    }

    /// First launch without a system keyring: App Lock is mandatory, so a password is set
    /// before any key or journal exists.
    pub fn setup(&mut self, password: &str, confirmation: &str) -> Result<LockStatus, OpError> {
        if self.state != State::Setup {
            return Err(OpError::new("not_setup", "A password is already set."));
        }
        if let Some(problem) = password_problem(password, confirmation) {
            return Err(OpError::new("invalid_password", problem));
        }
        let wrapper = Wrapper::new(password, self.cfg.kdf).map_err(|e| self.vault_error(e))?;
        let key = self
            .keys()
            .create_wrapped_key(&wrapper)
            .map_err(|e| self.vault_error(e))?;
        self.lock_enabled = true;
        self.create_journal(key);
        Ok(self.status())
    }

    // -----------------------------------------------------------------------------------------
    // Key rotation (SPEC 6.1 item 5)
    // -----------------------------------------------------------------------------------------

    /// Steps 2–3 for the files next to the journal: re-seal snapshots and screenshots from
    /// `old` to `new`; drop `old` only when nothing needs it and the journal on disk opens
    /// with `new`.
    fn reseal_and_finish(&self, old: &JournalKey, new: &JournalKey, wrapper: Option<&Wrapper>) -> Outcome {
        let brand = self.cfg.brand.journal_byte;
        let mut pending = 0usize;
        match snapshot::reseal(&self.cfg.paths.snapshots(), brand, old, new) {
            Ok(list) => pending += list.len(),
            Err(e) => {
                log::error!("could not list the snapshots to re-seal them: {e}");
                pending += 1;
            }
        }
        match self.screenshots().reseal(old, new) {
            Ok(list) => pending += list.len(),
            Err(e) => {
                log::error!("could not list the screenshots to re-seal them: {e}");
                pending += 1;
            }
        }
        if pending > 0 {
            log::error!("{pending} file(s) still need the previous key; finishing at the next unlock");
            return Outcome::FinishesOnNextUnlock;
        }
        let opens = fs::read(self.cfg.paths.journal())
            .ok()
            .is_some_and(|bytes| seal::open(new, brand, &bytes).is_ok());
        if !opens {
            log::error!("the journal on disk does not open with the new key; keeping the previous key");
            return Outcome::FinishesOnNextUnlock;
        }
        let Some(wrapper) = wrapper else {
            return Outcome::FinishesOnNextUnlock;
        };
        match self.keys().finish_rotation(new, wrapper) {
            Ok(()) => Outcome::Complete,
            Err(e) => {
                log::error!("could not drop the previous key: {e}");
                Outcome::FinishesOnNextUnlock
            }
        }
    }

    /// After an unlock that found two keys: re-seal with the current key and drop the
    /// previous one when nothing needs it any more.
    fn finish_rotation(
        &mut self,
        keys: &crate::keyvault::UnwrappedKeys,
        password: &str,
    ) -> Outcome {
        let Some(previous) = keys.previous.as_ref() else {
            return Outcome::Complete;
        };
        if let Some(journal) = self.journal.as_mut() {
            if !journal.key().same_as(&keys.current) {
                if let Err(e) = journal.rekey(copy_key(&keys.current)) {
                    log::error!("journal not re-sealed yet: {e}");
                    return Outcome::FinishesOnNextUnlock;
                }
            }
        }
        let wrapper = match Wrapper::new(password, self.cfg.kdf) {
            Ok(w) => w,
            Err(_) => return Outcome::FinishesOnNextUnlock,
        };
        let outcome = self.reseal_and_finish(previous, &keys.current, Some(&wrapper));
        log::info!("pending key rotation: {outcome:?}");
        outcome
    }

    /// Steps 1–3 from the journal's current key to a new one wrapped with `password`.
    fn rotate(&mut self, password: &str) -> Result<Outcome, OpError> {
        let old = copy_key(self.journal()?.key());
        let wrapper = Wrapper::new(password, self.cfg.kdf).map_err(|e| self.vault_error(e))?;
        let new = match self.keys().begin_rotation(&old, &wrapper) {
            Ok(new) => new,
            Err(VaultError::Unconfirmed) => {
                // Most likely stored: the new password is in force; the next unlock finishes.
                log::error!("the new key could not be read back; finishing at the next unlock");
                self.lock_enabled = true;
                return Ok(Outcome::FinishesOnNextUnlock);
            }
            Err(e) => return Err(self.vault_error(e)),
        };
        // From here on the new key and password are in force.
        self.lock_enabled = true;
        #[cfg(test)]
        if self.crash(CrashPoint::AfterBegin) {
            return Err(OpError::new("crashed", "test crash"));
        }
        let rekeyed = match self.journal.as_mut() {
            Some(journal) => journal.rekey(copy_key(&new)),
            None => Ok(()),
        };
        self.sync_flags();
        if let Err(e) = rekeyed {
            log::error!("journal not re-sealed yet; finishing at the next unlock: {e}");
            return Ok(Outcome::FinishesOnNextUnlock);
        }
        #[cfg(test)]
        if self.crash(CrashPoint::AfterRekey) {
            return Err(OpError::new("crashed", "test crash"));
        }
        #[cfg(test)]
        if self.crash(CrashPoint::AfterReseal) {
            // Re-seal the files, then stop before the old key is dropped.
            let _ = self.reseal_and_finish(&old, &new, None);
            return Err(OpError::new("crashed", "test crash"));
        }
        Ok(self.reseal_and_finish(&old, &new, Some(&wrapper)))
    }

    /// Turns App Lock on (SPEC 6.6). The key is rotated: the old bare key may survive in a
    /// vault backup, so it must not decrypt the journal any more.
    pub fn enable(&mut self, password: &str, confirmation: &str) -> Result<Outcome, OpError> {
        self.journal()?;
        if self.lock_enabled {
            return Err(OpError::new("already_on", "App Lock is already on."));
        }
        if let Some(problem) = password_problem(password, confirmation) {
            return Err(OpError::new("invalid_password", problem));
        }
        let outcome = self.rotate(password)?;
        self.last_activity_ms = self.cfg.clock.now_ms();
        log::info!("App Lock turned on ({outcome:?})");
        Ok(outcome)
    }

    /// Changes the password (needs the current one, throttled) with a key rotation.
    pub fn change(
        &mut self,
        current: &str,
        password: &str,
        confirmation: &str,
    ) -> Result<Outcome, OpError> {
        self.journal()?;
        if !self.lock_enabled {
            return Err(OpError::new("not_on", "App Lock is off."));
        }
        if let Some(problem) = password_problem(password, confirmation) {
            return Err(OpError::new("invalid_password", problem));
        }
        let keys = self.check_password(current)?;
        if keys.previous.is_some() && self.finish_rotation(&keys, current) != Outcome::Complete {
            return Err(self.vault_error(VaultError::RotationPending));
        }
        let outcome = self.rotate(password)?;
        log::info!("App Lock password changed ({outcome:?})");
        Ok(outcome)
    }

    /// Turns App Lock off (needs the current password, throttled).
    pub fn disable(&mut self, password: &str) -> Result<LockStatus, OpError> {
        self.journal()?;
        if !self.lock_enabled {
            return Err(OpError::new("not_on", "App Lock is off."));
        }
        if self.cfg.vault.lock_required() {
            return Err(OpError::new(
                "lock_required",
                "App Lock can't be turned off on this computer: there is no system keyring to \
                 hold the key without a password.",
            ));
        }
        let keys = self.check_password(password)?;
        if keys.previous.is_some() && self.finish_rotation(&keys, password) != Outcome::Complete {
            return Err(self.vault_error(VaultError::RotationPending));
        }
        self.keys()
            .store_plain(&keys.current)
            .map_err(|e| self.vault_error(e))?;
        self.lock_enabled = false;
        log::info!("App Lock turned off");
        Ok(self.status())
    }

    // -----------------------------------------------------------------------------------------
    // Erase (SPEC 6.6 "Forgot password?")
    // -----------------------------------------------------------------------------------------

    /// Erases every local trace: journal first (checked gone), then snapshots, set-aside
    /// files, screenshots, the rollback record, the throttle, the keys and API keys. Refused
    /// while a key item can't be read. `confirmation` must be the product name.
    pub fn erase(&mut self, confirmation: &str) -> Result<LockStatus, OpError> {
        if confirmation != self.product() {
            return Err(OpError::new(
                "confirm",
                format!("Type {} to confirm.", self.product()),
            ));
        }
        for account in [WRAPPED_KEY, DATABASE_KEY] {
            if let Lookup::Failed(e) = self.cfg.vault.lookup(account) {
                log::error!("erase refused: a key item is unreadable ({e})");
                return Err(OpError::new(
                    "vault_unreadable",
                    "Erase was refused because the system keyring can't be read right now. \
                     Nothing was deleted.",
                ));
            }
        }
        self.journal = None;
        let path = self.cfg.paths.journal();
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => {
                log::error!("erase: could not delete the journal: {e}");
                return Err(OpError::new("io", "The journal file could not be deleted."));
            }
        }
        if path.exists() {
            return Err(OpError::new("io", "The journal file could not be deleted."));
        }
        #[cfg(test)]
        if self.crash(CrashPoint::AfterJournalDeleted) {
            return Err(OpError::new("crashed", "test crash"));
        }
        let paths = &self.cfg.paths;
        let mut problems = 0;
        for result in [
            snapshot::delete_all(&paths.snapshots()),
            empty_dir(&paths.set_aside()),
            self.screenshots().delete_all(),
        ] {
            if let Err(e) = result {
                log::error!("erase: {e}");
                problems += 1;
            }
        }
        for account in vault::all_accounts() {
            if let Err(e) = self.cfg.vault.delete(account) {
                log::error!("erase: could not delete a keyring item: {e}");
                problems += 1;
            }
        }
        let _ = fs::remove_file(prefs::path(&paths.root));
        self.idle_minutes = prefs::IDLE_DEFAULT;
        log::info!("all local data erased ({problems} problem(s))");
        self.lock_enabled = false;
        self.boot();
        Ok(self.status())
    }

    // -----------------------------------------------------------------------------------------
    // Backups (SPEC 6.8)
    // -----------------------------------------------------------------------------------------

    /// The bytes of a backup of the journal as it is in memory: `DXBK` with a password, or
    /// the plain image without one.
    pub fn backup_bytes(&self, password: Option<(&str, &str)>) -> Result<Zeroizing<Vec<u8>>, OpError> {
        let image = self.journal()?.image().map_err(|e| {
            log::error!("backup: {e}");
            OpError::new("backup_failed", "The backup could not be made.")
        })?;
        match password {
            None => Ok(image),
            Some((pw, confirmation)) => {
                if let Some(problem) = password_problem(pw, confirmation) {
                    return Err(OpError::new("invalid_password", problem));
                }
                backup::seal_desktop(&image, pw, self.cfg.kdf)
                    .map(Zeroizing::new)
                    .map_err(|e| OpError::new("backup_failed", e.to_string()))
            }
        }
    }

    /// Restores a backup file's bytes through validation; one transaction, one save. A
    /// sealed snapshot of the journal as it was is kept first.
    pub fn restore(
        &mut self,
        bytes: &[u8],
        file_name: Option<&str>,
        password: Option<&str>,
    ) -> Result<RestoreSummary, OpError> {
        self.journal()?;
        let image = backup::open(bytes, password).map_err(|e| {
            let code = match e {
                backup::BackupError::PasswordRequired => "password_required",
                backup::BackupError::WrongPassword => "wrong_backup_password",
                _ => "restore_refused",
            };
            OpError::new(code, e.to_string())
        })?;
        let contents = restore::validate(&image, &self.cfg.brand)
            .map_err(|e| OpError::new("restore_refused", e.to_string()))?;
        drop(image);
        let generation = self.journal()?.generation();
        let snaps = self.cfg.paths.snapshots();
        let name = format!("pre-restore-{}-g{generation}.sealed", self.cfg.clock.now_ms());
        if let Err(e) = fs::read(self.cfg.paths.journal())
            .and_then(|b| crate::fsec::write_atomic(&snaps.join(name), &b))
            .and_then(|()| snapshot::prune(&snaps, snapshot::KEEP))
        {
            log::warn!("no pre-restore snapshot: {e}");
        }
        let journal = self.journal_mut()?;
        let result = restore::apply(journal, &contents, file_name);
        self.sync_flags();
        let summary = result.map_err(|e| OpError::new("restore_failed", e.to_string()))?;
        log::info!("restore applied ({} trades)", summary.trades);
        Ok(summary)
    }

    /// The kind of a backup file (for the restore dialog).
    pub fn backup_kind(bytes: &[u8]) -> BackupKind {
        backup::kind(bytes)
    }

    // -----------------------------------------------------------------------------------------
    // Idle lock, snapshots, saves
    // -----------------------------------------------------------------------------------------

    pub fn activity(&mut self) {
        self.last_activity_ms = self.cfg.clock.now_ms();
    }

    fn idle_timeout_ms(&self) -> Option<i64> {
        if let Some(s) = self.idle_override_secs {
            return Some(i64::try_from(s).unwrap_or(i64::MAX).saturating_mul(1000));
        }
        match self.idle_minutes {
            0 => None,
            m => Some(i64::from(m) * 60_000),
        }
    }

    pub fn set_idle_minutes(&mut self, minutes: u32) -> Result<(), OpError> {
        if !prefs::IDLE_CHOICES.contains(&minutes) {
            return Err(OpError::new("invalid", "Choose Off, 1, 5, 15, 30 or 60 minutes."));
        }
        self.idle_minutes = minutes;
        self.activity();
        prefs::save(
            &self.cfg.paths.root,
            &prefs::Prefs {
                idle_lock_minutes: minutes,
            },
        )
        .map_err(|e| {
            log::error!("could not save prefs.json: {e}");
            OpError::new("prefs", "The setting could not be saved.")
        })
    }

    /// e2e builds and tests: an idle timeout in seconds (`None` = back to the setting).
    pub fn set_idle_override(&mut self, seconds: Option<u64>) {
        self.idle_override_secs = seconds;
        self.activity();
    }

    /// Runs every few seconds: the idle lock and the daily snapshot.
    pub fn tick(&mut self) {
        if self.state != State::Unlocked {
            return;
        }
        if self.lock_enabled {
            if let Some(timeout) = self.idle_timeout_ms() {
                if self.cfg.clock.now_ms() - self.last_activity_ms >= timeout {
                    self.lock("idle");
                    return;
                }
            }
        }
        self.daily_snapshot();
    }

    fn daily_snapshot(&mut self) {
        let day = day_of(self.cfg.clock.now_ms());
        if self.last_snapshot_day.as_deref() == Some(day.as_str()) {
            return;
        }
        let Some(journal) = self.journal.as_ref() else {
            return;
        };
        match snapshot::take_daily(
            &self.cfg.paths.snapshots(),
            journal.path(),
            &day,
            journal.generation(),
        ) {
            Ok(_) => self.last_snapshot_day = Some(day),
            Err(e) => log::warn!("daily snapshot not taken: {e}"),
        }
    }

    /// Tries a failed save again ("Try again").
    pub fn retry_save(&mut self) -> Result<(), OpError> {
        let result = match self.journal.as_mut() {
            Some(j) if j.is_dirty() => j.save().map_err(|e| {
                log::error!("save retry failed: {e}");
                OpError::new("save_failed", "The journal still can't be saved.")
            }),
            _ => Ok(()),
        };
        self.sync_flags();
        result
    }

    pub fn has_unsaved(&self) -> bool {
        self.journal.as_ref().is_some_and(Journal::is_dirty)
    }

    #[cfg(test)]
    pub fn set_crash(&mut self, point: Option<CrashPoint>) {
        self.crash_at = point;
    }
}

fn empty_dir(dir: &std::path::Path) -> io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The single writer
// ---------------------------------------------------------------------------------------------

type Job = Box<dyn FnOnce(&mut Core) + Send>;

/// Runs a [`Core`] on its own thread. Cheap to clone.
#[derive(Clone)]
pub struct Store {
    tx: mpsc::Sender<Job>,
    busy: Arc<AtomicBool>,
    dirty: Arc<AtomicBool>,
}

impl Store {
    pub fn spawn(core: Core) -> io::Result<Self> {
        let (tx, rx) = mpsc::channel::<Job>();
        let dirty = core.dirty_flag();
        std::thread::Builder::new()
            .name("journal-store".into())
            .spawn(move || {
                let mut core = core;
                for job in rx {
                    job(&mut core);
                }
                // Channel closed (app exiting): the journal and key drop here.
            })?;
        Ok(Self {
            tx,
            busy: Arc::new(AtomicBool::new(false)),
            dirty,
        })
    }

    fn gone() -> OpError {
        OpError::new("store", "The journal stopped responding. Quit and reopen the app.")
    }

    /// Runs `f` on the store thread and waits for its result.
    pub fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Core) -> T + Send + 'static,
    ) -> Result<T, OpError> {
        let (rtx, rrx) = mpsc::sync_channel(1);
        self.tx
            .send(Box::new(move |core| {
                let _ = rtx.send(f(core));
            }))
            .map_err(|_| Self::gone())?;
        rrx.recv().map_err(|_| Self::gone())
    }

    /// Queues `f` without waiting (idle ticks, activity, OS triggers).
    pub fn post(&self, f: impl FnOnce(&mut Core) + Send + 'static) {
        let _ = self.tx.send(Box::new(f));
    }

    /// A key operation: refused as `busy` while another is queued or running.
    pub fn key_op<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Core) -> Result<T, OpError> + Send + 'static,
    ) -> Result<T, OpError> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(OpError::busy());
        }
        let result = self.call(f).and_then(|r| r);
        self.busy.store(false, Ordering::SeqCst);
        result
    }

    /// True when the last save failed (for the close handler; no round trip).
    pub fn has_unsaved(&self) -> bool {
        self.dirty.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brand::{DOJIX, GREENWICK};
    use crate::journal::tests::contains_sqlite_magic;
    use crate::paths::resolve;
    use crate::throttle::ManualClock;
    use crate::vault::{FolderVault, MemoryVault, FAILED_ATTEMPTS, LOCKOUT_UNTIL, SAVE_RECORD};
    use std::sync::Mutex;

    const PW: &str = "fictional-pass-1";
    const PW2: &str = "fictional-pass-2";
    const T0: i64 = 1_767_225_600_000;

    struct Env {
        _tmp: tempfile::TempDir,
        paths: DataPaths,
        vault: Arc<MemoryVault>,
        clock: Arc<ManualClock>,
        locks: Arc<Mutex<u32>>,
    }

    struct CountLocks(Arc<Mutex<u32>>);
    impl Notifier for CountLocks {
        fn locked(&self) {
            *self.0.lock().unwrap() += 1;
        }
    }

    impl Env {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let paths = resolve(&DOJIX, true, Some(&tmp.path().join("data")), None).unwrap();
            paths.ensure().unwrap();
            Self {
                _tmp: tmp,
                paths,
                vault: Arc::new(MemoryVault::default()),
                clock: Arc::new(ManualClock::at(T0)),
                locks: Arc::new(Mutex::new(0)),
            }
        }

        fn core_with(&self, vault: Arc<dyn SecretStore>, brand: Brand) -> Core {
            Core::new(
                Config {
                    brand,
                    paths: self.paths.clone(),
                    vault,
                    kdf: KdfParams::TEST_MIN,
                    clock: self.clock.clone(),
                },
                Box::new(CountLocks(self.locks.clone())),
            )
        }

        /// A fresh process on the same data folder and vault.
        fn launch(&self) -> Core {
            self.core_with(self.vault.clone(), DOJIX)
        }

        fn locks(&self) -> u32 {
            *self.locks.lock().unwrap()
        }
    }

    fn add_trade(core: &mut Core) {
        core.with_journal(|j| j.add_sample_trade()).unwrap();
    }

    fn trades(core: &Core) -> i64 {
        core.journal().unwrap().trade_count().unwrap()
    }

    fn phase(core: &Core) -> Phase {
        core.status().phase
    }

    fn locked_phase() -> Phase {
        Phase::Locked {
            vault_unreadable: false,
            held: false,
        }
    }

    #[test]
    fn password_rule() {
        assert!(password_problem("", "").is_some());
        assert!(password_problem("12345678", "12345679").is_some());
        assert!(password_problem("1234567", "1234567").is_some());
        assert!(password_problem("12345678", "12345678").is_none());
        let long = "é".repeat(128);
        assert!(password_problem(&long, &long).is_none(), "scalars, not bytes");
        let too_long = "x".repeat(129);
        assert!(password_problem(&too_long, &too_long).is_some());
    }

    #[test]
    fn lock_off_launch_creates_and_reopens_without_a_password() {
        let env = Env::new();
        let mut core = env.launch();
        assert_eq!(phase(&core), Phase::Unlocked);
        assert!(!core.status().lock_enabled);
        add_trade(&mut core);
        drop(core);
        let core = env.launch();
        assert_eq!(phase(&core), Phase::Unlocked);
        assert_eq!(trades(&core), 1);
        assert!(!contains_sqlite_magic(&env.paths.root));
    }

    #[test]
    fn enable_lock_restart_wrong_password_throttle_then_right_password() {
        let env = Env::new();
        let mut core = env.launch();
        add_trade(&mut core);
        let old_key = copy_key(core.journal().unwrap().key());
        assert_eq!(core.enable(PW, PW).unwrap(), Outcome::Complete);
        assert!(core.status().lock_enabled);
        // The old bare key no longer opens the journal (it was rotated).
        let bytes = fs::read(env.paths.journal()).unwrap();
        assert!(seal::open(&old_key, 1, &bytes).is_err());
        assert!(!env.vault.contains(DATABASE_KEY));
        assert!(!KeyVault::new(env.vault.as_ref(), KdfParams::TEST_MIN)
            .has_pending_rotation()
            .unwrap());
        drop(core);

        let mut core = env.launch();
        assert_eq!(phase(&core), locked_phase());
        assert!(core.journal().is_err(), "nothing decrypted before the password");
        for n in 1..=4 {
            let e = core.unlock("wrong-password").unwrap_err();
            assert_eq!(e.code, "wrong_password");
            assert_eq!(e.message, format!("Incorrect password ({n}/5)"));
        }
        let e = core.unlock("wrong-password").unwrap_err();
        assert_eq!(e.message, "Too many attempts. Try again in 30 seconds.");
        drop(core);

        // The wait survives a restart, and even the right password is not checked meanwhile.
        let mut core = env.launch();
        assert_eq!(core.status().throttle.wait_seconds, 30);
        assert_eq!(core.unlock(PW).unwrap_err().code, "throttled");
        env.clock.advance_ms(30_000);
        assert_eq!(core.unlock(PW).unwrap().phase, Phase::Unlocked);
        assert_eq!(trades(&core), 1);
        assert_eq!(core.status().throttle.attempts, 0, "a right password resets");
    }

    #[test]
    fn locking_wipes_the_journal_and_idle_lock_follows_the_setting() {
        let env = Env::new();
        let mut core = env.launch();
        core.enable(PW, PW).unwrap();
        assert_eq!(core.status().idle_lock_minutes, 15);
        env.clock.advance_ms(14 * 60_000);
        core.tick();
        assert!(core.is_unlocked());
        core.activity();
        env.clock.advance_ms(14 * 60_000);
        core.tick();
        assert!(core.is_unlocked(), "activity restarts the timer");
        env.clock.advance_ms(60_000);
        core.tick();
        assert_eq!(phase(&core), locked_phase());
        assert!(core.journal.is_none(), "journal and key dropped");
        assert_eq!(env.locks(), 1);

        core.unlock(PW).unwrap();
        core.set_idle_minutes(0).unwrap();
        env.clock.advance_ms(24 * 3_600_000);
        core.tick();
        assert!(core.is_unlocked(), "Off never locks");
        core.set_idle_override(Some(3));
        env.clock.advance_ms(3_000);
        core.tick();
        assert!(!core.is_unlocked(), "an injected short timeout");
        assert!(core.set_idle_minutes(7).is_err());
    }

    #[test]
    fn with_app_lock_off_nothing_locks() {
        let env = Env::new();
        let mut core = env.launch();
        assert!(!core.lock("os"));
        env.clock.advance_ms(3_600_000);
        core.tick();
        assert!(core.is_unlocked());
    }

    #[test]
    fn a_failed_save_holds_the_journal_behind_the_lock_and_saves_at_unlock() {
        let env = Env::new();
        let mut core = env.launch();
        core.enable(PW, PW).unwrap();
        let path = env.paths.journal();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(
            core.with_journal(|j| j.add_sample_trade()).unwrap_err().code,
            "save_failed"
        );
        assert!(core.status().save_failing);
        assert!(core.lock("lock now"));
        assert_eq!(
            phase(&core),
            Phase::Locked {
                vault_unreadable: false,
                held: true
            }
        );
        assert!(core.journal().is_err());
        fs::remove_dir(&path).unwrap();
        core.unlock(PW).unwrap();
        assert!(!core.status().save_failing);
        drop(core);
        let mut core = env.launch();
        core.unlock(PW).unwrap();
        assert_eq!(trades(&core), 1, "the held change reached the disk");
    }

    #[test]
    fn change_password_rotates_again_and_needs_the_current_one() {
        let env = Env::new();
        let mut core = env.launch();
        add_trade(&mut core);
        core.enable(PW, PW).unwrap();
        let key_before = copy_key(core.journal().unwrap().key());
        assert_eq!(core.change("wrong-password", PW2, PW2).unwrap_err().code, "wrong_password");
        assert_eq!(core.status().throttle.attempts, 1, "Settings shares the throttle");
        assert_eq!(core.change(PW, PW2, PW2).unwrap(), Outcome::Complete);
        assert!(!core.journal().unwrap().key().same_as(&key_before));
        drop(core);
        let mut core = env.launch();
        assert_eq!(core.unlock(PW).unwrap_err().code, "wrong_password");
        core.unlock(PW2).unwrap();
        assert_eq!(trades(&core), 1);
    }

    #[test]
    fn disable_needs_the_password_and_stores_the_key_bare() {
        let env = Env::new();
        let mut core = env.launch();
        add_trade(&mut core);
        core.enable(PW, PW).unwrap();
        assert_eq!(core.disable("wrong-password").unwrap_err().code, "wrong_password");
        core.disable(PW).unwrap();
        assert!(!core.status().lock_enabled);
        assert!(!env.vault.contains(WRAPPED_KEY));
        drop(core);
        let core = env.launch();
        assert_eq!(phase(&core), Phase::Unlocked);
        assert_eq!(trades(&core), 1);
    }

    /// Crash injection: the process stops after each rotation step. Whatever happened, the
    /// next launch unlocks with the NEW password, the data is intact, and the rotation
    /// finishes (only the new key stays stored).
    #[test]
    fn a_rotation_killed_at_any_step_finishes_at_the_next_unlock() {
        for point in [
            CrashPoint::AfterBegin,
            CrashPoint::AfterRekey,
            CrashPoint::AfterReseal,
        ] {
            let env = Env::new();
            let mut core = env.launch();
            add_trade(&mut core);
            // A snapshot and a screenshot that must follow the key.
            env.clock.advance_ms(86_400_000);
            core.tick();
            let shot = core
                .screenshots()
                .store(core.journal().unwrap().key(), 1, b"fictional jpeg")
                .unwrap();
            core.set_crash(Some(point));
            assert_eq!(core.enable(PW, PW).unwrap_err().code, "crashed", "{point:?}");
            drop(core);

            let kv = KeyVault::new(env.vault.as_ref(), KdfParams::TEST_MIN);
            assert!(kv.has_pending_rotation().unwrap(), "{point:?}: both keys kept");
            let mut core = env.launch();
            assert_eq!(phase(&core), locked_phase(), "{point:?}");
            core.unlock(PW).unwrap();
            assert_eq!(trades(&core), 1, "{point:?}");
            assert!(!kv.has_pending_rotation().unwrap(), "{point:?}: finished");
            let keys = kv.unwrap_keys(PW).unwrap();
            assert!(keys.current.same_as(core.journal().unwrap().key()));
            let image = core.screenshots().read(&keys.current, 1, &shot).unwrap();
            assert_eq!(image.as_slice(), b"fictional jpeg", "{point:?}");
            for entry in fs::read_dir(env.paths.snapshots()).unwrap() {
                let bytes = fs::read(entry.unwrap().path()).unwrap();
                assert!(seal::open(&keys.current, 1, &bytes).is_ok(), "{point:?}");
            }
        }
    }

    #[test]
    fn a_pending_rotation_blocks_disable_until_it_can_finish() {
        let env = Env::new();
        let mut core = env.launch();
        add_trade(&mut core);
        core.enable(PW, PW).unwrap();
        // An interrupted rotation: the vault holds [new, old] and the journal still uses old.
        let old = copy_key(core.journal().unwrap().key());
        let kv = KeyVault::new(env.vault.as_ref(), KdfParams::TEST_MIN);
        let w = Wrapper::new(PW, KdfParams::TEST_MIN).unwrap();
        kv.begin_rotation(&old, &w).unwrap();
        // A snapshot folder that can't be listed counts as "not done", so it can't finish.
        let snaps = env.paths.snapshots();
        fs::remove_dir_all(&snaps).unwrap();
        fs::write(&snaps, b"not a folder").unwrap();
        assert_eq!(core.disable(PW).unwrap_err().code, "rotation_pending");
        assert!(core.status().lock_enabled);
        assert!(kv.has_pending_rotation().unwrap(), "the previous key is kept");
        assert_eq!(core.enable(PW, PW).unwrap_err().code, "already_on");
        assert_eq!(core.change(PW, PW2, PW2).unwrap_err().code, "rotation_pending");
        // Once the folder is back, the next attempt finishes the rotation first.
        fs::remove_file(&snaps).unwrap();
        fs::create_dir(&snaps).unwrap();
        core.disable(PW).unwrap();
        assert!(!core.status().lock_enabled);
    }

    #[test]
    fn an_unreadable_wrapped_key_keeps_the_app_locked() {
        let env = Env::new();
        let mut core = env.launch();
        core.enable(PW, PW).unwrap();
        drop(core);
        env.vault.fail(WRAPPED_KEY);
        let mut core = env.launch();
        assert_eq!(
            phase(&core),
            Phase::Locked {
                vault_unreadable: true,
                held: false
            }
        );
        assert_eq!(core.unlock(PW).unwrap_err().code, "vault_unreadable");
        assert_eq!(core.status().throttle.attempts, 0, "no attempt counted");
        assert_eq!(core.erase("Dojix").unwrap_err().code, "vault_unreadable");
        assert!(env.paths.journal().exists(), "erase refused, nothing deleted");
        env.vault.heal();
        core.unlock(PW).unwrap();
        assert!(core.is_unlocked());
    }

    #[test]
    fn an_unreadable_bare_key_never_creates_a_new_one() {
        let env = Env::new();
        drop(env.launch());
        env.vault.fail(DATABASE_KEY);
        let core = env.launch();
        assert!(matches!(phase(&core), Phase::Failed { code: "vault_unavailable", .. }));
        env.vault.heal();
        assert!(env.vault.contains(DATABASE_KEY));
    }

    #[test]
    fn an_unreadable_throttle_checks_no_password() {
        for account in [FAILED_ATTEMPTS, LOCKOUT_UNTIL] {
            let env = Env::new();
            let mut core = env.launch();
            core.enable(PW, PW).unwrap();
            drop(core);
            env.vault.write(FAILED_ATTEMPTS, b"2").unwrap();
            env.vault.fail(account);
            let mut core = env.launch();
            assert!(core.status().throttle.unreadable);
            assert_eq!(core.unlock(PW).unwrap_err().code, "throttle_unreadable");
            assert!(!core.is_unlocked());
            env.vault.heal();
            assert!(matches!(env.vault.lookup(FAILED_ATTEMPTS), Lookup::Found(ref v) if v.as_slice() == b"2"));
        }
    }

    #[test]
    fn an_older_copy_is_refused_until_confirmed_and_the_count_never_goes_down() {
        let env = Env::new();
        let mut core = env.launch();
        add_trade(&mut core);
        let old_copy = fs::read(env.paths.journal()).unwrap();
        let old_generation = seal::read_stamp(&old_copy).unwrap().generation;
        add_trade(&mut core);
        add_trade(&mut core);
        let latest = core.journal().unwrap().generation();
        drop(core);
        fs::write(env.paths.journal(), &old_copy).unwrap();

        let mut core = env.launch();
        match phase(&core) {
            Phase::OlderCopy {
                file_generation,
                record_generation,
                needs_password,
                ..
            } => {
                assert_eq!((file_generation, record_generation), (old_generation, latest));
                assert!(!needs_password);
            }
            other => panic!("{other:?}"),
        }
        assert!(core.journal().is_err(), "nothing decrypted into the app");
        assert_eq!(fs::read(env.paths.journal()).unwrap(), old_copy, "file untouched");
        assert_eq!(core.open_older(None, false).unwrap_err().code, "confirm");
        core.open_older(None, true).unwrap();
        assert!(core.is_unlocked());
        assert_eq!(trades(&core), 1);
        let stamp = core.journal().unwrap().stamp();
        assert!(stamp.generation > latest, "the count never goes down");
        drop(core);
        // The record now follows the new epoch: the next launch opens normally.
        assert_eq!(phase(&env.launch()), Phase::Unlocked);
    }

    #[test]
    fn an_older_copy_with_app_lock_needs_the_password_through_the_throttle() {
        let env = Env::new();
        let mut core = env.launch();
        core.enable(PW, PW).unwrap();
        let old_copy = fs::read(env.paths.journal()).unwrap();
        add_trade(&mut core);
        drop(core);
        fs::write(env.paths.journal(), &old_copy).unwrap();
        let mut core = env.launch();
        assert!(matches!(phase(&core), Phase::OlderCopy { needs_password: true, .. }));
        assert_eq!(core.open_older(Some("wrong-password"), true).unwrap_err().code, "wrong_password");
        assert_eq!(core.status().throttle.attempts, 1);
        core.open_older(Some(PW), false).unwrap();
        assert!(core.is_unlocked());
        assert_eq!(trades(&core), 0);
    }

    #[test]
    fn a_save_whose_record_write_failed_still_opens() {
        let env = Env::new();
        let mut core = env.launch();
        add_trade(&mut core);
        env.vault.fail_writes(SAVE_RECORD);
        add_trade(&mut core);
        drop(core);
        env.vault.heal();
        let core = env.launch();
        assert_eq!(phase(&core), Phase::Unlocked, "a newer file in the same epoch opens");
        assert_eq!(trades(&core), 2);
    }

    #[test]
    fn a_save_killed_before_the_rename_leaves_the_last_journal() {
        let env = Env::new();
        let mut core = env.launch();
        add_trade(&mut core);
        drop(core);
        // What a kill between "write temp" and "rename" leaves behind.
        fs::write(env.paths.root.join(".tmp-0123456789abcdef01234567"), b"partial").unwrap();
        let core = env.launch();
        assert_eq!(phase(&core), Phase::Unlocked);
        assert_eq!(trades(&core), 1);
    }

    #[test]
    fn erase_deletes_the_journal_first_then_everything_else() {
        let env = Env::new();
        let mut core = env.launch();
        add_trade(&mut core);
        core.enable(PW, PW).unwrap();
        env.vault.write("anthropic_api_key", b"fictional-key").unwrap();
        env.clock.advance_ms(86_400_000);
        core.tick();
        assert_eq!(core.erase("dojix").unwrap_err().code, "confirm");
        core.set_crash(Some(CrashPoint::AfterJournalDeleted));
        assert_eq!(core.erase("Dojix").unwrap_err().code, "crashed");
        assert!(!env.paths.journal().exists(), "journal gone before any key");
        assert!(env.vault.contains(WRAPPED_KEY));
        drop(core);
        // A relaunch after the crash: the key exists but there is no journal; erasing again
        // (the lock screen's "Forgot password?") completes.
        let mut core = env.launch();
        assert_eq!(phase(&core), locked_phase());
        core.erase("Dojix").unwrap();
        for account in [WRAPPED_KEY, FAILED_ATTEMPTS, LOCKOUT_UNTIL, "anthropic_api_key"] {
            assert!(!env.vault.contains(account), "{account}");
        }
        // Fresh start: lock off, a new empty journal with a new key.
        assert_eq!(phase(&core), Phase::Unlocked);
        assert!(!core.status().lock_enabled);
        assert_eq!(trades(&core), 0);
        let key = core.journal().unwrap().key();
        for entry in fs::read_dir(env.paths.snapshots()).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(seal::open(key, 1, &bytes).is_ok(), "only the new journal's snapshot");
        }
    }

    #[test]
    fn backup_and_restore_round_trip_with_a_password() {
        let env = Env::new();
        let mut core = env.launch();
        add_trade(&mut core);
        add_trade(&mut core);
        assert_eq!(
            core.backup_bytes(Some(("short", "short"))).unwrap_err().code,
            "invalid_password"
        );
        let bytes = core.backup_bytes(Some((PW, PW))).unwrap();
        assert_eq!(&bytes[..4], b"DXBK");
        assert!(!bytes.windows(16).any(|w| w == crate::seal::SQLITE_MAGIC));
        let plain = core.backup_bytes(None).unwrap();
        assert_eq!(Core::backup_kind(&plain), BackupKind::Plain);
        core.with_journal(|j| {
            j.write(|tx| tx.execute("DELETE FROM trades", []).map(|_| ()))
        })
        .unwrap();
        assert_eq!(trades(&core), 0);
        assert_eq!(
            core.restore(&bytes, None, None).unwrap_err().code,
            "password_required"
        );
        assert_eq!(
            core.restore(&bytes, None, Some("wrong-password")).unwrap_err().code,
            "wrong_backup_password"
        );
        let summary = core.restore(&bytes, Some("j.dxbk"), Some(PW)).unwrap();
        assert_eq!(summary.trades, 2);
        assert_eq!(trades(&core), 2);
        let snaps: Vec<String> = fs::read_dir(env.paths.snapshots())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(snaps.iter().any(|n| n.starts_with("pre-restore-")));
        assert!(!contains_sqlite_magic(&env.paths.root));
    }

    #[test]
    fn a_mac_backup_restores_into_its_brand() {
        let env = Env::new();
        let mut core = env.launch();
        let image = crate::restore::tests::mac_dojix_backup("");
        let summary = core.restore(&image, None, None).unwrap();
        assert_eq!(summary.trades, 2);
        assert_eq!(trades(&core), 2);
        let other = Env::new();
        let mut greenwick = other.core_with(other.vault.clone(), GREENWICK);
        let e = greenwick.restore(&image, None, None).unwrap_err();
        assert_eq!(e.code, "restore_refused");
        assert!(e.message.contains("Dojix"), "{}", e.message);
    }

    #[test]
    fn without_a_system_keyring_a_password_is_required_from_the_start() {
        let env = Env::new();
        let folder: Arc<dyn SecretStore> = Arc::new(FolderVault::new(&env.paths.root));
        let mut core = env.core_with(folder.clone(), DOJIX);
        assert_eq!(phase(&core), Phase::Setup);
        assert!(core.status().lock_required);
        assert!(!env.paths.journal().exists(), "nothing created before a password");
        assert_eq!(core.setup("short", "short").unwrap_err().code, "invalid_password");
        core.setup(PW, PW).unwrap();
        assert!(core.is_unlocked());
        add_trade(&mut core);
        assert_eq!(core.disable(PW).unwrap_err().code, "lock_required");
        drop(core);
        assert!(env.paths.root.join(vault::WRAPPED_KEY_FILE).is_file());
        let mut core = env.core_with(folder, DOJIX);
        assert_eq!(phase(&core), locked_phase());
        core.unlock(PW).unwrap();
        assert_eq!(trades(&core), 1);
        assert!(!contains_sqlite_magic(&env.paths.root));
        // No bare key anywhere in the folder.
        let key = copy_key(core.journal().unwrap().key());
        fn holds(dir: &std::path::Path, needle: &[u8]) -> bool {
            fs::read_dir(dir).unwrap().any(|e| {
                let p = e.unwrap().path();
                if p.is_dir() {
                    holds(&p, needle)
                } else {
                    fs::read(&p).unwrap().windows(needle.len()).any(|w| w == needle)
                }
            })
        }
        assert!(!holds(&env.paths.root, key.as_bytes()));
    }

    #[test]
    fn the_store_runs_one_key_operation_at_a_time_and_defers_locks() {
        let env = Env::new();
        let core = env.launch();
        let store = Store::spawn(core).unwrap();
        store.key_op(|c| c.enable(PW, PW)).unwrap();
        // Block the store thread inside a key operation, then try a second one.
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let s2 = store.clone();
        let worker = std::thread::spawn(move || {
            s2.key_op(move |_c| {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        started_rx.recv().unwrap();
        assert_eq!(store.key_op(|_c| Ok(())).unwrap_err().code, "busy");
        // A lock requested now runs right after the running operation.
        store.post(|c| {
            c.lock("lock now");
        });
        release_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        let unlocked = store.call(|c| c.is_unlocked()).unwrap();
        assert!(!unlocked);
        assert_eq!(env.locks(), 1);
    }
}
