//! The OS credential vault (SPEC 6.4): Windows Credential Manager, Secret Service on Linux.
//!
//! Every lookup has three outcomes: `Found`, `Absent` (only the backend's "not found") or
//! `Failed`. Decisions are made on that, and `Failed` is fail-closed: a key is never generated
//! over an item that exists but can't be read.
//!
//! Secrets never leave Rust: there is no IPC command that returns one.
//!
//! Linux without a Secret Service uses [`FolderVault`]: App Lock is mandatory there, the
//! wrapped key lives in `key.wrapped`, and the rollback record and throttle sit inside the
//! data folder (SPEC 6.4). A bare key is never written to disk.

#[cfg(test)]
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Mutex;

use zeroize::Zeroizing;

use crate::fsec;

/// Vault account holding the bare journal key (App Lock off).
pub const DATABASE_KEY: &str = "database_encryption_key";
/// App Lock on: the journal key(s) wrapped with the password (`DXKW`).
pub const WRAPPED_KEY: &str = "database_key_wrapped";
/// Rollback record: the last save this computer made (SPEC 6.5).
pub const SAVE_RECORD: &str = "journal_save_generation";
/// Wrong-password throttle (SPEC 6.6).
pub const FAILED_ATTEMPTS: &str = "lock_failed_attempts";
pub const LOCKOUT_UNTIL: &str = "lock_lockout_until";
/// Account used by `--self-test` to prove the vault works. Removed after the check.
pub const SELF_TEST_PROBE: &str = "self_test_probe";
/// User API keys (both brands; a brand uses only some of them).
pub const API_KEYS: &[&str] = &[
    "anthropic_api_key",
    "twelve_data_api_key",
    "polygon_api_key",
    "oanda_api_token",
    "oanda_account_id",
    "finnhub_api_key",
];

/// Every item "Erase all local data" removes.
pub fn all_accounts() -> Vec<&'static str> {
    let mut list = vec![
        DATABASE_KEY,
        WRAPPED_KEY,
        SAVE_RECORD,
        FAILED_ATTEMPTS,
        LOCKOUT_UNTIL,
    ];
    list.extend_from_slice(API_KEYS);
    list
}

pub enum Lookup {
    Found(Zeroizing<Vec<u8>>),
    Absent,
    Failed(String),
}

pub trait SecretStore: Send + Sync {
    /// Short name of the backend, for status and logs.
    fn backend(&self) -> &'static str;
    fn lookup(&self, account: &str) -> Lookup;
    /// Replaces the item in place (never delete-then-add).
    fn write(&self, account: &str, secret: &[u8]) -> Result<(), String>;
    /// Deletes the item; an absent item is not an error.
    fn delete(&self, account: &str) -> Result<(), String>;
    /// True when App Lock can't be turned off (no place for a bare key).
    fn lock_required(&self) -> bool {
        false
    }
}

/// The real OS vault. Service = the brand identifier (or a scratch name in tests).
pub struct OsVault {
    service: String,
}

impl OsVault {
    /// Fails when the platform has no usable credential store (e.g. Linux without a
    /// Secret Service).
    pub fn new(service: &str) -> Result<Self, String> {
        match keyring::Entry::store_status() {
            Ok(()) => Ok(Self {
                service: service.to_string(),
            }),
            Err(e) => Err(describe(e)),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, account).map_err(|e| describe(&e))
    }
}

impl SecretStore for OsVault {
    fn backend(&self) -> &'static str {
        if cfg!(windows) {
            "windows-credential-manager"
        } else {
            "secret-service"
        }
    }

    fn lookup(&self, account: &str) -> Lookup {
        let entry = match self.entry(account) {
            Ok(e) => e,
            Err(e) => return Lookup::Failed(e),
        };
        match entry.get_secret() {
            Ok(bytes) => Lookup::Found(Zeroizing::new(bytes)),
            Err(keyring::Error::NoEntry) => Lookup::Absent,
            Err(e) => Lookup::Failed(describe(&e)),
        }
    }

    fn write(&self, account: &str, secret: &[u8]) -> Result<(), String> {
        self.entry(account)?
            .set_secret(secret)
            .map_err(|e| describe(&e))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(describe(&e)),
        }
    }
}

/// Describes a vault error without ever including secret bytes (some variants carry them).
fn describe(e: &keyring::Error) -> String {
    match e {
        keyring::Error::NoEntry => "no such item".to_string(),
        keyring::Error::NoDefaultStore => "no credential store is available".to_string(),
        keyring::Error::NoStorageAccess(p) => format!("credential store refused access: {p}"),
        keyring::Error::PlatformFailure(p) => format!("credential store failure: {p}"),
        keyring::Error::BadEncoding(_) | keyring::Error::BadDataFormat(..) => {
            "stored item has an unexpected format".to_string()
        }
        _ => "unexpected credential store error".to_string(),
    }
}

/// A vault that is not there. Every lookup fails, so nothing is ever created without one.
pub struct UnavailableVault {
    pub reason: String,
}

