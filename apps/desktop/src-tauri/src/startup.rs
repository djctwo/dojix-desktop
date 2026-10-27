//! Opening the journal at launch, with App Lock off (SPEC 6.3, 6.4). Every vault decision is
//! made on a three-way lookup and fails closed.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::brand::Brand;
use crate::journal::{Journal, LoadError};
use crate::paths::DataPaths;
use crate::seal::JournalKey;
use crate::vault::{Lookup, SecretStore, DATABASE_KEY};

/// A start-up failure the UI can show. `message` never contains paths, keys or trade data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub struct Opened {
    pub journal: Journal,
    /// True when an unreadable journal file was moved to `set-aside/` and a new one started.
    pub set_aside: bool,
    pub created: bool,
}

fn key_for(
    vault: &dyn SecretStore,
    journal_exists: bool,
    product: &str,
) -> Result<JournalKey, Failure> {
    match vault.lookup(DATABASE_KEY) {
        Lookup::Found(bytes) => JournalKey::from_bytes(&bytes).ok_or_else(|| {
            log::error!("vault item {DATABASE_KEY} has an unexpected length");
            Failure::new(
                "key_unreadable",
                format!("{product} found its journal key in the system keyring but could not read it. Nothing was changed."),
            )
        }),
        Lookup::Absent if journal_exists => {
            log::error!("journal file exists but {DATABASE_KEY} is absent from the vault");
            Err(Failure::new(
                "key_missing",
                format!("The key for this {product} journal is missing from the system keyring, so the journal was not opened. The journal file was left untouched."),
            ))
        }
        Lookup::Absent => {
            let key = JournalKey::generate().map_err(|_| {
                Failure::new("random", "The operating system's random number generator failed.")
            })?;
            vault.write(DATABASE_KEY, key.as_bytes()).map_err(|e| {
                log::error!("could not store a new journal key: {e}");
                Failure::new("vault_write", format!("{product} could not save a key in the system keyring."))
            })?;
            match vault.lookup(DATABASE_KEY) {
                Lookup::Found(back) if back.as_slice() == key.as_bytes() => Ok(key),
                _ => {
                    log::error!("new journal key did not read back from the vault");
                    Err(Failure::new("vault_write", format!("{product} could not confirm the key it saved in the system keyring.")))
                }
            }
        }
        Lookup::Failed(e) => {
            log::error!("vault lookup failed: {e}");
            Err(Failure::new(
                "vault_unavailable",
                format!("{product} could not read the system keyring (Windows Credential Manager or the Secret Service on Linux), so the journal was not opened. Nothing was changed."),
            ))
        }
    }
}

/// Moves an unreadable journal into `set-aside/` (never deletes it).
fn set_aside(paths: &DataPaths) -> std::io::Result<()> {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let target = paths.set_aside().join(format!("journal-{ms}.sealed"));
    fs::rename(paths.journal(), target)
}

fn create(path: &Path, key: JournalKey, brand: &Brand) -> Result<Journal, Failure> {
    Journal::create(path, key, brand.journal_byte).map_err(|e| {
        log::error!("could not create the journal: {e}");
        Failure::new(
            "save_failed",
            format!("{} could not save a new journal in its data folder.", brand.product_name),
        )
    })
}

