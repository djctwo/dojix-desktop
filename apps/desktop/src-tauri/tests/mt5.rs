//! MT5 auto-import (SPEC 5.4) on synthetic MetaTrader trees: discovery (Windows layout and
//! Wine prefixes), the watcher (created, rewritten in place, partly written, growing, locked,
//! deleted, touched, other CSVs, folders created later), the read-only guarantees (a deny-write
//! folder; the whole tree hashed before and after) and the journal commit.
//! All names and trades are fictional.
#![cfg(feature = "brand-dojix")]

mod common;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use common::*;
use dojix_desktop_lib::journal::Journal;
use dojix_desktop_lib::mt5::discover::{self, Kind, Roots};
use dojix_desktop_lib::mt5::watch::{self, FileState, FolderState, TakeError, Timing};
use dojix_desktop_lib::mt5::{ro, Config, Service, Status};
use dojix_desktop_lib::mt5_journal::{self, Outcome};
use dojix_desktop_lib::seal::JournalKey;

// ------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------

fn journal(dir: &Path) -> Journal {
    let key = JournalKey::from_bytes(&[7u8; 32]).unwrap();
    Journal::create(&dir.join("journal.sealed"), key, 1, None).unwrap()
}

fn count(j: &Journal, sql: &str) -> i64 {
    j.conn().query_row(sql, [], |r| r.get(0)).unwrap()
}

fn config_for(folders: &[&Path]) -> Config {
    Config {
        enabled: folders
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        ..Config::default()
    }
}

struct Harness {
    service: Service,
    sink: Arc<CountSink>,
    config: Config,
}

impl Harness {
    fn start(folders: &[&Path], timing: Timing) -> Self {
        Self::start_with(config_for(folders), timing, HashMap::new())
    }

    fn start_with(
        config: Config,
        timing: Timing,
        ledger: HashMap<PathBuf, watch::LedgerEntry>,
    ) -> Self {
        let sink = Arc::new(CountSink::default());
        let service = Service::new(sink.clone(), Roots::default(), timing);
        service.reconcile(&config, move || ledger).unwrap();
        Self {
            service,
            sink,
            config,
        }
    }

    fn status(&self) -> Status {
        self.service.status(&self.config)
    }

    fn state_of(&self, name: &str) -> Option<FileState> {
        self.status()
            .watch
            .files
            .iter()
            .find(|f| f.file_name == name)
            .map(|f| f.state)
    }

    fn wait_state(&self, name: &str, state: FileState) {
        wait_until(&format!("{name} to be {state:?}"), WAIT, || {
            self.state_of(name) == Some(state)
        });
    }

    fn pending_token(&self, name: &str) -> Option<u64> {
        self.status()
            .watch
            .pending
            .iter()
            .find(|p| p.file_name == name)
            .map(|p| p.token)
    }

    fn wait_pending(&self, name: &str) -> u64 {
        let mut token = None;
        wait_until(&format!("{name} to be queued"), WAIT, || {
            token = self.pending_token(name);
            token.is_some()
        });
        token.unwrap()
    }

    /// Reads the queued file, commits `outcome` into `j`, and marks it handled.
    fn commit(&self, j: &mut Journal, token: u64, outcome: Outcome) {
        let (file, _bytes) = self.service.read(token).unwrap();
        let prepared = mt5_journal::prepare(outcome).unwrap();
        let summary = mt5_journal::apply(j, &file, prepared, 0).unwrap();
        self.service.finish(token, summary);
    }
}

fn sample_outcome() -> Outcome {
    serde_json::from_str(OUTCOME_JSON).unwrap()
}

/// The sample's outcome plus one more trade (ticket 500004), as after a rewrite.
fn grown_outcome() -> Outcome {
    let mut value: serde_json::Value = serde_json::from_str(OUTCOME_JSON).unwrap();
    let mut extra = value["trades"][0].clone();
    extra["ticket"] = "500004".into();
    value["trades"].as_array_mut().unwrap().push(extra);
    value["parsed"] = 4.into();
    serde_json::from_value(value).unwrap()
}

fn grown_sample() -> Vec<u8> {
    let text = String::from_utf8(SAMPLE.to_vec()).unwrap();
    let last = text.trim_end().lines().last().unwrap().to_string();
    format!("{text}{}\r\n", last.replacen("500003", "500004", 1)).into_bytes()
}

// ------------------------------------------------------------------------------------------
// Discovery
// ------------------------------------------------------------------------------------------