impl SecretStore for UnavailableVault {
    fn backend(&self) -> &'static str {
        "unavailable"
    }
    fn lookup(&self, _account: &str) -> Lookup {
        Lookup::Failed(self.reason.clone())
    }
    fn write(&self, _account: &str, _secret: &[u8]) -> Result<(), String> {
        Err(self.reason.clone())
    }
    fn delete(&self, _account: &str) -> Result<(), String> {
        Err(self.reason.clone())
    }
}

/// Name of the wrapped-key file used when there is no system keyring.
pub const WRAPPED_KEY_FILE: &str = "key.wrapped";
/// Folder for the rollback record and throttle when there is no system keyring.
pub const LOCAL_RECORDS_DIR: &str = "local-records";

/// Linux without a Secret Service (SPEC 6.4): items live in the data folder. Only the
/// wrapped key, the rollback record and the throttle can be stored; a bare journal key or an
/// API key is refused, so nothing secret is ever written to disk unencrypted.
pub struct FolderVault {
    root: PathBuf,
}

impl FolderVault {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }

    /// True when the data folder already uses this mode (it sticks once chosen).
    pub fn in_use(root: &Path) -> bool {
        root.join(WRAPPED_KEY_FILE).exists()
    }

    fn path(&self, account: &str) -> Option<PathBuf> {
        match account {
            WRAPPED_KEY => Some(self.root.join(WRAPPED_KEY_FILE)),
            SAVE_RECORD | FAILED_ATTEMPTS | LOCKOUT_UNTIL | SELF_TEST_PROBE => {
                Some(self.root.join(LOCAL_RECORDS_DIR).join(account))
            }
            _ => None,
        }
    }
}

impl SecretStore for FolderVault {
    fn backend(&self) -> &'static str {
        "data-folder"
    }

    fn lookup(&self, account: &str) -> Lookup {
        let Some(path) = self.path(account) else {
            return Lookup::Absent;
        };
        match fs::read(&path) {
            Ok(bytes) => Lookup::Found(Zeroizing::new(bytes)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Lookup::Absent,
            Err(e) => Lookup::Failed(format!("could not read a record in the data folder: {e}")),
        }
    }

    fn write(&self, account: &str, secret: &[u8]) -> Result<(), String> {
        let Some(path) = self.path(account) else {
            return Err("this item can't be stored without a system keyring".to_string());
        };
        if let Some(dir) = path.parent() {
            fsec::create_private_dir(dir).map_err(|e| e.to_string())?;
        }
        fsec::write_atomic(&path, secret).map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let Some(path) = self.path(account) else {
            return Ok(());
        };
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn lock_required(&self) -> bool {
        true
    }
}

/// In-memory vault for unit tests, with failure injection.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryVault {
    items: Mutex<HashMap<String, Vec<u8>>>,
    failing: Mutex<Vec<String>>,
    failing_writes: Mutex<Vec<String>>,
}

#[cfg(test)]
impl MemoryVault {
    /// Makes every operation on `account` fail, as an unreadable item would.
    pub fn fail(&self, account: &str) {
        self.failing.lock().unwrap().push(account.to_string());
    }

    /// Makes only writes to `account` fail.
    pub fn fail_writes(&self, account: &str) {
        self.failing_writes
            .lock()
            .unwrap()
            .push(account.to_string());
    }

    /// Ends every injected failure.
    pub fn heal(&self) {
        self.failing.lock().unwrap().clear();
        self.failing_writes.lock().unwrap().clear();
    }

    fn is_failing(&self, account: &str) -> bool {
        self.failing.lock().unwrap().iter().any(|a| a == account)
    }

    pub fn contains(&self, account: &str) -> bool {
        self.items.lock().unwrap().contains_key(account)
    }
}

#[cfg(test)]
impl SecretStore for MemoryVault {
    fn backend(&self) -> &'static str {
        "memory"
    }

    fn lookup(&self, account: &str) -> Lookup {
        if self.is_failing(account) {
            return Lookup::Failed("injected failure".to_string());
        }
        match self.items.lock().unwrap().get(account) {
            Some(v) => Lookup::Found(Zeroizing::new(v.clone())),
            None => Lookup::Absent,
        }
    }

    fn write(&self, account: &str, secret: &[u8]) -> Result<(), String> {
        let write_fails = self
            .failing_writes
            .lock()
            .unwrap()
            .iter()
            .any(|a| a == account);
        if self.is_failing(account) || write_fails {
            return Err("injected failure".to_string());
        }
        self.items
            .lock()
            .unwrap()
            .insert(account.to_string(), secret.to_vec());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        if self.is_failing(account) {
            return Err("injected failure".to_string());
        }
        self.items.lock().unwrap().remove(account);
        Ok(())
    }
}

