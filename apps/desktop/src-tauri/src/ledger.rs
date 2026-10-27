//! Rollback (older-copy) protection (SPEC 6.5), the desktop counterpart of the Mac's
//! `SaveGenerationStore`: the last save this computer made is kept in the vault as
//!
//! ```text
//! v1:<epoch hex>:<generation>:<saved_at ms>:<sha256 hex of the sealed file>
//! ```
//!
//! A journal file that isn't that save, or a later one of the same epoch, is never opened
//! silently. A record that can't be read or written is logged and never fatal (Mac rule).

use std::sync::Arc;

use crate::crypto;
use crate::seal::{Stamp, EPOCH_LEN};
use crate::vault::{Lookup, SecretStore, SAVE_RECORD};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaveRecord {
    pub epoch: [u8; EPOCH_LEN],
    pub generation: u64,
    pub saved_at_ms: i64,
    pub hash: [u8; 32],
}

impl SaveRecord {
    pub fn of(stamp: &Stamp, sealed_file: &[u8]) -> Self {
        Self {
            epoch: stamp.epoch,
            generation: stamp.generation,
            saved_at_ms: stamp.saved_at_ms,
            hash: crypto::sha256(sealed_file),
        }
    }

    pub fn encode(&self) -> String {
        format!(
            "v1:{}:{}:{}:{}",
            crypto::hex(&self.epoch),
            self.generation,
            self.saved_at_ms,
            crypto::hex(&self.hash)
        )
    }

    pub fn decode(text: &str) -> Option<Self> {
        let parts: Vec<&str> = text.split(':').collect();
        if parts.len() != 5 || parts[0] != "v1" {
            return None;
        }
        let epoch: [u8; EPOCH_LEN] = crypto::from_hex(parts[1])?.try_into().ok()?;
        let generation = parts[2].parse::<u64>().ok()?;
        let saved_at_ms = parts[3].parse::<i64>().ok()?;
        let hash: [u8; 32] = crypto::from_hex(parts[4])?.try_into().ok()?;
        Some(Self {
            epoch,
            generation,
            saved_at_ms,
            hash,
        })
    }
}

/// What the load path does with a journal file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// No record, an unreadable record, the recorded save, or a later save of the same epoch.
    Accept,
    /// An older or other copy: refused until the user confirms (SPEC 6.5).
    Older { file: Stamp, record: SaveRecord },
}

/// The rollback rule: refuse a lower generation, another epoch, or the same generation with a
/// different SHA-256. A newer file in the same epoch opens (the last record write may have
/// failed).
pub fn verdict(file: &Stamp, sealed_file: &[u8], record: Option<&SaveRecord>) -> Verdict {
    let Some(record) = record else {
        return Verdict::Accept;
    };
    let older = file.epoch != record.epoch
        || file.generation < record.generation
        || (file.generation == record.generation
            && !crypto::ct_eq(&crypto::sha256(sealed_file), &record.hash));
    if older {
        Verdict::Older {
            file: *file,
            record: *record,
        }
    } else {
        Verdict::Accept
    }
}

/// The record in the vault.
#[derive(Clone)]
pub struct Ledger {
    store: Arc<dyn SecretStore>,
}

impl Ledger {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        Self { store }
    }

    /// The last save recorded. `None` when there is none, or when it can't be read or is
    /// damaged (logged): then any journal file is accepted, as on the Mac.
    pub fn last_saved(&self) -> Option<SaveRecord> {
        match self.store.lookup(SAVE_RECORD) {
            Lookup::Absent => None,
            Lookup::Failed(e) => {
                log::error!(
                    "could not read the last save record ({e}); accepting the journal file"
                );
                None
            }
            Lookup::Found(bytes) => {
                let record = std::str::from_utf8(&bytes)
                    .ok()
                    .and_then(SaveRecord::decode);
                if record.is_none() {
                    log::error!("the stored save record is damaged; ignoring it");
                }
                record
            }
        }
    }

    /// Records a save. A failure is logged and otherwise ignored.
    pub fn record(&self, record: &SaveRecord) -> bool {
        match self.store.write(SAVE_RECORD, record.encode().as_bytes()) {
            Ok(()) => true,
            Err(e) => {
                log::error!(
                    "could not record save generation {} ({e})",
                    record.generation
                );
                false
            }
        }
    }

    pub fn delete(&self) -> Result<(), String> {
        self.store.delete(SAVE_RECORD)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::MemoryVault;

    fn stamp(epoch: u8, generation: u64) -> Stamp {
        Stamp {
            brand: 1,
            epoch: [epoch; EPOCH_LEN],
            generation,
            saved_at_ms: 1_767_225_600_000,
        }
    }

    #[test]
    fn records_round_trip_and_damaged_ones_are_refused() {
        let r = SaveRecord::of(&stamp(1, 7), b"sealed bytes");
        let text = r.encode();
        assert!(text.starts_with("v1:01010101"));
        assert_eq!(SaveRecord::decode(&text), Some(r));
        let negative = text.replace(":7:", ":-7:");
        let short = text[..text.len() - 2].to_string();
        for bad in [
            "",
            "v2:00:1:2:00",
            "v1:zz:1:2:00",
            negative.as_str(),
            short.as_str(),
        ] {
            assert_eq!(SaveRecord::decode(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_rollback_rule() {
        let file = b"the file on disk";
        let rec = SaveRecord::of(&stamp(1, 5), file);
        // No record: accepted.
        assert_eq!(verdict(&stamp(1, 1), file, None), Verdict::Accept);
        // The recorded save itself.
        assert_eq!(verdict(&stamp(1, 5), file, Some(&rec)), Verdict::Accept);
        // A later save of the same epoch (the last record write failed).
        assert_eq!(verdict(&stamp(1, 6), b"newer", Some(&rec)), Verdict::Accept);
        // Older generation, other epoch, or same generation with another hash: refused.
        assert!(matches!(
            verdict(&stamp(1, 4), file, Some(&rec)),
            Verdict::Older { .. }
        ));
        assert!(matches!(
            verdict(&stamp(2, 9), file, Some(&rec)),
            Verdict::Older { .. }
        ));
        assert!(matches!(
            verdict(&stamp(1, 5), b"another file", Some(&rec)),
            Verdict::Older { .. }
        ));
    }

    #[test]
    fn unreadable_or_damaged_records_accept_and_failed_writes_are_not_fatal() {
        let store = Arc::new(MemoryVault::default());
        let ledger = Ledger::new(store.clone());
        assert_eq!(ledger.last_saved(), None);
        let rec = SaveRecord::of(&stamp(1, 2), b"x");
        assert!(ledger.record(&rec));
        assert_eq!(ledger.last_saved(), Some(rec));
        store.write(SAVE_RECORD, b"garbage").unwrap();
        assert_eq!(ledger.last_saved(), None);
        store.fail(SAVE_RECORD);
        assert_eq!(ledger.last_saved(), None);
        assert!(!ledger.record(&rec));
    }
}