#[test]
fn discovers_common_terminals_and_portable_installs_with_origin_labels() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let roots = Roots {
        appdata: vec![tree.appdata.clone()],
        program_files: vec![tree.program_files.clone()],
        wine_prefixes: vec![],
    };
    let found = discover::discover(&roots);
    let summary: Vec<(Kind, String, PathBuf, bool)> = found
        .iter()
        .map(|l| (l.kind, l.label.clone(), PathBuf::from(&l.path), l.exists))
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                Kind::Common,
                "All terminals (Common\\Files)".to_string(),
                tree.common_files.clone(),
                true
            ),
            (
                Kind::Terminal,
                "Fictional Markets MT5".to_string(),
                tree.terminal_a_files.clone(),
                true
            ),
            (
                Kind::Terminal,
                "Terminal FEDCBA98".to_string(),
                tree.terminal_b_files.clone(),
                true
            ),
            (
                Kind::Portable,
                "Fictional Portable MT5 (install folder)".to_string(),
                tree.portable_files.clone(),
                true
            ),
        ]
    );
    let a = &found[1];
    assert_eq!(a.terminal_id.as_deref(), Some(TERMINAL_A));
    assert_eq!(
        a.install_path.as_deref(),
        Some("C:\\Program Files\\Fictional Markets MT5")
    );
    assert!(a.wine_prefix.is_none());
    // Ids are stable, distinct, and derived from the path.
    let again = discover::discover(&roots);
    assert_eq!(found, again);
    let mut ids: Vec<&str> = found.iter().map(|l| l.id.as_str()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), found.len());
    assert_eq!(a.id, discover::location_id(&tree.terminal_a_files));
    assert_eq!(a.id.len(), 16);
}

#[test]
fn a_missing_common_folder_is_listed_as_not_existing_yet() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    fs::remove_dir_all(&tree.common_files).unwrap();
    let found = discover::discover(&Roots {
        appdata: vec![tree.appdata.clone()],
        ..Roots::default()
    });
    assert_eq!(found[0].kind, Kind::Common);
    assert!(!found[0].exists);
}

#[test]
fn nothing_is_found_without_metatrader() {
    let tmp = tempfile::tempdir().unwrap();
    let roots = Roots {
        appdata: vec![tmp.path().join("nope")],
        program_files: vec![tmp.path().to_path_buf()],
        wine_prefixes: vec![tmp.path().join("no-prefix"), tmp.path().to_path_buf()],
    };
    assert!(discover::discover(&roots).is_empty());
    // The real roots never panic (they may or may not exist on the CI machine).
    let _ = discover::discover(&Roots::system());
}

#[test]
fn origin_txt_is_decoded_in_every_encoding_mt5_and_editors_use() {
    let path = "C:\\Program Files\\Fictional Markets MT5";
    assert_eq!(
        discover::decode_origin(&utf16le_bom(path)).as_deref(),
        Some(path)
    );
    // With a trailing CRLF and NULs.
    let mut padded = utf16le_bom(&format!("{path}\r\n"));
    padded.extend_from_slice(&[0, 0]);
    assert_eq!(discover::decode_origin(&padded).as_deref(), Some(path));
    // BOM-less UTF-16LE.
    let bare: Vec<u8> = path.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    assert_eq!(discover::decode_origin(&bare).as_deref(), Some(path));
    // UTF-16BE with a BOM.
    let mut be = vec![0xFE, 0xFF];
    be.extend(path.encode_utf16().flat_map(|u| u.to_be_bytes()));
    assert_eq!(discover::decode_origin(&be).as_deref(), Some(path));
    // UTF-8, with and without a BOM.
    assert_eq!(
        discover::decode_origin(path.as_bytes()).as_deref(),
        Some(path)
    );
    let mut bom8 = vec![0xEF, 0xBB, 0xBF];
    bom8.extend_from_slice(path.as_bytes());
    assert_eq!(discover::decode_origin(&bom8).as_deref(), Some(path));
    // Empty, blank and binary.
    assert_eq!(discover::decode_origin(b""), None);
    assert_eq!(discover::decode_origin(&utf16le_bom("  \r\n")), None);
    assert_eq!(discover::decode_origin(&[0x01, 0x02, 0x03]), None);

    assert_eq!(discover::install_label(path), "Fictional Markets MT5");
    assert_eq!(
        discover::install_label("/opt/Fictional MT5/"),
        "Fictional MT5"
    );
    assert_eq!(discover::install_label("Fictional"), "Fictional");
    assert!(discover::is_terminal_id(TERMINAL_A));
    assert!(!discover::is_terminal_id("Common"));
    assert!(!discover::is_terminal_id("0123456789ABCDEF0123456789ABCDEZ"));
}

