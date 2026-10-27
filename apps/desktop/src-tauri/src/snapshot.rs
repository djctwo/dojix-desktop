//! Automatic snapshots (SPEC 6.8): copies of the sealed journal, taken before each migration
//! and daily while the app is open; the newest 7 are kept. They are sealed with the journal
//! key, so a key rotation re-seals them, and they are restored only through the validated
//! restore pipeline, never renamed into place.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::fsec;
use crate::seal::{self, JournalKey, SealError};

pub const KEEP: usize = 7;

fn sealed_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file() && path.extension().is_some_and(|e| e == "sealed") {
            files.push(path);
        }
    }
    Ok(files)
}

/// Takes today's daily snapshot from the sealed journal on disk, unless one exists already.
/// `day` is `YYYY-MM-DD` (UTC). Returns true when a snapshot was written.
pub fn take_daily(dir: &Path, journal: &Path, day: &str, generation: u64) -> io::Result<bool> {
    let prefix = format!("daily-{day}-");
    let exists = sealed_files(dir)?.iter().any(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(&prefix))
    });
    if exists {
        return Ok(false);
    }
    let bytes = fs::read(journal)?;
    fsec::write_atomic(&dir.join(format!("{prefix}g{generation}.sealed")), &bytes)?;
    prune(dir, KEEP)?;
    Ok(true)
}

/// Keeps the `keep` newest snapshots (by modification time, then name).
pub fn prune(dir: &Path, keep: usize) -> io::Result<()> {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = sealed_files(dir)?
        .into_iter()
        .map(|p| {
            let modified = fs::metadata(&p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, p)
        })
        .collect();
    files.sort();
    let excess = files.len().saturating_sub(keep);
    for (_, path) in files.into_iter().take(excess) {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Re-seals every snapshot from `old` to `new`. Returns the files that may still need `old`
/// (could not be read or rewritten); a folder that can't be listed counts as not done.
/// Files that open with neither key are not ours to fix and are left alone (logged).
pub fn reseal(
    dir: &Path,
    brand: u8,
    old: &JournalKey,
    new: &JournalKey,
) -> Result<Vec<PathBuf>, io::Error> {
    let mut pending = Vec::new();
    for path in sealed_files(dir)? {
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                log::error!("could not read a snapshot to re-seal it: {e}");
                pending.push(path);
                continue;
            }
        };
        match seal::reseal(old, new, brand, &bytes) {
            Ok(moved) => {
                if let Err(e) = fsec::write_atomic(&path, &moved) {
                    log::error!("could not re-seal a snapshot: {e}");
                    pending.push(path);
                }
            }
            Err(SealError::Decrypt) if seal::open(new, brand, &bytes).is_ok() => {}
            Err(e) => log::warn!("a snapshot opens with neither key ({e}); left as it is"),
        }
    }
    Ok(pending)
}

/// Deletes every snapshot (erase).
pub fn delete_all(dir: &Path) -> io::Result<()> {
    for path in sealed_files(dir)? {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seal::{Stamp, SQLITE_MAGIC};

    fn sealed(key: &JournalKey, generation: u64) -> Vec<u8> {
        let mut stamp = Stamp::new_epoch(1).unwrap();
        stamp.generation = generation;
        let mut image = SQLITE_MAGIC.to_vec();
        image.extend_from_slice(b"fictional");
        seal::seal(key, &stamp, &image).unwrap()
    }

    #[test]
    fn one_daily_snapshot_per_day_and_only_seven_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("snapshots");
        fs::create_dir(&dir).unwrap();
        let journal = tmp.path().join("journal.sealed");
        let key = JournalKey::generate().unwrap();
        fs::write(&journal, sealed(&key, 3)).unwrap();
        assert!(take_daily(&dir, &journal, "2026-01-05", 3).unwrap());
        assert!(!take_daily(&dir, &journal, "2026-01-05", 4).unwrap());
        for day in 6..=15 {
            take_daily(&dir, &journal, &format!("2026-01-{day:02}"), 5).unwrap();
        }
        assert_eq!(sealed_files(&dir).unwrap().len(), KEEP);
        assert_eq!(
            fs::read(dir.join("daily-2026-01-15-g5.sealed")).unwrap(),
            fs::read(&journal).unwrap()
        );
    }

    #[test]
    fn reseal_moves_every_snapshot_to_the_new_key() {
        let tmp = tempfile::tempdir().unwrap();
        let old = JournalKey::generate().unwrap();
        let new = JournalKey::generate().unwrap();
        let stranger = JournalKey::generate().unwrap();
        fs::write(tmp.path().join("a.sealed"), sealed(&old, 1)).unwrap();
        fs::write(tmp.path().join("b.sealed"), sealed(&new, 2)).unwrap();
        fs::write(tmp.path().join("c.sealed"), sealed(&stranger, 3)).unwrap();
        let pending = reseal(tmp.path(), 1, &old, &new).unwrap();
        assert!(pending.is_empty());
        for name in ["a.sealed", "b.sealed"] {
            let bytes = fs::read(tmp.path().join(name)).unwrap();
            assert!(seal::open(&new, 1, &bytes).is_ok(), "{name}");
        }
        // Not ours: untouched.
        let c = fs::read(tmp.path().join("c.sealed")).unwrap();
        assert!(seal::open(&stranger, 1, &c).is_ok());
    }

    #[test]
    fn a_folder_that_cannot_be_listed_is_not_done() {
        let tmp = tempfile::tempdir().unwrap();
        let old = JournalKey::generate().unwrap();
        let new = JournalKey::generate().unwrap();
        assert!(reseal(&tmp.path().join("missing"), 1, &old, &new).is_err());
    }
}
