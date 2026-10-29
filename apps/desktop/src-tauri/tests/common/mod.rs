//! Shared helpers for the MT5 tests: synthetic MetaTrader trees (fictional names only), a
//! counting sink, waiting, and a whole-tree fingerprint for the "never writes" checks.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dojix_desktop_lib::mt5::watch::{Sink, Timing};

/// The fictional DojixExport sample (the exporter's exact output format).
pub const SAMPLE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../mql5/samples/DojixExport_10000001_20261028.csv"
));
pub const SAMPLE_NAME: &str = "DojixExport_10000001_20261028.csv";
/// What `packages/importers` makes of the sample (written by `dojixExport.test.ts`).
pub const OUTCOME_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/mt5_outcome_dojix_export.json"
));

pub const TERMINAL_A: &str = "0123456789ABCDEF0123456789ABCDEF";
pub const TERMINAL_B: &str = "FEDCBA9876543210FEDCBA9876543210";

/// Short clocks so the tests run in seconds.
pub fn fast() -> Timing {
    Timing {
        debounce: Duration::from_millis(150),
        stable_gap: Duration::from_millis(150),
        poll: Duration::from_millis(400),
        busy_retry: Duration::from_millis(100),
        partial_passes: 2,
    }
}

#[derive(Default)]
pub struct CountSink(pub AtomicUsize);

impl Sink for CountSink {
    fn files_ready(&self, _pending: usize) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

pub fn wait_until(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out after {timeout:?} waiting for {what}");
}

pub const WAIT: Duration = Duration::from_secs(20);

/// `origin.txt` as MT5 writes it: UTF-16LE with a BOM.
pub fn utf16le_bom(text: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

pub fn mkdirs(path: &Path) {
    fs::create_dir_all(path).unwrap();
}

/// A Windows-style `%APPDATA%` with two terminals (one without origin.txt), the Common folder,
/// a non-terminal folder, and a Program Files folder with one portable install.
pub struct Tree {
    pub appdata: PathBuf,
    pub program_files: PathBuf,
    pub common_files: PathBuf,
    pub terminal_a_files: PathBuf,
    pub terminal_b_files: PathBuf,
    pub portable_files: PathBuf,
}

pub fn windows_tree(root: &Path) -> Tree {
    let appdata = root.join("AppData").join("Roaming");
    let terminal = appdata.join("MetaQuotes").join("Terminal");
    let common_files = terminal.join("Common").join("Files");
    let terminal_a_files = terminal.join(TERMINAL_A).join("MQL5").join("Files");
    let terminal_b_files = terminal.join(TERMINAL_B).join("MQL5").join("Files");
    for dir in [&common_files, &terminal_a_files, &terminal_b_files] {
        mkdirs(dir);
    }
    mkdirs(&terminal.join("Community"));
    mkdirs(&terminal.join("Help"));
    fs::write(
        terminal.join(TERMINAL_A).join("origin.txt"),
        utf16le_bom("C:\\Program Files\\Fictional Markets MT5"),
    )
    .unwrap();
    let program_files = root.join("Program Files");
    let portable = program_files.join("Fictional Portable MT5");
    let portable_files = portable.join("MQL5").join("Files");
    mkdirs(&portable_files);
    fs::write(portable.join("terminal64.exe"), b"fictional").unwrap();
    // A folder without terminal64.exe is not an install.
    mkdirs(&program_files.join("Other App").join("MQL5").join("Files"));
    Tree {
        appdata,
        program_files,
        common_files,
        terminal_a_files,
        terminal_b_files,
        portable_files,
    }
}

/// One entry of [`fingerprint`].
fn describe(path: &Path) -> String {
    let meta = fs::symlink_metadata(path).unwrap();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    if meta.is_dir() {
        format!("dir mtime={mtime}")
    } else if meta.is_file() {
        let bytes = fs::read(path).unwrap_or_else(|e| {
            #[cfg(windows)]
            {
                for target in [path.to_path_buf(), path.parent().unwrap().to_path_buf()] {
                    let out = std::process::Command::new("icacls").arg(&target).output();
                    if let Ok(out) = out {
                        eprintln!("{}", String::from_utf8_lossy(&out.stdout));
                    }
                }
            }
            panic!("reading {path:?}: {e}")
        });
        let digest = dojix_desktop_lib::crypto::hex(&dojix_desktop_lib::crypto::sha256(&bytes));
        format!(
            "file size={} mtime={mtime} sha256={digest} readonly={}",
            meta.len(),
            meta.permissions().readonly()
        )
    } else {
        format!("other mtime={mtime}")
    }
}

/// Every path under `root` with its kind, size, modification time and SHA-256: any created,
/// changed, renamed or deleted file or folder changes it.
pub fn fingerprint(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        out.insert(
            dir.strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            describe(&dir),
        );
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let meta = fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                stack.push(path);
            } else {
                out.insert(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    describe(&path),
                );
            }
        }
    }
    out
}

/// Writes `bytes` to `path` in place (truncate + write), as MT5's `FileOpen(FILE_WRITE)` does.
pub fn rewrite(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
}

/// Sets a file's modification time `seconds` into the future (a "touch").
pub fn touch_later(path: &Path, seconds: u64) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(SystemTime::now() + Duration::from_secs(seconds))
        .unwrap();
}

/// A deny-write rule on `root` and everything under it, for the current user: Windows ACL
/// (a .NET deny rule set with PowerShell; reading still works), Unix mode bits.
pub fn deny_writes(root: &Path, deny: bool) {
    #[cfg(windows)]
    {
        // .NET's deny rule leaves SYNCHRONIZE and READ_CONTROL alone (icacls' "W" denies
        // them too, which also blocks reading).
        // Applied to the root and to every folder and file under it explicitly.
        let action = if deny {
            "AddAccessRule"
        } else {
            "RemoveAccessRuleAll"
        };
        let script = format!(
            "$ErrorActionPreference = 'Stop'; \
             $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); \
             $rights = 'WriteData,AppendData,WriteExtendedAttributes,WriteAttributes,Delete,DeleteSubdirectoriesAndFiles'; \
             $items = @(Get-Item -LiteralPath $env:DENY_ROOT) + @(Get-ChildItem -LiteralPath $env:DENY_ROOT -Recurse -Force); \
             foreach ($item in $items) {{ \
               $inherit = if ($item.PSIsContainer) {{ 'ContainerInherit,ObjectInherit' }} else {{ 'None' }}; \
               $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $inherit, 'None', 'Deny'); \
               $acl = Get-Acl -LiteralPath $item.FullName; $acl.{action}($rule); \
               Set-Acl -LiteralPath $item.FullName -AclObject $acl }}"
        );
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .env("DENY_ROOT", root)
            .status()
            .unwrap();
        assert!(status.success(), "Set-Acl failed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut paths = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            paths.push(dir.clone());
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if fs::symlink_metadata(&path).unwrap().is_dir() {
                    stack.push(path);
                } else {
                    paths.push(path);
                }
            }
        }
        // Folders last when denying (so they can still be listed), first when allowing.
        paths.sort_by_key(|p| fs::symlink_metadata(p).unwrap().is_dir() == deny);
        for path in paths {
            let is_dir = fs::symlink_metadata(&path).unwrap().is_dir();
            let mode = match (is_dir, deny) {
                (true, true) => 0o555,
                (true, false) => 0o755,
                (false, true) => 0o444,
                (false, false) => 0o644,
            };
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        }
    }
}