#[test]
fn wine_prefixes_are_searched_like_appdata() {
    let tmp = tempfile::tempdir().unwrap();
    // Current Wine: users/<name>/AppData/Roaming; and a portable install in Program Files.
    let modern = tmp.path().join(".mt5");
    let roaming = modern
        .join("drive_c")
        .join("users")
        .join("fictional")
        .join("AppData")
        .join("Roaming");
    let terminal = roaming.join("MetaQuotes").join("Terminal");
    mkdirs(&terminal.join("Common").join("Files"));
    mkdirs(&terminal.join(TERMINAL_A).join("MQL5").join("Files"));
    fs::write(
        terminal.join(TERMINAL_A).join("origin.txt"),
        utf16le_bom("C:\\Program Files\\MetaTrader 5"),
    )
    .unwrap();
    // The Public profile is never searched.
    let public = modern
        .join("drive_c")
        .join("users")
        .join("Public")
        .join("AppData")
        .join("Roaming")
        .join("MetaQuotes")
        .join("Terminal");
    mkdirs(&public.join("Common").join("Files"));
    let install = modern
        .join("drive_c")
        .join("Program Files")
        .join("MetaTrader 5");
    mkdirs(&install.join("MQL5").join("Files"));
    fs::write(install.join("terminal64.exe"), b"fictional").unwrap();
    // Older Wine: users/<name>/Application Data.
    let older = tmp.path().join(".wine");
    let old_terminal = older
        .join("drive_c")
        .join("users")
        .join("fictional")
        .join("Application Data")
        .join("MetaQuotes")
        .join("Terminal");
    mkdirs(&old_terminal.join("Common").join("Files"));

    let found = discover::discover(&Roots {
        wine_prefixes: vec![modern.clone(), older.clone(), tmp.path().join(".none")],
        ..Roots::default()
    });
    let summary: Vec<(Kind, String, Option<String>)> = found
        .iter()
        .map(|l| (l.kind, l.label.clone(), l.wine_prefix.clone()))
        .collect();
    let m = Some(modern.to_string_lossy().into_owned());
    let o = Some(older.to_string_lossy().into_owned());
    assert_eq!(
        summary,
        vec![
            (Kind::Common, "All terminals (Common\\Files)".into(), m.clone()),
            (Kind::Terminal, "MetaTrader 5".into(), m.clone()),
            (Kind::Portable, "MetaTrader 5 (install folder)".into(), m),
            (Kind::Common, "All terminals (Common\\Files)".into(), o),
        ]
    );
    assert!(found
        .iter()
        .all(|l| !l.path.contains("Public") && l.exists));
}

#[cfg(unix)]
#[test]
fn links_inside_watched_folders_are_never_followed() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let outside = tmp.path().join("outside");
    mkdirs(&outside);
    fs::write(outside.join("DojixExport_1_20261028.csv"), SAMPLE).unwrap();
    std::os::unix::fs::symlink(
        outside.join("DojixExport_1_20261028.csv"),
        tree.common_files.join("DojixExport_2_20261028.csv"),
    )
    .unwrap();
    std::os::unix::fs::symlink(&outside, tree.common_files.join("linked-dir")).unwrap();
    fs::write(tree.common_files.join(SAMPLE_NAME), SAMPLE).unwrap();

    let names: Vec<String> = ro::list_files(&tree.common_files)
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names, vec![SAMPLE_NAME.to_string()]);
    assert!(ro::list_dirs(&tree.common_files).unwrap().is_empty());
    let link = tree.common_files.join("DojixExport_2_20261028.csv");
    assert_eq!(ro::stat(&link), Err(ro::ReadError::NotAFile));
    assert_eq!(
        ro::read(&link, ro::MAX_READ_BYTES).map(|_| ()),
        Err(ro::ReadError::NotAFile)
    );
}

#[test]
fn reads_are_capped_and_classified() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("DojixExport_1_20261028.csv");
    fs::write(&path, SAMPLE).unwrap();
    let (bytes, stat) = ro::read(&path, ro::MAX_READ_BYTES).unwrap();
    assert_eq!(bytes, SAMPLE);
    assert_eq!(stat, ro::stat(&path).unwrap());
    assert_eq!(stat.size, SAMPLE.len() as u64);
    assert_eq!(
        ro::read(&path, 10).map(|_| ()),
        Err(ro::ReadError::TooLarge)
    );
    assert_eq!(
        ro::read(&tmp.path().join("gone.csv"), 10).map(|_| ()),
        Err(ro::ReadError::Gone)
    );
    assert_eq!(ro::stat(tmp.path()), Err(ro::ReadError::NotAFile));
    assert!(ro::is_file(&path));
    assert!(!ro::is_file(tmp.path()));
}

#[test]
fn file_names_are_classified_by_pattern() {
    use watch::{file_kind, FileKind};
    assert_eq!(file_kind(SAMPLE_NAME, ""), Some(FileKind::Trade));
    assert_eq!(
        file_kind("dojixexport_1_20261028.CSV", ""),
        Some(FileKind::Trade)
    );
    assert_eq!(file_kind("Fictional32_20261028.csv", ""), Some(FileKind::OtherCsv));
    assert_eq!(
        file_kind("Fictional32_20261028.csv", "Fictional32_"),
        Some(FileKind::Trade)
    );
    assert_eq!(file_kind("DojixPrices.json", ""), None);
    assert_eq!(file_kind("DojixExport_1.csv.tmp", ""), None);
    assert_eq!(file_kind("é.csv", "éé"), Some(FileKind::OtherCsv));
}

// ------------------------------------------------------------------------------------------
// Watcher
// ------------------------------------------------------------------------------------------

