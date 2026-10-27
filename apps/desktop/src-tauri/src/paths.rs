//! Where the journal lives. Default: the OS local (never roaming) app-data folder plus the
//! brand identifier, the same folder Tauri's `app_local_data_dir()` returns (SPEC 6.2).

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use crate::brand::Brand;
use crate::fsec;

pub const JOURNAL_FILE: &str = "journal.sealed";
pub const LOCK_FILE: &str = "journal.lock";

/// `--data-dir`, the data-dir environment variable and `--vault-service` are honoured only in
/// debug and `e2e` builds. Release builds ignore them, like the Mac apps.
pub const OVERRIDES_ALLOWED: bool = cfg!(any(debug_assertions, feature = "e2e"));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataDirSource {
    Default,
    Override,
}

impl DataDirSource {
    pub fn as_str(self) -> &'static str {
        match self {
            DataDirSource::Default => "default",
            DataDirSource::Override => "override",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataPaths {
    pub root: PathBuf,
    pub source: DataDirSource,
}

impl DataPaths {
    pub fn journal(&self) -> PathBuf {
        self.root.join(JOURNAL_FILE)
    }
    pub fn lock_file(&self) -> PathBuf {
        self.root.join(LOCK_FILE)
    }
    pub fn snapshots(&self) -> PathBuf {
        self.root.join("snapshots")
    }
    pub fn set_aside(&self) -> PathBuf {
        self.root.join("set-aside")
    }
    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }
    pub fn screenshots(&self) -> PathBuf {
        self.root.join("screenshots")
    }

    fn folders(&self) -> [PathBuf; 5] {
        [
            self.snapshots(),
            self.set_aside(),
            self.logs(),
            self.screenshots(),
            self.root.clone(),
        ]
    }

    /// Creates the data folder and its sub-folders owner-only (Linux 0700, Windows protected
    /// DACL for the user and SYSTEM), and repairs the protection of an existing folder.
    /// Returns true when an existing folder had to be repaired.
    pub fn ensure(&self) -> io::Result<bool> {
        fsec::create_private_dir(&self.root)?;
        let mut repaired = false;
        for dir in self.folders() {
            fsec::create_private_dir(&dir)?;
            if !fsec::dir_is_private(&dir)? {
                fsec::make_dir_private(&dir)?;
                repaired = true;
            }
        }
        Ok(repaired)
    }

    /// True when every folder exists and is owner-only.
    pub fn is_private(&self) -> io::Result<bool> {
        for dir in self.folders() {
            if !fsec::dir_is_private(&dir)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("the operating system did not report a local app-data folder")]
    NoLocalDataDir,
    #[error("the data folder path could not be made absolute: {0}")]
    NotAbsolute(io::Error),
}

/// Resolves the data folder: `--data-dir`, then the brand's environment variable, then the
/// default. Overrides are ignored unless `overrides_allowed`.
pub fn resolve(
    brand: &Brand,
    overrides_allowed: bool,
    cli_dir: Option<&Path>,
    env_dir: Option<OsString>,
) -> Result<DataPaths, PathError> {
    if overrides_allowed {
        let env_dir = env_dir.filter(|v| !v.is_empty()).map(PathBuf::from);
        if let Some(dir) = cli_dir.map(Path::to_path_buf).or(env_dir) {
            let root = std::path::absolute(&dir).map_err(PathError::NotAbsolute)?;
            return Ok(DataPaths {
                root,
                source: DataDirSource::Override,
            });
        }
    }
    let base = dirs::data_local_dir().ok_or(PathError::NoLocalDataDir)?;
    Ok(DataPaths {
        root: base.join(brand.identifier),
        source: DataDirSource::Default,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brand::{DOJIX, GREENWICK};

    #[test]
    fn cli_flag_wins_over_environment() {
        let tmp = tempfile::tempdir().unwrap();
        let cli = tmp.path().join("cli");
        let env = tmp.path().join("env");
        let p = resolve(&DOJIX, true, Some(&cli), Some(env.into_os_string())).unwrap();
        assert_eq!(p.root, cli);
        assert_eq!(p.source, DataDirSource::Override);
    }

    #[test]
    fn environment_is_used_without_a_flag_and_empty_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let env = tmp.path().join("env");
        let p = resolve(&DOJIX, true, None, Some(env.clone().into_os_string())).unwrap();
        assert_eq!(p.root, env);
        let d = resolve(&DOJIX, true, None, Some(OsString::new())).unwrap();
        assert_eq!(d.source, DataDirSource::Default);
    }

    #[test]
    fn release_builds_ignore_overrides() {
        let tmp = tempfile::tempdir().unwrap();
        let cli = tmp.path().join("cli");
        let p = resolve(
            &DOJIX,
            false,
            Some(&cli),
            Some(cli.clone().into_os_string()),
        )
        .unwrap();
        assert_eq!(p.source, DataDirSource::Default);
        assert!(p.root.ends_with("io.github.djctwo.dojix"));
    }

    #[test]
    fn relative_overrides_become_absolute() {
        let p = resolve(&DOJIX, true, Some(Path::new("scratch-rel")), None).unwrap();
        assert!(p.root.is_absolute());
        assert!(p.root.ends_with("scratch-rel"));
    }

    #[test]
    fn default_is_the_local_app_data_folder_per_brand() {
        let d = resolve(&DOJIX, false, None, None).unwrap();
        let g = resolve(&GREENWICK, false, None, None).unwrap();
        assert!(d.root.ends_with("io.github.djctwo.dojix"));
        assert!(g.root.ends_with("io.github.djctwo.greenwick"));
        assert_eq!(d.root.parent(), dirs::data_local_dir().as_deref());
    }

    #[test]
    fn ensure_creates_private_sub_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let p = resolve(&DOJIX, true, Some(&tmp.path().join("a b")), None).unwrap();
        p.ensure().unwrap();
        for dir in [p.snapshots(), p.set_aside(), p.logs(), p.screenshots()] {
            assert!(dir.is_dir(), "{} missing", dir.display());
        }
        assert!(p.is_private().unwrap());
        assert_eq!(p.journal().file_name().unwrap(), JOURNAL_FILE);
        assert_eq!(p.lock_file().file_name().unwrap(), LOCK_FILE);
    }
}
