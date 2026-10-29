//! Finds MetaTrader 5's file folders (SPEC 5.4): the shared `Common\Files` folder, each
//! terminal's `MQL5\Files` (labelled from its `origin.txt`), portable installs, and the same
//! layout inside Wine prefixes on Linux. Discovery only lists and reads (through [`super::ro`]).
//!
//! Every root is injectable ([`Roots`]) so tests run on synthetic trees.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::ro;

/// Where to look. [`Roots::system`] fills it from the environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Roots {
    /// Roaming application-data folders (`%APPDATA%`), each holding `MetaQuotes\Terminal`.
    pub appdata: Vec<PathBuf>,
    /// Program Files folders searched one level deep for portable installs.
    pub program_files: Vec<PathBuf>,
    /// Wine prefixes (`~/.wine`, `~/.mt5`, `$WINEPREFIX`).
    pub wine_prefixes: Vec<PathBuf>,
}

fn push_unique(list: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.as_os_str().is_empty() && !list.contains(&path) {
        list.push(path);
    }
}

impl Roots {
    /// The real roots for this computer.
    pub fn system() -> Self {
        let mut roots = Roots::default();
        #[cfg(windows)]
        {
            if let Some(appdata) = std::env::var_os("APPDATA") {
                push_unique(&mut roots.appdata, PathBuf::from(appdata));
            } else if let Some(dir) = dirs::config_dir() {
                push_unique(&mut roots.appdata, dir);
            }
            for var in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(dir) = std::env::var_os(var) {
                    push_unique(&mut roots.program_files, PathBuf::from(dir));
                }
            }
        }
        #[cfg(not(windows))]
        {
            if let Some(prefix) = std::env::var_os("WINEPREFIX") {
                push_unique(&mut roots.wine_prefixes, PathBuf::from(prefix));
            }
            if let Some(home) = dirs::home_dir() {
                push_unique(&mut roots.wine_prefixes, home.join(".wine"));
                push_unique(&mut roots.wine_prefixes, home.join(".mt5"));
            }
        }
        roots
    }
}

/// What kind of folder a location is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// `Terminal\Common\Files`: what scripts using `FILE_COMMON` write to (all terminals).
    Common,
    /// One terminal's `MQL5\Files`.
    Terminal,
    /// `MQL5\Files` inside an install folder (portable mode).
    Portable,
    /// A folder the user added.
    Custom,
}

/// A folder MT5 writes files to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// Stable id derived from the path (what the UI passes back).
    pub id: String,
    pub kind: Kind,
    pub label: String,
    pub path: String,
    /// The 32-hex terminal folder name (terminal locations).
    pub terminal_id: Option<String>,
    /// The install folder from `origin.txt` (terminal locations) or the install folder itself
    /// (portable locations).
    pub install_path: Option<String>,
    /// The Wine prefix the location lives in (Linux).
    pub wine_prefix: Option<String>,
    /// False when the folder doesn't exist yet (MT5 creates `Common\Files` on first use).
    pub exists: bool,
}

/// The stable id of a folder path.
pub fn location_id(path: &Path) -> String {
    let digest = crate::crypto::sha256(path.to_string_lossy().as_bytes());
    crate::crypto::hex(&digest[..8])
}

/// A location for `path`.
pub fn location(
    kind: Kind,
    label: String,
    path: &Path,
    terminal_id: Option<String>,
    install_path: Option<String>,
    wine_prefix: Option<&Path>,
) -> Location {
    Location {
        id: location_id(path),
        kind,
        label,
        path: path.to_string_lossy().into_owned(),
        terminal_id,
        install_path,
        wine_prefix: wine_prefix.map(|p| p.to_string_lossy().into_owned()),
        exists: ro::is_dir(path),
    }
}

/// A terminal data folder's name: 32 hexadecimal digits.
pub fn is_terminal_id(name: &str) -> bool {
    name.len() == 32 && name.bytes().all(|b| b.is_ascii_hexdigit())
}

fn looks_utf16le(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes.len().is_multiple_of(2) && bytes[1] == 0 && bytes[0] != 0
}