#[test]
fn a_new_file_is_queued_committed_and_never_imported_twice() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let data = tempfile::tempdir().unwrap();
    let mut j = journal(data.path());
    let h = Harness::start(&[&tree.common_files], fast());
    let status = h.status();
    assert!(status.active);
    assert_eq!(status.watch.folders.len(), 1);

    fs::write(tree.common_files.join(SAMPLE_NAME), SAMPLE).unwrap();
    let token = h.wait_pending(SAMPLE_NAME);
    assert!(h.sink.0.load(Ordering::SeqCst) >= 1);
    let (_, bytes) = h.service.read(token).unwrap();
    assert_eq!(bytes, SAMPLE);
    h.commit(&mut j, token, sample_outcome());
    h.wait_state(SAMPLE_NAME, FileState::Imported);
    let last = h.status().last_import.unwrap();
    assert_eq!(
        (last.result.as_str(), last.inserted, last.duplicates),
        ("imported", 3, 0)
    );
    assert_eq!(count(&j, "SELECT COUNT(*) FROM trades"), 3);
    assert_eq!(
        count(
            &j,
            "SELECT COUNT(*) FROM import_batches WHERE origin = 'mt5_watch' \
             AND source = 'dojix_export' AND inserted = 3"
        ),
        1
    );
    assert_eq!(count(&j, "SELECT COUNT(*) FROM watched_files"), 1);
    // A finished token is gone.
    assert_eq!(h.service.read(token).map(|_| ()), Err(TakeError::Unknown));

    // Several polls later nothing is queued again.
    std::thread::sleep(Duration::from_millis(1200));
    assert!(h.status().watch.pending.is_empty());
    drop(h);

    // A new run with the journal's ledger doesn't queue it either.
    let ledger = mt5_journal::read_ledger(j.conn()).unwrap();
    assert_eq!(ledger.len(), 1);
    let h2 = Harness::start_with(config_for(&[&tree.common_files]), fast(), ledger);
    h2.wait_state(SAMPLE_NAME, FileState::Imported);
    std::thread::sleep(Duration::from_millis(1200));
    assert!(h2.status().watch.pending.is_empty());
}

#[test]
fn a_file_rewritten_in_place_is_queued_again_and_old_rows_are_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let data = tempfile::tempdir().unwrap();
    let mut j = journal(data.path());
    let path = tree.terminal_a_files.join(SAMPLE_NAME);
    fs::write(&path, SAMPLE).unwrap();
    let h = Harness::start(&[&tree.terminal_a_files], fast());
    let token = h.wait_pending(SAMPLE_NAME);
    h.commit(&mut j, token, sample_outcome());
    h.wait_state(SAMPLE_NAME, FileState::Imported);

    rewrite(&path, &grown_sample());
    let token = h.wait_pending(SAMPLE_NAME);
    let (_, bytes) = h.service.read(token).unwrap();
    assert_eq!(bytes, grown_sample());
    h.commit(&mut j, token, grown_outcome());
    let last = h.status().last_import.unwrap();
    assert_eq!((last.inserted, last.duplicates), (1, 3));
    assert_eq!(count(&j, "SELECT COUNT(*) FROM trades"), 4);
    assert_eq!(count(&j, "SELECT COUNT(*) FROM import_batches"), 2);
    assert_eq!(count(&j, "SELECT COUNT(*) FROM watched_files"), 1);
}

#[test]
fn a_touched_file_with_the_same_bytes_is_not_imported_again() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let data = tempfile::tempdir().unwrap();
    let mut j = journal(data.path());
    let path = tree.common_files.join(SAMPLE_NAME);
    fs::write(&path, SAMPLE).unwrap();
    let h = Harness::start(&[&tree.common_files], fast());
    let token = h.wait_pending(SAMPLE_NAME);
    h.commit(&mut j, token, sample_outcome());
    touch_later(&path, 120);
    h.wait_state(SAMPLE_NAME, FileState::Unchanged);
    assert!(h.status().watch.pending.is_empty());
}

#[test]
fn an_unfinished_last_line_waits_until_it_is_finished() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let slow_partial = Timing {
        partial_passes: 1000,
        ..fast()
    };
    let h = Harness::start(&[&tree.common_files], slow_partial);
    let path = tree.common_files.join(SAMPLE_NAME);
    let cut = &SAMPLE[..SAMPLE.len() - 40];
    fs::write(&path, cut).unwrap();
    h.wait_state(SAMPLE_NAME, FileState::Partial);
    std::thread::sleep(Duration::from_millis(1500));
    assert!(h.pending_token(SAMPLE_NAME).is_none());
    rewrite(&path, SAMPLE);
    let token = h.wait_pending(SAMPLE_NAME);
    assert_eq!(h.service.read(token).unwrap().1, SAMPLE);
}

#[test]
fn an_unfinished_line_that_never_changes_is_imported_after_two_polls() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let path = tree.common_files.join(SAMPLE_NAME);
    let no_newline = &SAMPLE[..SAMPLE.len() - 2];
    fs::write(&path, no_newline).unwrap();
    let h = Harness::start(&[&tree.common_files], fast());
    let token = h.wait_pending(SAMPLE_NAME);
    assert_eq!(h.service.read(token).unwrap().1, no_newline);
}

