//! The journal store (SPEC 6.3): an in-memory SQLite database, sealed to `journal.sealed`
//! after every committed write. No WAL, rollback journal or temp file ever reaches the disk.
//!
//! Every save is numbered (epoch + generation in the authenticated header) and recorded in the
//! vault's rollback record after the file is durable (SPEC 6.5). The journal is only ever
//! touched from the store thread (`session::Store`), the single writer.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, Transaction, MAIN_DB};
use rusqlite_migration::{Migrations, M};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::fsec;
use crate::ledger::{Ledger, SaveRecord};
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
    #[error("{0}")]
    Invalid(String),
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
    /// Stamp of the last durable save (or, after a new epoch whose save failed, of the next).
    stamp: Stamp,
    path: PathBuf,
    ledger: Option<Ledger>,
    /// The last save failed: the contents in memory are newer than the file.
    dirty: bool,
}

/// A journal opened from disk. `rekey_to` is set when the file opened only with the previous
/// key of a pending rotation: the caller re-seals it with that (current) key.
pub struct Loaded {
    pub journal: Journal,
    pub rekey_to: Option<JournalKey>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Connection settings: everything in memory, foreign keys on.
fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "MEMORY")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Deleted rows are overwritten in the image, so they don't linger in free pages.
    conn.pragma_update(None, "secure_delete", "ON")?;
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

/// Opens a SQLite image in a private in-memory connection.
pub fn memory_connection_from(image: &[u8], read_only: bool) -> Result<Connection, StoreError> {
    let mut conn = Connection::open_in_memory()?;
    conn.deserialize_read_exact(MAIN_DB, image, image.len(), read_only)?;
    configure(&conn)?;
    Ok(conn)
}

impl Journal {
    /// Creates a new, empty journal and saves it (generation 1 of a new epoch).
    pub fn create(
        path: &Path,
        key: JournalKey,
        brand: u8,
        ledger: Option<Ledger>,
    ) -> Result<Self, StoreError> {
        let mut journal = Self {
            conn: new_memory_journal()?,
            key,
            stamp: Stamp::new_epoch(brand)?,
            path: path.to_path_buf(),
            ledger,
            dirty: false,
        };
        journal.save()?;
        Ok(journal)
    }

    /// Opens sealed bytes read from `path` (the caller has already applied the rollback
    /// verdict). Tries the current key, then the previous one. On failure the current key is
    /// handed back. Before a migration, the sealed file as it was is copied to `snapshots`.
    pub fn open(
        path: &Path,
        bytes: &[u8],
        current: JournalKey,
        previous: Option<JournalKey>,
        brand: u8,
        snapshots: &Path,
        ledger: Option<Ledger>,
    ) -> Result<Loaded, (LoadError, JournalKey)> {
        let (key, rekey_to, stamp, image) = match seal::open(&current, brand, bytes) {
            Ok((stamp, image)) => (current, None, stamp, image),
            Err(SealError::Decrypt) => match previous {
                Some(prev) => match seal::open(&prev, brand, bytes) {
                    Ok((stamp, image)) => (prev, Some(current), stamp, image),
                    Err(e) => return Err((classify(e), current)),
                },
                None => return Err((LoadError::Unreadable(SealError::Decrypt), current)),
            },
            Err(e) => return Err((classify(e), current)),
        };
        let (conn, migrated) = match Self::from_image(&image, bytes, stamp, snapshots, &migrations())
        {
            Ok(opened) => opened,
            Err(e) => {
                let current = rekey_to.unwrap_or(key);
                return Err((LoadError::Other(e), current));
            }
        };
        let mut journal = Self {
            conn,
            key,
            stamp,
            path: path.to_path_buf(),
            ledger,
            dirty: false,
        };
        if migrated {
            if let Err(e) = journal.save() {
                let current = rekey_to.unwrap_or(journal.key);
                return Err((LoadError::Other(e), current));
            }
        }
        Ok(Loaded {
            journal,
            rekey_to,
        })
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
        let mut conn = memory_connection_from(image, false)?;
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
    /// after the file is on stable storage; the rollback record is written after that.
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
        if let Err(e) = fsec::write_atomic(&self.path, &sealed) {
            self.dirty = true;
            return Err(e.into());
        }
        self.stamp = next;
        self.dirty = false;
        if let Some(ledger) = &self.ledger {
            ledger.record(&SaveRecord::of(&next, &sealed));
        }
        Ok(())
    }

    /// Runs `f` in one transaction, commits, then saves. A failed save leaves the change in
    /// memory (`is_dirty`) and returns the error: the caller must surface it.
    pub fn write<T>(
        &mut self,
        f: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<T>,
    ) -> Result<T, StoreError> {
        let tx = self.conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        self.save()?;
        Ok(out)
    }

