//! The only file access the MT5 module has (SPEC 5.4): **list, stat and read**. Nothing in
//! `src/mt5/` may create, change, rename or delete a file; a test greps this folder for those
//! APIs (`apps/desktop/src/mt5/readonly-gate.test.ts`).
//!
//! - Symbolic links, junctions and other reparse points are never followed when listing or
//!   reading a watched folder's files: only regular files are reported.
//! - Files are opened read-only with full sharing on Windows (read, write and delete), so MT5
//!   is never locked out while a file is being read.
//! - Reads are capped (50 MB, the import cap).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

/// The import cap (SPEC 5.1).
pub const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

/// At most this many entries are looked at per folder listing (a runaway folder can't stall
/// the watcher).
pub const MAX_LIST_ENTRIES: usize = 20_000;

/// Size and modification time of a regular file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Stat {
    pub size: u64,
    /// Nanoseconds since the Unix epoch (0 when the platform has no modification time).
    pub mtime_ns: u128,
}

impl Stat {
    /// Milliseconds since the Unix epoch, for display.
    pub fn mtime_ms(&self) -> i64 {
        i64::try_from(self.mtime_ns / 1_000_000).unwrap_or(i64::MAX)
    }
}

/// One regular file in a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub stat: Stat,
}

/// Why a read failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// The file is gone.
    Gone,
    /// Another process holds the file without sharing it (or holds a byte-range lock).
    Busy,
    /// The account may not read it.
    Denied,
    /// Larger than the cap.
    TooLarge,
    /// Not a regular file (a link, a folder, a device).
    NotAFile,
    Io(String),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            ReadError::Gone => "the file is gone".to_string(),
            ReadError::Busy => "the file is in use by another program".to_string(),
            ReadError::Denied => "the file can't be read (access denied)".to_string(),
            ReadError::TooLarge => "the file is larger than 50 MB".to_string(),
            ReadError::NotAFile => "not a regular file".to_string(),
            ReadError::Io(e) => format!("read error: {e}"),
        };
        f.pad(&text)
    }
}

fn stat_of(meta: &fs::Metadata) -> Stat {
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Stat {
        size: meta.len(),
        mtime_ns,
    }
}

/// True when `meta` (from `symlink_metadata`) is a plain file: not a link and, on Windows,
/// not any other reparse point.
fn is_plain_file(meta: &fs::Metadata) -> bool {
    if !meta.file_type().is_file() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

/// True when `meta` is a real folder (not a link or junction to one).
fn is_plain_dir(meta: &fs::Metadata) -> bool {
    if !meta.file_type().is_dir() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

/// True when `path` is a folder. The folder itself may be reached through a link (a user's
/// own layout), but its contents are never followed.
pub fn is_dir(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

/// True when `path` is a plain regular file.
pub fn is_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| is_plain_file(&m))
        .unwrap_or(false)
}

/// The regular files directly inside `dir`, sorted by name. Links, junctions, folders and
/// names that are not valid Unicode are skipped.
pub fn list_files(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut out = Vec::new();
    for (seen, entry) in fs::read_dir(dir)?.enumerate() {
        if seen >= MAX_LIST_ENTRIES {
            break;
        }
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if is_plain_file(&meta) {
            out.push(Entry {
                name,
                stat: stat_of(&meta),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// The real sub-folders directly inside `dir` (links and junctions skipped), sorted by name.
pub fn list_dirs(dir: &Path) -> io::Result<Vec<String>> {
    let mut out = Vec::new();
    for (seen, entry) in fs::read_dir(dir)?.enumerate() {
        if seen >= MAX_LIST_ENTRIES {
            break;
        }
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if is_plain_dir(&meta) {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

/// Size and modification time of the plain file at `path`.
pub fn stat(path: &Path) -> Result<Stat, ReadError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if is_plain_file(&meta) => Ok(stat_of(&meta)),
        Ok(_) => Err(ReadError::NotAFile),
        Err(e) => Err(classify(&e)),
    }
}

/// Windows error codes for a file held by another process.
#[cfg(windows)]
const ERROR_SHARING_VIOLATION: i32 = 32;
#[cfg(windows)]
const ERROR_LOCK_VIOLATION: i32 = 33;

fn classify(e: &io::Error) -> ReadError {
    #[cfg(windows)]
    if matches!(
        e.raw_os_error(),
        Some(ERROR_SHARING_VIOLATION) | Some(ERROR_LOCK_VIOLATION)
    ) {
        return ReadError::Busy;
    }
    match e.kind() {
        io::ErrorKind::NotFound => ReadError::Gone,
        io::ErrorKind::PermissionDenied => ReadError::Denied,
        _ => ReadError::Io(e.kind().to_string()),
    }
}

/// Opens `path` for reading only: full sharing on Windows, no link following on Unix.
fn open_read_only(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_WRITE: u32 = 0x2;
        const FILE_SHARE_DELETE: u32 = 0x4;
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // No link following, and a FIFO swapped in can't block the watcher.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}

/// Reads the whole plain file at `path`, at most `cap` bytes. Returns the bytes and the
/// file's size and modification time as seen through the open handle.
pub fn read(path: &Path, cap: u64) -> Result<(Vec<u8>, Stat), ReadError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if is_plain_file(&meta) => {}
        Ok(_) => return Err(ReadError::NotAFile),
        Err(e) => return Err(classify(&e)),
    }
    let file = open_read_only(path).map_err(|e| classify(&e))?;
    let meta = file.metadata().map_err(|e| classify(&e))?;
    if !meta.is_file() {
        return Err(ReadError::NotAFile);
    }
    if meta.len() > cap {
        return Err(ReadError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    file.take(cap.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| classify(&e))?;
    if bytes.len() as u64 > cap {
        return Err(ReadError::TooLarge);
    }
    Ok((bytes, stat_of(&meta)))
}