#[test]
fn a_file_still_being_written_is_read_only_once_it_is_stable() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    // The app's own stability window (1 s) against a writer adding a chunk every 60 ms.
    let timing = Timing {
        debounce: Duration::from_secs(1),
        stable_gap: Duration::from_secs(1),
        ..fast()
    };
    let h = Harness::start(&[&tree.common_files], timing);
    let path = tree.common_files.join(SAMPLE_NAME);
    let writer_path = path.clone();
    let writer = std::thread::spawn(move || {
        use std::io::Write;
        let mut file = fs::File::create(&writer_path).unwrap();
        for chunk in SAMPLE.chunks(16) {
            file.write_all(chunk).unwrap();
            file.flush().unwrap();
            std::thread::sleep(Duration::from_millis(60));
        }
    });
    // While the writer runs, nothing is queued with partial bytes.
    while !writer.is_finished() {
        let status = h.status();
        if let Some(p) = status.watch.pending.iter().find(|p| p.file_name == SAMPLE_NAME) {
            assert_eq!(
                p.size,
                SAMPLE.len() as u64,
                "a partly written file was queued"
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    writer.join().unwrap();
    let token = h.wait_pending(SAMPLE_NAME);
    assert_eq!(h.service.read(token).unwrap().1, SAMPLE);
}

#[test]
fn a_deleted_file_leaves_the_queue() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let path = tree.common_files.join(SAMPLE_NAME);
    fs::write(&path, SAMPLE).unwrap();
    let h = Harness::start(&[&tree.common_files], fast());
    let token = h.wait_pending(SAMPLE_NAME);
    fs::remove_file(&path).unwrap();
    // Whichever comes first: the folder event / poll, or a read of the queued file.
    match h.service.read(token) {
        Err(TakeError::Gone) | Err(TakeError::Unknown) => {}
        other => panic!("expected the file to be gone, got {:?}", other.map(|_| ())),
    }
    h.wait_state(SAMPLE_NAME, FileState::Deleted);
    assert!(h.status().watch.pending.is_empty());
}

#[test]
fn a_file_changed_after_it_was_queued_is_read_again() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let path = tree.common_files.join(SAMPLE_NAME);
    fs::write(&path, SAMPLE).unwrap();
    // Slow events and polls, so the change is seen by the read, not by the watcher.
    let slow = Timing {
        debounce: Duration::from_secs(30),
        poll: Duration::from_secs(30),
        ..fast()
    };
    let h = Harness::start(&[&tree.common_files], slow);
    let token = h.wait_pending(SAMPLE_NAME);
    rewrite(&path, &grown_sample());
    // Let the folder events arrive first (they only schedule a look 30 s out).
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        h.service.read(token).map(|_| ()),
        Err(TakeError::Changed)
    );
    assert!(h.pending_token(SAMPLE_NAME).is_none());
    // It is looked at again right away (no waiting for the poll).
    let again = h.wait_pending(SAMPLE_NAME);
    assert_ne!(again, token);
    assert_eq!(h.service.read(again).unwrap().1, grown_sample());
}

#[cfg(windows)]
#[test]
fn a_file_held_without_sharing_is_retried_until_released() {
    use std::os::windows::fs::OpenOptionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    let path = tree.common_files.join(SAMPLE_NAME);
    fs::write(&path, SAMPLE).unwrap();
    // Another program holds the file open with no sharing at all.
    let held = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    assert_eq!(
        ro::read(&path, ro::MAX_READ_BYTES).map(|_| ()),
        Err(ro::ReadError::Busy)
    );
    let h = Harness::start(&[&tree.common_files], fast());
    h.wait_state(SAMPLE_NAME, FileState::Busy);
    std::thread::sleep(Duration::from_millis(800));
    assert!(h.pending_token(SAMPLE_NAME).is_none());
    drop(held);
    let token = h.wait_pending(SAMPLE_NAME);
    assert_eq!(h.service.read(token).unwrap().1, SAMPLE);
}

#[cfg(windows)]
#[test]
fn reading_never_locks_mt5_out() {
    use std::io::Write;
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join(SAMPLE_NAME);
    fs::write(&path, SAMPLE).unwrap();
    // While the watcher's handle is open, MT5 can still rewrite and delete the file: the
    // read handle shares read, write and delete. Check through a second reader thread.
    let reader_path = path.clone();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_reader = stop.clone();
    let reader = std::thread::spawn(move || {
        while !stop_reader.load(Ordering::SeqCst) {
            let _ = ro::read(&reader_path, ro::MAX_READ_BYTES);
        }
    });
    for _ in 0..50 {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .expect("MT5 could not open the file for writing while it was being read");
        f.write_all(SAMPLE).unwrap();
    }
    stop.store(true, Ordering::SeqCst);
    reader.join().unwrap();
    fs::remove_file(&path).unwrap();
}

