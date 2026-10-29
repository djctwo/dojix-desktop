//! `prefs.json` (SPEC 6.11): settings that must be readable while locked. It holds no trading
//! data. Written with the secure writer; a missing or damaged file means the defaults.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsec;

pub const FILE: &str = "prefs.json";
/// The idle auto-lock choices, in minutes (0 = Off).
pub const IDLE_CHOICES: &[u32] = &[0, 1, 5, 15, 30, 60];
pub const IDLE_DEFAULT: u32 = 15;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub idle_lock_minutes: u32,
    /// Pulse's economic calendar (Dojix; SPEC 8.3): on by default, a public feed, no key.
    pub economic_calendar: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            idle_lock_minutes: IDLE_DEFAULT,
            economic_calendar: true,
        }
    }
}

pub fn path(root: &Path) -> PathBuf {
    root.join(FILE)
}

pub fn load(root: &Path) -> Prefs {
    let mut prefs = std::fs::read(path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Prefs>(&bytes).ok())
        .unwrap_or_default();
    if !IDLE_CHOICES.contains(&prefs.idle_lock_minutes) {
        prefs.idle_lock_minutes = IDLE_DEFAULT;
    }
    prefs
}

pub fn save(root: &Path, prefs: &Prefs) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(prefs).map_err(std::io::Error::other)?;
    fsec::write_atomic(&path(root), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_and_bad_values() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load(tmp.path()).idle_lock_minutes, 15);
        assert!(load(tmp.path()).economic_calendar);
        save(
            tmp.path(),
            &Prefs {
                idle_lock_minutes: 5,
                economic_calendar: false,
            },
        )
        .unwrap();
        assert_eq!(load(tmp.path()).idle_lock_minutes, 5);
        assert!(!load(tmp.path()).economic_calendar);
        std::fs::write(path(tmp.path()), br#"{"idleLockMinutes": 5}"#).unwrap();
        assert!(
            load(tmp.path()).economic_calendar,
            "older files keep the default"
        );
        std::fs::write(path(tmp.path()), br#"{"idleLockMinutes": 7}"#).unwrap();
        assert_eq!(load(tmp.path()).idle_lock_minutes, 15);
        std::fs::write(path(tmp.path()), b"not json").unwrap();
        assert_eq!(load(tmp.path()).idle_lock_minutes, 15);
    }
}
