//! Journal store v0 (SPEC 6.3): an in-memory SQLite database, sealed to `journal.sealed`
//! after every committed write. No WAL, rollback journal or temp file ever reaches the disk.
//!
//! App Lock, the older-copy ledger and key rotation arrive in phase 1S; this store runs with
//! App Lock off (the bare key lives in the vault).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, MAIN_DB};
use rusqlite_migration::{Migrations, M};
use serde::Serialize;

use crate::fsec;
use crate::seal::{self, JournalKey, SealError, Stamp};

const MIGRATION_LIST: &[M<'static>] = &[M::up(include_str!("../migrations/0001_initial.sql"))];

/// Schema version after all migrations (the number of migrations).
pub const SCHEMA_VERSION: usize = MIGRATION_LIST.len();

pub fn migrations() -> Migrations<'static> {
    Migrations::from_slice(MIGRATION_LIST)
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("{0}")]
    Seal(#[from] SealError),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("the journal's schema ({found}) is newer than this app supports ({supported})")]
    TooNew { found: usize, supported: usize },
}

/// Why a journal file could not be loaded.
#[derive(Debug)]
pub enum LoadError {
    /// The file fails to decrypt or is not a database: it may be set aside.
    Unreadable(SealError),
    /// Anything else (I/O, permissions, a newer schema): the file must be left in place.
    Other(StoreError),
}

/// One row of the Journal list. Money stays decimal text, exactly as stored.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRow {
    pub id: i64,
    pub symbol: String,
    pub direction: String,
    pub close_time: String,
    pub net_profit: String,
}

pub struct Journal {
    conn: Connection,
    key: JournalKey,
    /// Stamp of the last durable save.
    stamp: Stamp,
    path: PathBuf,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Connection settings: everything in memory, foreign keys on.
fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "MEMORY")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

/// Some SQLite versions serialize a never-written database as 0 bytes; force page 1 to exist.
fn force_page_one(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE x(y); DROP TABLE x; VACUUM;")
}

fn new_memory_journal() -> Result<Connection, StoreError> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    force_page_one(&conn)?;
    migrations().to_latest(&mut conn)?;
    Ok(conn)
}

impl Journal {
    /// Creates a new, empty journal and saves it (generation 1 of a new epoch).
    pub fn create(path: &Path, key: JournalKey, brand: u8) -> Result<Self, StoreError> {
        let mut journal = Self {
            conn: new_memory_journal()?,
            key,
            stamp: Stamp::new_epoch(brand)?,
            path: path.to_path_buf(),
        };
        journal.save()?;
        Ok(journal)
    }