#[test]
fn other_csv_files_are_listed_once_and_never_read() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    fs::write(tree.common_files.join("Fictional32_20261028.csv"), b"a,b\r\n").unwrap();
    fs::write(tree.common_files.join("DojixPrices.json"), b"{}").unwrap();
    let h = Harness::start(&[&tree.common_files], fast());
    h.wait_state("Fictional32_20261028.csv", FileState::NotTradeFile);
    std::thread::sleep(Duration::from_millis(900));
    let status = h.status();
    assert!(status.watch.pending.is_empty());
    assert!(status
        .watch
        .files
        .iter()
        .all(|f| f.file_name != "DojixPrices.json"));
    drop(h);

    // With the 32-column prefix set, the same file is a trade file.
    let config = Config {
        prefix32: Some("Fictional32_".into()),
        ..config_for(&[&tree.common_files])
    };
    let h = Harness::start_with(config, fast(), HashMap::new());
    h.wait_pending("Fictional32_20261028.csv");
}

#[test]
fn a_folder_created_after_start_is_picked_up() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    fs::remove_dir_all(&tree.common_files).unwrap();
    let h = Harness::start(&[&tree.common_files], fast());
    wait_until("the folder to be missing", WAIT, || {
        h.status().watch.folders[0].state == FolderState::Missing
    });
    mkdirs(&tree.common_files);
    fs::write(tree.common_files.join(SAMPLE_NAME), SAMPLE).unwrap();
    h.wait_pending(SAMPLE_NAME);
    wait_until("folder events", WAIT, || {
        h.status().watch.folders[0].state == FolderState::Watching
    });
}

#[test]
fn several_folders_and_restarts_follow_the_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    fs::write(tree.common_files.join(SAMPLE_NAME), SAMPLE).unwrap();
    fs::write(tree.terminal_b_files.join("DojixExport_2_20261028.csv"), SAMPLE).unwrap();
    let sink = Arc::new(CountSink::default());
    let service = Service::new(sink, Roots::default(), fast());
    let both = config_for(&[&tree.common_files, &tree.terminal_b_files]);
    assert!(!service.matches(&both));
    service.reconcile(&both, HashMap::new).unwrap();
    assert!(service.matches(&both) && service.is_running());
    wait_until("both files queued", WAIT, || {
        service.status(&both).watch.pending.len() == 2
    });
    // Unchanged settings keep the running watcher (and its queue).
    service
        .reconcile(&both, || panic!("the ledger is read only on a restart"))
        .unwrap();
    assert_eq!(service.status(&both).watch.pending.len(), 2);
    // Locking stops everything; nothing is read while locked.
    service.suspend();
    assert!(!service.is_running());
    let paused = service.status(&both);
    assert!(!paused.active && paused.watch.pending.is_empty());
    assert_eq!(service.read(1).map(|_| ()), Err(TakeError::Unknown));
    // Off.
    service.reconcile(&Config::default(), HashMap::new).unwrap();
    assert!(!service.is_running());
    assert!(service.matches(&Config::default()));
}

#[test]
fn settings_list_found_custom_and_orphaned_folders_with_previews() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = windows_tree(tmp.path());
    fs::write(tree.common_files.join(SAMPLE_NAME), SAMPLE).unwrap();
    fs::write(tree.common_files.join("notes.csv"), b"x\r\n").unwrap();
    fs::write(tree.common_files.join("DojixPrices.json"), b"{}").unwrap();
    let custom = tmp.path().join("My exports");
    mkdirs(&custom);
    let orphan = tmp.path().join("Unplugged drive").join("Files");
    let service = Service::new(
        Arc::new(CountSink::default()),
        Roots {
            appdata: vec![tree.appdata.clone()],
            ..Roots::default()
        },
        fast(),
    );
    let config = Config {
        enabled: vec![
            tree.common_files.to_string_lossy().into_owned(),
            orphan.to_string_lossy().into_owned(),
        ],
        custom: vec![custom.to_string_lossy().into_owned()],
        prefix32: None,
    };
    let views = service.locations(&config);
    let common = &views[0];
    assert!(common.enabled);
    assert_eq!((common.trade_files, common.other_csv_files), (1, 1));
    assert_eq!(
        common
            .preview
            .iter()
            .map(|p| (p.file_name.as_str(), p.kind))
            .collect::<Vec<_>>(),
        vec![(SAMPLE_NAME, "trade_file"), ("notes.csv", "other_csv")]
    );
    let custom_view = views
        .iter()
        .find(|v| v.location.path == custom.to_string_lossy())
        .unwrap();
    assert_eq!(custom_view.location.kind, Kind::Custom);
    assert_eq!(custom_view.location.label, "My exports");
    assert!(!custom_view.enabled);
    let orphan_view = views
        .iter()
        .find(|v| v.location.path == orphan.to_string_lossy())
        .unwrap();
    assert!(orphan_view.enabled && !orphan_view.location.exists);
    assert_eq!(
        service
            .find(&config, &custom_view.location.id)
            .map(|l| l.label),
        Some("My exports".to_string())
    );
    assert!(service.find(&config, "0000000000000000").is_none());
    // Settings serialise with the field names the UI reads.
    let json = serde_json::to_value(&views[0]).unwrap();
    for key in [
        "id",
        "kind",
        "label",
        "path",
        "terminalId",
        "installPath",
        "winePrefix",
        "exists",
        "enabled",
        "tradeFiles",
        "otherCsvFiles",
        "preview",
    ] {
        assert!(json.get(key).is_some(), "missing {key}");
    }
    assert_eq!(json["kind"], "common");
    let status = serde_json::to_value(service.status(&config)).unwrap();
    for key in ["active", "prefix32", "folders", "files", "pending", "lastImport"] {
        assert!(status.get(key).is_some(), "missing {key}");
    }
}

