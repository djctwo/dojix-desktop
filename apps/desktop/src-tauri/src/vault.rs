//! The OS credential vault (SPEC 6.4): Windows Credential Manager, Secret Service on Linux.
//!
//! Every lookup has three outcomes: `Found`, `Absent` (only the backend's "not found") or
//! `Failed`. Decisions are made on that, and `Failed` is fail-closed: a key is never generated
//! over an item that exists but can't be read.
//!
//! Secrets never leave Rust: there is no IPC command that returns one.

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;

use zeroize::Zeroizing;

/// Vault account holding the bare journal key (App Lock off).
pub const DATABASE_KEY: &str = "database_encryption_key";
/// Account used by `--self-test` to prove the vault works. Removed after the check.
pub const SELF_TEST_PROBE: &str = "self_test_probe";

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

/// In-memory vault for unit tests, with failure injection.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryVault {
    items: Mutex<HashMap<String, Vec<u8>>>,
    failing: Mutex<Vec<String>>,
}

#[cfg(test)]
impl MemoryVault {
    /// Makes every operation on `account` fail, as an unreadable item would.
    pub fn fail(&self, account: &str) {
        self.failing.lock().unwrap().push(account.to_string());
    }

    fn is_failing(&self, account: &str) -> bool {
        self.failing.lock().unwrap().iter().any(|a| a == account)
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
        if self.is_failing(account) {
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
        v.delete(DATABASE_KEY).unwrap();
        v.delete(DATABASE_KEY).unwrap();
        assert!(matches!(v.lookup(DATABASE_KEY), Lookup::Absent));
    }
}