/// Opens (or creates) the journal for this brand and data folder.
pub fn open_journal(
    brand: &Brand,
    paths: &DataPaths,
    vault: &dyn SecretStore,
) -> Result<Opened, Failure> {
    let path = paths.journal();
    let exists = path.try_exists().map_err(|e| {
        log::error!("could not check the journal file: {e}");
        Failure::new("io", "The journal file could not be checked. Nothing was changed.")
    })?;
    let key = key_for(vault, exists, brand.product_name)?;
    if !exists {
        let journal = create(&path, key, brand)?;
        log::info!("created a new journal");
        return Ok(Opened {
            journal,
            set_aside: false,
            created: true,
        });
    }
    match Journal::load(&path, key, brand.journal_byte, &paths.snapshots()) {
        Ok(journal) => Ok(Opened {
            journal,
            set_aside: false,
            created: false,
        }),
        Err((LoadError::Unreadable(e), key)) => {
            log::warn!("journal file is unreadable ({e}); setting it aside");
            set_aside(paths).map_err(|e| {
                log::error!("could not set the unreadable journal aside: {e}");
                Failure::new("io", "The journal file could not be read or moved. Nothing was deleted.")
            })?;
            let journal = create(&path, key, brand)?;
            Ok(Opened {
                journal,
                set_aside: true,
                created: true,
            })
        }
        Err((LoadError::Other(e), _)) => {
            log::error!("could not load the journal: {e}");
            Err(Failure::new(
                "load_failed",
                format!("{} could not open its journal file ({e}). The file was left untouched.", brand.product_name),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brand::DOJIX;
    use crate::paths::{resolve, DataDirSource};
    use crate::vault::MemoryVault;

    fn scratch() -> (tempfile::TempDir, DataPaths) {
        let tmp = tempfile::tempdir().unwrap();
        let paths = resolve(&DOJIX, true, Some(&tmp.path().join("data")), None).unwrap();
        assert_eq!(paths.source, DataDirSource::Override);
        paths.ensure().unwrap();
        (tmp, paths)
    }

    #[test]
    fn first_launch_creates_a_key_and_a_journal_and_the_second_reopens_it() {
        let (_tmp, paths) = scratch();
        let vault = MemoryVault::default();
        let mut first = open_journal(&DOJIX, &paths, &vault).unwrap();
        assert!(first.created);
        first.journal.add_sample_trade().unwrap();
        drop(first);
        let second = open_journal(&DOJIX, &paths, &vault).unwrap();
        assert!(!second.created && !second.set_aside);
        assert_eq!(second.journal.recent(5).unwrap().len(), 1);
    }

    #[test]
    fn an_unreadable_vault_never_creates_a_key_or_a_journal() {
        let (_tmp, paths) = scratch();
        let vault = MemoryVault::default();
        vault.fail(DATABASE_KEY);
        let err = open_journal(&DOJIX, &paths, &vault).err().unwrap();
        assert_eq!(err.code, "vault_unavailable");
        assert!(!paths.journal().exists());
    }

    #[test]
    fn a_missing_key_leaves_an_existing_journal_untouched() {
        let (_tmp, paths) = scratch();
        let vault = MemoryVault::default();
        drop(open_journal(&DOJIX, &paths, &vault).unwrap());
        let before = fs::read(paths.journal()).unwrap();
        vault.delete(DATABASE_KEY).unwrap();
        let err = open_journal(&DOJIX, &paths, &vault).err().unwrap();
        assert_eq!(err.code, "key_missing");
        assert_eq!(fs::read(paths.journal()).unwrap(), before);
        assert!(matches!(vault.lookup(DATABASE_KEY), Lookup::Absent));
    }

    #[test]
    fn a_damaged_journal_is_set_aside_not_deleted() {
        let (_tmp, paths) = scratch();
        let vault = MemoryVault::default();
        drop(open_journal(&DOJIX, &paths, &vault).unwrap());
        fs::write(paths.journal(), b"damaged").unwrap();
        let opened = open_journal(&DOJIX, &paths, &vault).unwrap();
        assert!(opened.set_aside && opened.created);
        let aside: Vec<_> = fs::read_dir(paths.set_aside()).unwrap().collect();
        assert_eq!(aside.len(), 1);
        let kept = fs::read(aside[0].as_ref().unwrap().path()).unwrap();
        assert_eq!(kept, b"damaged");
    }

    #[test]
    fn a_key_of_the_wrong_length_fails_closed() {
        let (_tmp, paths) = scratch();
        let vault = MemoryVault::default();
        vault.write(DATABASE_KEY, &[1u8; 16]).unwrap();
        let err = open_journal(&DOJIX, &paths, &vault).err().unwrap();
        assert_eq!(err.code, "key_unreadable");
        assert!(!paths.journal().exists());
    }
}