// ------------------------------------------------------------------------------------------
// Read-only guarantees
// ------------------------------------------------------------------------------------------

/// Discovers, enables every location, lets the watcher queue every trade file, reads and
/// finishes each one, rescans, and stops. Returns how many files were handled.
fn run_everything_read_only(tree: &Tree) -> usize {
    let service = Service::new(
        Arc::new(CountSink::default()),
        Roots {
            appdata: vec![tree.appdata.clone()],
            program_files: vec![tree.program_files.clone()],
            wine_prefixes: vec![],
        },
        fast(),
    );
    let mut config = Config::default();
    let views = service.locations(&config);
    assert_eq!(views.len(), 4);
    config.enabled = views.iter().map(|v| v.location.path.clone()).collect();
    service.reconcile(&config, HashMap::new).unwrap();
    wait_until("every trade file queued", WAIT, || {
        service.status(&config).watch.pending.len() == 4
    });
    let pending = service.status(&config).watch.pending;
    for p in &pending {
        let (file, bytes) = service.read(p.token).unwrap();
        assert!(!bytes.is_empty());
        service.finish(
            p.token,
            dojix_desktop_lib::mt5::ImportSummary {
                file_name: file.file_name.clone(),
                folder_id: file.folder_id.clone(),
                format: Some("dojix_export".into()),
                result: "imported".into(),
                message: None,
                parsed: 3,
                inserted: 3,
                duplicates: 0,
                skipped: 0,
                at_ms: 0,
            },
        );
    }
    service.rescan();
    std::thread::sleep(Duration::from_millis(1200));
    let status = service.status(&config);
    assert!(status.watch.pending.is_empty());
    assert!(status
        .watch
        .files
        .iter()
        .filter(|f| f.file_name.starts_with("DojixExport_"))
        .all(|f| f.state == FileState::Imported));
    service.suspend();
    pending.len()
}

fn tree_with_files(root: &Path) -> Tree {
    let tree = windows_tree(root);
    for (i, dir) in [
        &tree.common_files,
        &tree.terminal_a_files,
        &tree.terminal_b_files,
        &tree.portable_files,
    ]
    .iter()
    .enumerate()
    {
        fs::write(dir.join(format!("DojixExport_{i}_20261028.csv")), SAMPLE).unwrap();
        fs::write(dir.join("other.csv"), b"x\r\n").unwrap();
    }
    tree
}

#[test]
fn the_watcher_never_writes_under_watched_roots() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = tree_with_files(tmp.path());
    let before = fingerprint(tmp.path());
    assert_eq!(run_everything_read_only(&tree), 4);
    let after = fingerprint(tmp.path());
    assert_eq!(before, after, "something under the watched roots changed");
}

#[test]
fn everything_works_on_a_folder_the_app_may_not_write_to() {
    let tmp = tempfile::tempdir().unwrap();
    let tree = tree_with_files(tmp.path());
    deny_writes(tmp.path(), true);
    // The deny rule is in force (unless the tests run as a superuser, which ignores it).
    #[cfg(unix)]
    let enforced = unsafe { libc::geteuid() } != 0;
    #[cfg(not(unix))]
    let enforced = true;
    if enforced {
        assert!(fs::write(tree.common_files.join("probe.csv"), b"x").is_err());
        assert!(fs::OpenOptions::new()
            .append(true)
            .open(tree.common_files.join("DojixExport_0_20261028.csv"))
            .is_err());
    }
    let before = fingerprint(tmp.path());
    let handled = std::panic::catch_unwind(|| run_everything_read_only(&tree));
    let after = fingerprint(tmp.path());
    deny_writes(tmp.path(), false);
    assert_eq!(handled.expect("the read-only run failed"), 4);
    assert_eq!(before, after);
}

// ------------------------------------------------------------------------------------------
// Journal side
// ------------------------------------------------------------------------------------------

fn pending_file(name: &str) -> watch::PendingFile {
    watch::PendingFile {
        token: 1,
        folder_id: "f".into(),
        file_name: name.into(),
        size: 10,
        path: PathBuf::from(format!("/fictional/{name}")),
        mtime_ns: 1_000,
        sha256: "ab".repeat(32),
    }
}