    /// Replaces the contents in one transaction and saves. If the transaction or the save
    /// fails, the previous contents go back into memory (SPEC 6.8 step 4).
    pub fn replace_with<T>(
        &mut self,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let before = self.image()?;
        let was_dirty = self.dirty;
        let tx = self.conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        if let Err(e) = self.save() {
            self.load_image(&before)?;
            self.dirty = was_dirty;
            return Err(e);
        }
        Ok(out)
    }

    fn load_image(&mut self, image: &[u8]) -> Result<(), StoreError> {
        self.conn
            .deserialize_read_exact(MAIN_DB, image, image.len(), false)?;
        configure(&self.conn)?;
        Ok(())
    }

    /// Re-seals the journal with `new` (a key rotation). On failure the old key stays in use
    /// and the file on disk is unchanged.
    pub fn rekey(&mut self, new: JournalKey) -> Result<(), StoreError> {
        let old = std::mem::replace(&mut self.key, new);
        let generation = self.stamp.generation;
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.key = old;
                debug_assert_eq!(generation, self.stamp.generation);
                Err(e)
            }
        }
    }

    /// Starts a new line of saves after the user chose to open an older copy: a fresh epoch,
    /// and a generation that never goes down (`at_least` + 1 is saved).
    pub fn start_new_epoch(&mut self, at_least: u64) -> Result<(), StoreError> {
        let fresh = Stamp::new_epoch(self.stamp.brand)?;
        self.stamp = Stamp {
            generation: at_least.max(self.stamp.generation),
            ..fresh
        };
        self.save()
    }

    /// A copy of the database image (for backups and restore rollback), wiped when dropped.
    pub fn image(&self) -> Result<Zeroizing<Vec<u8>>, StoreError> {
        Ok(Zeroizing::new(self.conn.serialize(MAIN_DB)?.to_vec()))
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn key(&self) -> &JournalKey {
        &self.key
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn generation(&self) -> u64 {
        self.stamp.generation
    }

    pub fn stamp(&self) -> Stamp {
        self.stamp
    }

    pub fn schema_version(&self) -> Result<usize, StoreError> {
        Ok(usize::from(migrations().current_version(&self.conn)?))
    }

    pub fn trade_count(&self) -> Result<i64, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM trades", [], |r| r.get(0))?)
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
                 'London', 'Mon', 9, '2026-01-05 11:00:00.000', '2026-01-05 11:00:00.000')",
                [ticket],
            )?;
            Ok(tx.last_insert_rowid())
        })
    }
}

fn classify(e: SealError) -> LoadError {
    match e {
        SealError::Decrypt | SealError::NotAJournal | SealError::NotADatabase => {
            LoadError::Unreadable(e)
        }
        other => LoadError::Other(StoreError::Seal(other)),
    }
}

