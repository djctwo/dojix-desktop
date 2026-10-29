//! Which folder paths the MT5 watcher may touch at all. Pure string checks: a path is never
//! listed, stat'ed or opened before it passes them.
//!
//! Refused: network paths (`\\server\share`, `//server/share`, `\\?\UNC\…`), which on Windows
//! would make the OS connect to the server and offer the user's credentials; device and
//! namespace paths (`\\.\…`, `\??\…`, `\\?\` except the plain local-drive form `\\?\C:\…`);
//! relative paths and `..` components; control characters; over-long paths. On Windows a path
//! must start with a drive letter (`C:\`; mapped drives are drive letters too); elsewhere with
//! a single `/`.

/// Longest accepted path, in bytes.
pub const PATH_MAX: usize = 4096;

fn is_drive_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/')
}

/// Why `path` may not be watched on a Windows (`windows`) or Unix system, if it may not.
pub fn path_problem_for(path: &str, windows: bool) -> Option<&'static str> {
    if path.is_empty() || path.len() > PATH_MAX {
        return Some("empty or too long");
    }
    if path.chars().any(|c| c.is_control()) {
        return Some("control characters");
    }
    let has_parent = path.split(['\\', '/']).any(|part| part == "..");
    if has_parent {
        return Some("`..` components");
    }
    if windows {
        let lower = path.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix(r"\\?\") {
            // Only the long-path form of a local drive: \\?\C:\...
            if rest.starts_with(r"unc\") || !is_drive_absolute(rest) {
                return Some("network or device path");
            }
            return None;
        }
        if lower.starts_with(r"\\") || lower.starts_with("//") || lower.starts_with(r"\??\") {
            return Some("network or device path");
        }
        if lower.starts_with(r"\/") || lower.starts_with(r"/\") {
            return Some("network or device path");
        }
        if !is_drive_absolute(path) {
            return Some("not an absolute local path");
        }
        None
    } else {
        if path.starts_with("//") {
            return Some("network path");
        }
        if !path.starts_with('/') {
            return Some("not an absolute path");
        }
        None
    }
}

/// [`path_problem_for`] on this system.
pub fn path_problem(path: &str) -> Option<&'static str> {
    path_problem_for(path, cfg!(windows))
}

/// True when `path` may be watched.
pub fn is_acceptable(path: &str) -> bool {
    path_problem(path).is_none()
}