#[test]
fn commits_check_every_row_and_only_accept_mt5_formats() {
    let data = tempfile::tempdir().unwrap();
    let mut j = journal(data.path());
    let mut value: serde_json::Value = serde_json::from_str(OUTCOME_JSON).unwrap();
    let trades = value["trades"].as_array_mut().unwrap();
    let good = trades[0].clone();
    let mut bad_source = good.clone();
    bad_source["ticket"] = "600001".into();
    bad_source["source"] = "mac_backup".into();
    let mut bad_ticket = good.clone();
    bad_ticket["ticket"] = "-5".into();
    let mut bad_symbol = good.clone();
    bad_symbol["ticket"] = "600003".into();
    bad_symbol["symbol"] = "EUR\u{0}USD".into();
    let mut bad_time = good.clone();
    bad_time["ticket"] = "600004".into();
    bad_time["openTime"] = "yesterday".into();
    trades.extend([bad_source, bad_ticket, bad_symbol, bad_time]);
    value["issues"] = serde_json::json!([
        {"line": 9, "code": "too_few_columns", "reason": "Expected 32 columns but got 3"},
        {"line": 10, "code": "section_end", "reason": "end"}
    ]);
    let outcome: Outcome = serde_json::from_value(value).unwrap();
    let summary = mt5_journal::commit(&mut j, &pending_file("a.csv"), outcome, 5).unwrap();
    assert_eq!(
        (summary.inserted, summary.duplicates, summary.skipped),
        (3, 0, 5)
    );
    assert_eq!(summary.at_ms, 5);
    assert_eq!(count(&j, "SELECT COUNT(*) FROM trades"), 3);
    let issues: String = j
        .conn()
        .query_row("SELECT issues_json FROM import_batches", [], |r| r.get(0))
        .unwrap();
    assert_eq!(issues.matches("storage_rejected").count(), 4);
    assert!(issues.contains("too_few_columns"));
    // The stored rows are the importer's values.
    let (source, net, basis, range): (String, String, String, Option<f64>) = j
        .conn()
        .query_row(
            "SELECT source, net_profit, time_basis, range_size FROM trades WHERE ticket = 500001",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        (source.as_str(), net.as_str(), basis.as_str(), range),
        ("dojix_export", "15.3", "utc", None)
    );

    // A whole outcome in another format is refused before anything is written.
    let generation = j.generation();
    let wrong: Outcome = serde_json::from_value(serde_json::json!({
        "kind": "trades", "format": "mac_backup", "trades": [], "parsed": 0,
        "duplicatesInFile": 0, "issues": []
    }))
    .unwrap();
    assert!(mt5_journal::prepare(wrong).is_err());
    assert_eq!(j.generation(), generation);
}

#[test]
fn files_that_are_not_trade_files_or_fail_record_only_the_ledger() {
    let data = tempfile::tempdir().unwrap();
    let mut j = journal(data.path());
    let not_trade: Outcome =
        serde_json::from_value(serde_json::json!({"kind": "not_trade_file", "format": "generic"}))
            .unwrap();
    let s = mt5_journal::commit(&mut j, &pending_file("a.csv"), not_trade, 0).unwrap();
    assert_eq!(s.result, "not_trade_file");
    let failed: Outcome = serde_json::from_value(serde_json::json!({
        "kind": "error", "code": "empty_file", "message": "The file is empty"
    }))
    .unwrap();
    let s = mt5_journal::commit(&mut j, &pending_file("b.csv"), failed, 0).unwrap();
    assert_eq!(s.result, "failed");
    assert_eq!(s.message.as_deref(), Some("The file is empty (empty_file)"));
    assert_eq!(count(&j, "SELECT COUNT(*) FROM trades"), 0);
    assert_eq!(count(&j, "SELECT COUNT(*) FROM import_batches"), 0);
    let ledger = mt5_journal::read_ledger(j.conn()).unwrap();
    assert_eq!(ledger.len(), 2);
    let entry = &ledger[&PathBuf::from("/fictional/b.csv")];
    assert_eq!(
        (entry.size, entry.mtime_ns, entry.result.as_str()),
        (10, 1_000, "failed")
    );
}

#[test]
fn settings_round_trip_and_hostile_settings_are_bounded() {
    let data = tempfile::tempdir().unwrap();
    let mut j = journal(data.path());
    assert_eq!(mt5_journal::read_config(j.conn()).unwrap(), Config::default());
    let config = Config {
        enabled: vec!["/a".into(), "/a".into(), String::new(), "x\0y".into()],
        custom: vec!["/b".into()],
        prefix32: Some("bad/prefix".into()),
    };
    j.write(|tx| mt5_journal::write_config(tx, &config))
        .unwrap();
    let read = mt5_journal::read_config(j.conn()).unwrap();
    assert_eq!(read.enabled, vec!["/a".to_string()]);
    assert_eq!(read.custom, vec!["/b".to_string()]);
    assert_eq!(read.prefix32, None);
    j.write(|tx| {
        tx.execute(
            "UPDATE settings SET value_json = 'not json' WHERE key = 'mt5'",
            [],
        )
    })
    .unwrap();
    assert_eq!(mt5_journal::read_config(j.conn()).unwrap(), Config::default());

    use dojix_desktop_lib::mt5::prefix_problem;
    assert!(prefix_problem("Fictional32_").is_none());
    assert!(prefix_problem(" ").is_some());
    assert!(prefix_problem("a*").is_some());
    assert!(prefix_problem(&"x".repeat(65)).is_some());
}