/// Reads the journal file, if there is one.
pub fn read_file(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
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
    let copy = memory_connection_from(image.as_slice(), false)?;
    let version = usize::from(migrations().current_version(&copy)?);
    let ok: String = copy.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if ok != "ok" {
        return Err(StoreError::Seal(SealError::NotADatabase));
    }
    Ok(version)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::seal::SQLITE_MAGIC;

    fn key() -> JournalKey {
        JournalKey::from_bytes(&[3u8; 32]).unwrap()
    }

    pub(crate) fn contains_sqlite_magic(dir: &Path) -> bool {
        fs::read_dir(dir).unwrap().any(|e| {
            let path = e.unwrap().path();
            if path.is_dir() {
                return contains_sqlite_magic(&path);
            }
            let bytes = fs::read(&path).unwrap();
            bytes.windows(SQLITE_MAGIC.len()).any(|w| w == SQLITE_MAGIC)
        })
    }

    fn load(path: &Path, key: JournalKey, snaps: &Path) -> Result<Journal, LoadError> {
        let bytes = fs::read(path).map_err(|e| LoadError::Other(e.into()))?;
        Journal::open(path, &bytes, key, None, 1, snaps, None)
            .map(|l| l.journal)
            .map_err(|e| e.0)
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

        let mut j = Journal::create(&path, key(), 1, None).unwrap();
        assert_eq!(j.generation(), 1);
        assert!(j.recent(10).unwrap().is_empty());
        let id = j.add_sample_trade().unwrap();
        assert_eq!(j.generation(), 2);
        drop(j);

        assert!(
            !contains_sqlite_magic(tmp.path()),
            "plaintext SQLite found on disk"
        );
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"DXJN");

        let j = load(&path, key(), &snaps).unwrap();
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
        Journal::create(&path, key(), 1, None).unwrap();
        let other = JournalKey::from_bytes(&[4u8; 32]).unwrap();
        assert!(matches!(
            load(&path, other, tmp.path()),
            Err(LoadError::Unreadable(SealError::Decrypt))
        ));
        fs::write(&path, b"garbage").unwrap();
        assert!(matches!(
            load(&path, key(), tmp.path()),
            Err(LoadError::Unreadable(SealError::NotAJournal))
        ));
        let missing = tmp.path().join("nope.sealed");
        assert!(matches!(
            load(&missing, key(), tmp.path()),
            Err(LoadError::Other(StoreError::Io(_)))
        ));
    }

    #[test]
    fn a_file_sealed_with_the_previous_key_opens_and_asks_for_a_rekey() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sealed");
        let old = JournalKey::from_bytes(&[5u8; 32]).unwrap();
        let new = JournalKey::from_bytes(&[6u8; 32]).unwrap();
        let mut j = Journal::create(&path, old, 1, None).unwrap();
        j.add_sample_trade().unwrap();
        drop(j);
        let bytes = fs::read(&path).unwrap();
        let prev = JournalKey::from_bytes(&[5u8; 32]).unwrap();
        let loaded = Journal::open(&path, &bytes, new, Some(prev), 1, tmp.path(), None)
            .map_err(|e| e.0)
            .unwrap();
        let mut j = loaded.journal;
        let target = loaded.rekey_to.expect("opened with the previous key");
        assert!(target.same_as(&JournalKey::from_bytes(&[6u8; 32]).unwrap()));
        j.rekey(target).unwrap();
        drop(j);
        let new = JournalKey::from_bytes(&[6u8; 32]).unwrap();
        let j = load(&path, new, tmp.path()).unwrap();
        assert_eq!(j.trade_count().unwrap(), 1);
        assert_eq!(j.generation(), 3);
    }

    #[test]
    fn a_failed_save_keeps_the_change_in_memory_and_a_failed_rekey_keeps_the_old_key() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sealed");
        let mut j = Journal::create(&path, key(), 1, None).unwrap();
        let before = fs::read(&path).unwrap();
        // A folder where the file should be: every save fails (as on a full disk).
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(j.add_sample_trade().is_err());
        assert!(j.is_dirty());
        assert_eq!(j.trade_count().unwrap(), 1, "the change stays in memory");
        assert_eq!(j.generation(), 1, "the generation only counts durable saves");
        let new = JournalKey::from_bytes(&[9u8; 32]).unwrap();
        assert!(j.rekey(new).is_err());
        assert!(j.key().same_as(&key()));
        fs::remove_dir(&path).unwrap();
        fs::write(&path, &before).unwrap();
        j.save().unwrap();
        assert!(!j.is_dirty());
        drop(j);
        assert_eq!(load(&path, key(), tmp.path()).unwrap().trade_count().unwrap(), 1);
    }

    #[test]
    fn replace_with_rolls_back_in_memory_when_the_save_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sealed");
        let mut j = Journal::create(&path, key(), 1, None).unwrap();
        j.add_sample_trade().unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let result = j.replace_with(|tx| {
            tx.execute("DELETE FROM trades", [])?;
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(j.trade_count().unwrap(), 1, "previous contents restored");
        // A failing transaction changes nothing either.
        let result: Result<(), StoreError> = j.replace_with(|tx| {
            tx.execute("DELETE FROM trades", [])?;
            Err(StoreError::Invalid("refused".into()))
        });
        assert!(result.is_err());
        assert_eq!(j.trade_count().unwrap(), 1);
    }

    #[test]
    fn a_new_epoch_never_lowers_the_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sealed");
        let mut j = Journal::create(&path, key(), 1, None).unwrap();
        let epoch = j.stamp().epoch;
        j.start_new_epoch(41).unwrap();
        assert_ne!(j.stamp().epoch, epoch);
        assert_eq!(j.generation(), 42);
        let stamp = seal::read_stamp(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stamp.generation, 42);
        assert_eq!(stamp.epoch, j.stamp().epoch);
    }

    #[test]
    fn a_newer_schema_is_refused_and_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sealed");
        let mut j = Journal::create(&path, key(), 1, None).unwrap();
        j.conn.pragma_update(None, "user_version", 99).unwrap();
        j.save().unwrap();
        drop(j);
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            load(&path, key(), tmp.path()),
            Err(LoadError::Other(StoreError::TooNew { found: 99, .. }))
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
        Journal::create(&path, key(), 1, None).unwrap();
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