/// The text of an `origin.txt`: UTF-16LE with a BOM as MT5 writes it, but UTF-16BE, BOM-less
/// UTF-16LE and UTF-8 are accepted too. Surrounding whitespace and NULs are trimmed. `None`
/// when it is empty or not text.
pub fn decode_origin(bytes: &[u8]) -> Option<String> {
    let utf16 = |data: &[u8], big_endian: bool| -> String {
        let (pairs, _) = data.as_chunks::<2>();
        let units: Vec<u16> = pairs
            .iter()
            .map(|&c| {
                if big_endian {
                    u16::from_be_bytes(c)
                } else {
                    u16::from_le_bytes(c)
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    let text = if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        utf16(rest, false)
    } else if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        utf16(rest, true)
    } else if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(rest).into_owned()
    } else if looks_utf16le(bytes) {
        // BOM-less UTF-16LE (ASCII text has a zero in every second byte).
        utf16(bytes, false)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    let first_line = text.lines().next().unwrap_or("");
    let trimmed = first_line.trim_matches(|c: char| c.is_whitespace() || c == '\0');
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control()) {
        None
    } else {
        Some(trimmed.chars().take(1024).collect())
    }
}

/// The install folder's own name ("C:\Program Files\Fictional MT5" → "Fictional MT5").
pub fn install_label(install_path: &str) -> String {
    install_path
        .trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(install_path)
        .to_string()
}

const ORIGIN_MAX_BYTES: u64 = 8 * 1024;

fn read_origin(terminal_dir: &Path) -> Option<String> {
    let (bytes, _) = ro::read(&terminal_dir.join("origin.txt"), ORIGIN_MAX_BYTES).ok()?;
    decode_origin(&bytes)
}

/// Locations under one roaming application-data folder (`<appdata>\MetaQuotes\Terminal`).
fn scan_appdata(appdata: &Path, wine: Option<&Path>, out: &mut Vec<Location>) {
    let terminal_root = appdata.join("MetaQuotes").join("Terminal");
    if !ro::is_dir(&terminal_root) {
        return;
    }
    let common = terminal_root.join("Common").join("Files");
    out.push(location(
        Kind::Common,
        "All terminals (Common\\Files)".to_string(),
        &common,
        None,
        None,
        wine,
    ));
    let Ok(dirs) = ro::list_dirs(&terminal_root) else {
        return;
    };
    for name in dirs.into_iter().filter(|n| is_terminal_id(n)) {
        let dir = terminal_root.join(&name);
        let origin = read_origin(&dir);
        let label = match &origin {
            Some(install) => install_label(install),
            None => format!("Terminal {}", &name[..8]),
        };
        let files = dir.join("MQL5").join("Files");
        out.push(location(
            Kind::Terminal,
            label,
            &files,
            Some(name.clone()),
            origin,
            wine,
        ));
    }
}

/// Portable installs one level under a Program Files folder: `terminal64.exe` next to
/// `MQL5\Files`.
fn scan_program_files(program_files: &Path, wine: Option<&Path>, out: &mut Vec<Location>) {
    let Ok(dirs) = ro::list_dirs(program_files) else {
        return;
    };
    for name in dirs {
        let install = program_files.join(&name);
        let files = install.join("MQL5").join("Files");
        if ro::is_file(&install.join("terminal64.exe")) && ro::is_dir(&files) {
            out.push(location(
                Kind::Portable,
                format!("{name} (install folder)"),
                &files,
                None,
                Some(install.to_string_lossy().into_owned()),
                wine,
            ));
        }
    }
}

/// The roaming application-data folders of every Wine user in `prefix`.
fn wine_appdata(prefix: &Path) -> Vec<PathBuf> {
    let users = prefix.join("drive_c").join("users");
    let Ok(names) = ro::list_dirs(&users) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for name in names {
        if name.eq_ignore_ascii_case("public") {
            continue;
        }
        let home = users.join(&name);
        // Current Wine uses AppData\Roaming; older prefixes use "Application Data".
        for roaming in [
            home.join("AppData").join("Roaming"),
            home.join("Application Data"),
        ] {
            if ro::is_dir(&roaming) {
                out.push(roaming);
            }
        }
    }
    out
}

/// Every MT5 file folder under `roots`, without duplicates, in a stable order: per root,
/// `Common\Files` first, then terminals by folder name, then portable installs.
pub fn discover(roots: &Roots) -> Vec<Location> {
    let mut out = Vec::new();
    for appdata in &roots.appdata {
        scan_appdata(appdata, None, &mut out);
    }
    for pf in &roots.program_files {
        scan_program_files(pf, None, &mut out);
    }
    for prefix in &roots.wine_prefixes {
        if !ro::is_dir(&prefix.join("drive_c")) {
            continue;
        }
        for appdata in wine_appdata(prefix) {
            scan_appdata(&appdata, Some(prefix), &mut out);
        }
        for pf in ["Program Files", "Program Files (x86)"] {
            scan_program_files(&prefix.join("drive_c").join(pf), Some(prefix), &mut out);
        }
    }
    let mut seen = HashSet::new();
    out.retain(|l| seen.insert(l.id.clone()));
    out
}