/// Writes a probe, reads it back and deletes it. Used by `--self-test`.
pub fn probe(store: &dyn SecretStore) -> Result<(), String> {
    let mut value = [0u8; 16];
    getrandom::fill(&mut value).map_err(|e| e.to_string())?;
    store.write(SELF_TEST_PROBE, &value)?;
    let read = store.lookup(SELF_TEST_PROBE);
    let delete = store.delete(SELF_TEST_PROBE);
    match read {
        Lookup::Found(v) if v.as_slice() == value => delete,
        Lookup::Found(_) => Err("probe read back a different value".to_string()),
        Lookup::Absent => Err("probe was not stored".to_string()),
        Lookup::Failed(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_vault_has_three_outcomes() {
        let v = MemoryVault::default();
        assert!(matches!(v.lookup("a"), Lookup::Absent));
        v.write("a", b"secret").unwrap();
        assert!(matches!(v.lookup("a"), Lookup::Found(ref s) if s.as_slice() == b"secret"));
        v.fail("a");
        assert!(matches!(v.lookup("a"), Lookup::Failed(_)));
    }

    #[test]
    fn probe_round_trips_and_cleans_up() {
        let v = MemoryVault::default();
        probe(&v).unwrap();
        assert!(matches!(v.lookup(SELF_TEST_PROBE), Lookup::Absent));
        let broken = UnavailableVault {
            reason: "none".to_string(),
        };
        assert!(probe(&broken).is_err());
    }

    #[test]
    fn folder_vault_stores_only_what_may_live_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let v = FolderVault::new(tmp.path());
        assert!(v.lock_required());
        assert!(!FolderVault::in_use(tmp.path()));
        assert!(matches!(v.lookup(WRAPPED_KEY), Lookup::Absent));
        v.write(WRAPPED_KEY, b"wrapped bytes").unwrap();
        assert!(FolderVault::in_use(tmp.path()));
        assert!(
            matches!(v.lookup(WRAPPED_KEY), Lookup::Found(ref s) if s.as_slice() == b"wrapped bytes")
        );
        v.write(FAILED_ATTEMPTS, b"3").unwrap();
        assert!(tmp
            .path()
            .join(LOCAL_RECORDS_DIR)
            .join(FAILED_ATTEMPTS)
            .is_file());

        // A bare key or an API key never reaches the disk.
        assert!(v.write(DATABASE_KEY, &[1u8; 32]).is_err());
        assert!(v.write("anthropic_api_key", b"fictional").is_err());
        assert!(matches!(v.lookup(DATABASE_KEY), Lookup::Absent));
        v.delete(DATABASE_KEY).unwrap();

        v.delete(WRAPPED_KEY).unwrap();
        v.delete(WRAPPED_KEY).unwrap();
        assert!(matches!(v.lookup(WRAPPED_KEY), Lookup::Absent));
    }

    #[cfg(unix)]
    #[test]
    fn folder_vault_read_errors_fail_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let v = FolderVault::new(tmp.path());
        // A folder where the file should be: exists but can't be read as a file.
        fs::create_dir(tmp.path().join(WRAPPED_KEY_FILE)).unwrap();
        assert!(matches!(v.lookup(WRAPPED_KEY), Lookup::Failed(_)));
    }

    #[test]
    fn erase_list_covers_keys_records_and_api_keys() {
        let all = all_accounts();
        for account in [
            DATABASE_KEY,
            WRAPPED_KEY,
            SAVE_RECORD,
            FAILED_ATTEMPTS,
            LOCKOUT_UNTIL,
            "finnhub_api_key",
        ] {
            assert!(all.contains(&account), "{account}");
        }
    }

    /// Runs against the real OS vault only when CI opts in (a scratch service name is used).
    #[test]
    fn os_vault_round_trip_when_enabled() {
        if std::env::var_os("DOJIX_TEST_OS_VAULT").is_none() {
            return;
        }
        let service = format!("io.github.djctwo.test.{}", std::process::id());
        let v = OsVault::new(&service).expect("OS vault available in CI");
        assert!(matches!(v.lookup("missing"), Lookup::Absent));
        probe(&v).unwrap();
        v.write(DATABASE_KEY, &[9u8; 32]).unwrap();
        v.write(DATABASE_KEY, &[8u8; 32]).unwrap();
        assert!(
            matches!(v.lookup(DATABASE_KEY), Lookup::Found(ref k) if k.as_slice() == [8u8; 32])
        );
        // A wrapped key is longer than a bare one; the vault must hold it byte for byte.
        let wrapped = vec![0xA5u8; 31 + 12 + 64 + 16];
        v.write(WRAPPED_KEY, &wrapped).unwrap();
        assert!(
            matches!(v.lookup(WRAPPED_KEY), Lookup::Found(ref k) if k.as_slice() == wrapped.as_slice())
        );
        v.delete(WRAPPED_KEY).unwrap();
        v.delete(DATABASE_KEY).unwrap();
        v.delete(DATABASE_KEY).unwrap();
        assert!(matches!(v.lookup(DATABASE_KEY), Lookup::Absent));
    }
}