    /// Loads `journal.sealed`. On failure the key is handed back so the caller can decide.
    /// Before a migration, the sealed file as it was is copied into `snapshots`.
    pub fn load(
        path: &Path,
        key: JournalKey,
        brand: u8,
        snapshots: &Path,
    ) -> Result<Self, (LoadError, JournalKey)> {
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) => return Err((LoadError::Other(e.into()), key)),
        };
        let (stamp, image) = match seal::open(&key, brand, &bytes) {
            Ok(opened) => opened,
            Err(e @ (SealError::Decrypt | SealError::NotAJournal | SealError::NotADatabase)) => {
                return Err((LoadError::Unreadable(e), key))
            }
            Err(e) => return Err((LoadError::Other(e.into()), key)),
        };
        let (conn, migrated) =
            match Self::from_image(&image, &bytes, stamp, snapshots, &migrations()) {
                Ok(opened) => opened,
                Err(e) => return Err((LoadError::Other(e), key)),
            };
        let mut journal = Self {
            conn,
            key,
            stamp,
            path: path.to_path_buf(),
        };
        if migrated {
            if let Err(e) = journal.save() {
                return Err((LoadError::Other(e), journal.key));
            }
        }
        Ok(journal)
    }

    /// Deserializes and migrates. Returns the connection and whether a migration ran.
    /// A journal from an older schema is first copied, still sealed, into `snapshots`.
    fn from_image(
        image: &[u8],
        sealed: &[u8],
        stamp: Stamp,
        snapshots: &Path,
        ms: &Migrations<'_>,
    ) -> Result<(Connection, bool), StoreError> {
        let mut conn = Connection::open_in_memory()?;
        conn.deserialize_read_exact(MAIN_DB, image, image.len(), false)?;
        configure(&conn)?;
        let found = usize::from(ms.current_version(&conn)?);
        let pending = ms.pending_migrations(&conn)?;
        if pending < 0 {
            return Err(StoreError::TooNew {
                found,
                supported: found - pending.unsigned_abs() as usize,
            });
        }
        if pending == 0 {
            return Ok((conn, false));
        }
        if found > 0 {
            let name = format!("journal-pre-v{found}-g{}.sealed", stamp.generation);
            fsec::write_atomic(&snapshots.join(name), sealed)?;
        }
        ms.to_latest(&mut conn)?;
        Ok((conn, true))
    }

    /// Serializes, seals with the next generation and writes durably. The stamp advances only
    /// after the file is on stable storage.
    pub fn save(&mut self) -> Result<(), StoreError> {
        let next = Stamp {
            generation: self.stamp.generation + 1,
            saved_at_ms: now_ms(),
            ..self.stamp
        };
        let sealed = {
            let image = self.conn.serialize(MAIN_DB)?;
            seal::seal(&self.key, &next, &image)?
        };
        fsec::write_atomic(&self.path, &sealed)?;
        self.stamp = next;
        Ok(())
    }

    /// Runs `f` in one transaction, commits, then saves. A failed save leaves the change in
    /// memory and returns the error (the caller must surface it).
    pub fn write<T>(
        &mut self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<T>,
    ) -> Result<T, StoreError> {
        let tx = self.conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        self.save()?;
        Ok(out)
    }

    pub fn generation(&self) -> u64 {
        self.stamp.generation
    }

    pub fn schema_version(&self) -> Result<usize, StoreError> {
        Ok(usize::from(migrations().current_version(&self.conn)?))
    }

    /// The newest trades first.
    pub fn recent(&self, limit: u32) -> Result<Vec<JournalRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, symbol, direction, close_time, net_profit FROM trades \
             ORDER BY close_time DESC, id DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([limit], |r| {
                Ok(JournalRow {
                    id: r.get(0)?,
                    symbol: r.get(1)?,
                    direction: r.get(2)?,
                    close_time: r.get(3)?,
                    net_profit: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Adds one clearly fictional trade. Used by e2e builds and tests only.
    #[cfg(any(test, feature = "e2e"))]
    pub fn add_sample_trade(&mut self) -> Result<i64, StoreError> {
        self.write(|tx| {
            let ticket: i64 =
                tx.query_row("SELECT COALESCE(MAX(ticket), 0) + 1 FROM trades", [], |r| {
                    r.get(0)
                })?;
            tx.execute(
                "INSERT INTO trades (ticket, source, is_sample, symbol, direction, quantity, \
                 open_time, close_time, duration_min, open_price, close_price, net_profit, \
                 session, day_of_week, hour, imported_at, updated_at) \
                 VALUES (?1, 'sample', 1, 'TESTSYM', 'BUY', 1.0, \
                 '2026-01-05 09:00:00.000', '2026-01-05 10:30:00.000', 90, '1.1', '1.2', '12.5', \
                 'London', 'Monday', 9, '2026-01-05 11:00:00.000', '2026-01-05 11:00:00.000')",
                [ticket],
            )?;
            Ok(tx.last_insert_rowid())
        })
    }
}

/// `--self-test`: build a journal in memory, seal it, open it again and check the schema.
/// Never touches the user's journal.
pub fn seal_round_trip(brand: u8) -> Result<usize, StoreError> {
    let conn = new_memory_journal()?;
    let key = JournalKey::generate()?;
    let stamp = Stamp::new_epoch(brand)?;
    let sealed = {
        let image = conn.serialize(MAIN_DB)?;
        seal::seal(&key, &stamp, &image)?
    };
    let (_, image) = seal::open(&key, brand, &sealed)?;
    let mut copy = Connection::open_in_memory()?;
    copy.deserialize_read_exact(MAIN_DB, image.as_slice(), image.len(), false)?;
    let version = usize::from(migrations().current_version(&copy)?);
    let ok: String = copy.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if ok != "ok" {
        return Err(StoreError::Seal(SealError::NotADatabase));
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seal::SQLITE_MAGIC;

    fn key() -> JournalKey {
        JournalKey::from_bytes(&[3u8; 32]).unwrap()
    }

    fn contains_sqlite_magic(dir: &Path) -> bool {
        fs::read_dir(dir).unwrap().any(|e| {
            let path = e.unwrap().path();
            if path.is_dir() {
                return contains_sqlite_magic(&path);
            }
            let bytes = fs::read(&path).unwrap();
            bytes.windows(SQLITE_MAGIC.len()).any(|w| w == SQLITE_MAGIC)
        })
    }

    #[test]
    fn migrations_are_valid() {
        migrations().validate().unwrap();
        assert_eq!(SCHEMA_VERSION, 1);
    }

    #[test]
    fn an_empty_journal_still_serializes_page_one() {
        let conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        force_page_one(&conn).unwrap();
        let image = conn.serialize(MAIN_DB).unwrap();
        assert!(image.len() >= 512);
        assert_eq!(&image[..16], SQLITE_MAGIC);
    }

    #[test]
    fn create_add_reopen_persists_and_is_never_plaintext() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sealed");
        let snaps = tmp.path().join("snapshots");
        fs::create_dir(&snaps).unwrap();

        let mut j = Journal::create(&path, key(), 1).unwrap();
        assert_eq!(j.generation(), 1);
        assert!(j.recent(10).unwrap().is_empty());
        let id = j.add_sample_trade().unwrap();
        assert_eq!(j.generation(), 2);
        drop(j);

        assert!(!contains_sqlite_magic(tmp.path()), "plaintext SQLite found on disk");
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"DXJN");

        let j = Journal::load(&path, key(), 1, &snaps).map_err(|e| e.0).unwrap();
        let rows = j.recent(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);
        assert_eq!(rows[0].symbol, "TESTSYM");
        assert_eq!(rows[0].net_profit, "12.5");
        assert_eq!(j.generation(), 2);
        assert_eq!(j.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn wrong_key_or_garbage_is_unreadable_and_io_errors_are_not() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sealed");
        Journal::create(&path, key(), 1).unwrap();
        let other = JournalKey::from_bytes(&[4u8; 32]).unwrap();
        match Journal::load(&path, other, 1, tmp.path()) {
            Err((LoadError::Unreadable(SealError::Decrypt), _)) => {}
            _ => panic!("expected an unreadable journal"),
        }
        fs::write(&path, b"garbage").unwrap();
        assert!(matches!(
            Journal::load(&path, key(), 1, tmp.path()),
            Err((LoadError::Unreadable(SealError::NotAJournal), _))
        ));
        let missing = tmp.path().join("nope.sealed");
        assert!(matches!(
            Journal::load(&missing, key(), 1, tmp.path()),
            Err((LoadError::Other(StoreError::Io(_)), _))
        ));
    }

    #[test]
    fn a_newer_schema_is_refused_and_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sealed");
        let mut j = Journal::create(&path, key(), 1).unwrap();
        j.conn.pragma_update(None, "user_version", 99).unwrap();
        j.save().unwrap();
        drop(j);
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            Journal::load(&path, key(), 1, tmp.path()),
            Err((LoadError::Other(StoreError::TooNew { found: 99, .. }), _))
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn an_older_schema_is_snapshotted_then_migrated() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sealed");
        let snaps = tmp.path().join("snapshots");
        fs::create_dir(&snaps).unwrap();
        // A journal at schema 1, opened by a build that knows one more migration.
        Journal::create(&path, key(), 1).unwrap();
        let sealed = fs::read(&path).unwrap();
        let (stamp, image) = seal::open(&key(), 1, &sealed).unwrap();
        let later = [
            M::up(include_str!("../migrations/0001_initial.sql")),
            M::up("CREATE TABLE later_feature (id INTEGER PRIMARY KEY);"),
        ];
        let ms = Migrations::from_slice(&later);
        let (conn, migrated) = Journal::from_image(&image, &sealed, stamp, &snaps, &ms).unwrap();
        assert!(migrated);
        assert_eq!(usize::from(ms.current_version(&conn).unwrap()), 2);
        let snapshot = snaps.join("journal-pre-v1-g1.sealed");
        assert_eq!(fs::read(snapshot).unwrap(), sealed);

        // Already current: no snapshot, no migration.
        let (_, migrated) =
            Journal::from_image(&image, &sealed, stamp, &snaps, &migrations()).unwrap();
        assert!(!migrated);
    }

    #[test]
    fn self_test_round_trip_reports_the_schema() {
        assert_eq!(seal_round_trip(2).unwrap(), SCHEMA_VERSION);
    }
}
