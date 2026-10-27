//! Sealed screenshots (SPEC 6.10): `screenshots/<trade_id>/<uuid>.sealed`, each
//!
//! ```text
//! "DXSC" | version u8 (=1) | AES-256-GCM box (nonce | ciphertext | tag)
//! ```
//!
//! with the 5-byte header **and the file name** as associated data (Greenwick's `GWSC`
//! construction, used by both brands), so a file can't be swapped for another trade's.
//! Sealed with the journal key; nothing is read or written while locked (the session holds
//! no key then). Every write goes through the secure writer and is read back.
//!
//! The image ingest (decode, re-encode as JPEG, size limits) and the IPC commands arrive with
//! the trade-detail screen (phase 3); this module is the storage and key-rotation side.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::crypto::{self, CryptoError};
use crate::fsec;
use crate::seal::JournalKey;

pub const MAGIC: &[u8; 4] = b"DXSC";
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 5;
pub const MAX_PER_TRADE: usize = 10;
const SUFFIX: &str = ".sealed";

#[derive(Debug, thiserror::Error)]
pub enum ScreenshotError {
    #[error("not a sealed screenshot")]
    NotAScreenshot,
    #[error("the screenshot could not be decrypted")]
    Decrypt,
    #[error("unsafe screenshot name")]
    BadName,
    #[error("a trade can have at most {MAX_PER_TRADE} screenshots")]
    TooMany,
    #[error("the screenshot did not read back")]
    ReadBack,
    #[error("{0}")]
    Crypto(#[from] CryptoError),
    #[error("file error: {0}")]
    Io(#[from] io::Error),
}

fn aad(file_name: &str) -> Vec<u8> {
    let mut aad = MAGIC.to_vec();
    aad.push(VERSION);
    aad.extend_from_slice(file_name.as_bytes());
    aad
}

pub fn seal_image(
    key: &JournalKey,
    file_name: &str,
    image: &[u8],
) -> Result<Vec<u8>, ScreenshotError> {
    let boxed = crypto::seal_box(key.as_bytes(), &aad(file_name), image)?;
    let mut out = MAGIC.to_vec();
    out.push(VERSION);
    out.extend_from_slice(&boxed);
    Ok(out)
}

pub fn open_image(
    key: &JournalKey,
    file_name: &str,
    bytes: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ScreenshotError> {
    if bytes.len() < HEADER_LEN || &bytes[..4] != MAGIC || bytes[4] != VERSION {
        return Err(ScreenshotError::NotAScreenshot);
    }
    crypto::open_box(key.as_bytes(), &aad(file_name), &bytes[HEADER_LEN..])
        .map_err(|_| ScreenshotError::Decrypt)
}

/// `<lower-case UUID>.sealed`, the only names the app writes.
pub fn is_valid_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(SUFFIX) else {
        return false;
    };
    stem.len() == 36
        && stem.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_digit() || ('a'..='f').contains(&c),
        })
}

/// A random version-4 UUID file name.
pub fn new_name() -> Result<String, CryptoError> {
    let mut b = [0u8; 16];
    crypto::random(&mut b)?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = crypto::hex(&b);
    Ok(format!(
        "{}-{}-{}-{}-{}{SUFFIX}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

pub struct Screenshots {
    root: PathBuf,
}

impl Screenshots {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }

    fn trade_dir(&self, trade_id: i64) -> Result<PathBuf, ScreenshotError> {
        if trade_id <= 0 {
            return Err(ScreenshotError::BadName);
        }
        Ok(self.root.join(trade_id.to_string()))
    }

    /// Seals and stores an (already re-encoded) image for a trade; returns its file name.
    pub fn store(
        &self,
        key: &JournalKey,
        trade_id: i64,
        image: &[u8],
    ) -> Result<String, ScreenshotError> {
        let dir = self.trade_dir(trade_id)?;
        fsec::create_private_dir(&dir)?;
        let count = fs::read_dir(&dir)?
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_str().is_some_and(is_valid_name))
            .count();
        if count >= MAX_PER_TRADE {
            return Err(ScreenshotError::TooMany);
        }
        let name = new_name()?;
        let sealed = seal_image(key, &name, image)?;
        let path = dir.join(&name);
        fsec::write_atomic(&path, &sealed)?;
        let back = fs::read(&path)?;
        match open_image(key, &name, &back) {
            Ok(opened) if crypto::ct_eq(&opened, image) => Ok(name),
            _ => {
                let _ = fs::remove_file(&path);
                Err(ScreenshotError::ReadBack)
            }
        }
    }

    pub fn read(
        &self,
        key: &JournalKey,
        trade_id: i64,
        name: &str,
    ) -> Result<Zeroizing<Vec<u8>>, ScreenshotError> {
        if !is_valid_name(name) {
            return Err(ScreenshotError::BadName);
        }
        let bytes = fs::read(self.trade_dir(trade_id)?.join(name))?;
        open_image(key, name, &bytes)
    }

    pub fn delete(&self, trade_id: i64, name: &str) -> Result<(), ScreenshotError> {
        if !is_valid_name(name) {
            return Err(ScreenshotError::BadName);
        }
        match fs::remove_file(self.trade_dir(trade_id)?.join(name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Every sealed screenshot file (path and name).
    fn all(&self) -> io::Result<Vec<(PathBuf, String)>> {
        let mut out = Vec::new();
        if !self.root.exists() {
            return Ok(out);
        }
        for trade in fs::read_dir(&self.root)? {
            let trade = trade?.path();
            if !trade.is_dir() {
                continue;
            }
            for file in fs::read_dir(&trade)? {
                let path = file?.path();
                let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string)
                else {
                    continue;
                };
                if is_valid_name(&name) {
                    out.push((path, name));
                }
            }
        }
        Ok(out)
    }

    /// Re-seals every screenshot from `old` to `new` (key rotation). Returns the files that
    /// may still need `old`; a folder that can't be listed counts as not done.
    pub fn reseal(&self, old: &JournalKey, new: &JournalKey) -> io::Result<Vec<PathBuf>> {
        let mut pending = Vec::new();
        for (path, name) in self.all()? {
            let bytes = match fs::read(&path) {
                Ok(b) => b,
                Err(e) => {
                    log::error!("could not read a screenshot to re-seal it: {e}");
                    pending.push(path);
                    continue;
                }
            };
            match open_image(old, &name, &bytes) {
                Ok(image) => {
                    let ok = seal_image(new, &name, &image)
                        .ok()
                        .and_then(|sealed| fsec::write_atomic(&path, &sealed).ok());
                    if ok.is_none() {
                        log::error!("could not re-seal a screenshot");
                        pending.push(path);
                    }
                }
                Err(_) if open_image(new, &name, &bytes).is_ok() => {}
                Err(_) => log::warn!("a screenshot opens with neither key; left as it is"),
            }
        }
        Ok(pending)
    }

    /// Deletes every screenshot (erase).
    pub fn delete_all(&self) -> io::Result<()> {
        if !self.root.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(&self.root)? {
            let path = entry?.path();
            if path.is_dir() {
                fs::remove_dir_all(&path)?;
            } else {
                fs::remove_file(&path)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JPEG: &[u8] = b"\xff\xd8\xff fictional image bytes";

    #[test]
    fn the_file_name_is_bound_to_the_contents() {
        let key = JournalKey::generate().unwrap();
        let a = new_name().unwrap();
        let b = new_name().unwrap();
        assert!(is_valid_name(&a) && is_valid_name(&b) && a != b);
        let sealed = seal_image(&key, &a, JPEG).unwrap();
        assert_eq!(&sealed[..5], b"DXSC\x01");
        assert_eq!(open_image(&key, &a, &sealed).unwrap().as_slice(), JPEG);
        assert!(matches!(
            open_image(&key, &b, &sealed),
            Err(ScreenshotError::Decrypt)
        ));
        let other = JournalKey::generate().unwrap();
        assert!(open_image(&other, &a, &sealed).is_err());
    }

    #[test]
    fn only_app_names_are_accepted() {
        for bad in [
            "../x.sealed",
            "0123.sealed",
            "01234567-89ab-cdef-0123-456789abcdef.jpg",
            "01234567-89AB-cdef-0123-456789abcdef.sealed",
            "01234567x89ab-cdef-0123-456789abcdef.sealed",
        ] {
            assert!(!is_valid_name(bad), "{bad}");
        }
        assert!(is_valid_name("01234567-89ab-cdef-0123-456789abcdef.sealed"));
    }

    #[test]
    fn store_read_limit_and_reseal() {
        let tmp = tempfile::tempdir().unwrap();
        let shots = Screenshots::new(tmp.path());
        let old = JournalKey::generate().unwrap();
        let new = JournalKey::generate().unwrap();
        let name = shots.store(&old, 7, JPEG).unwrap();
        assert_eq!(shots.read(&old, 7, &name).unwrap().as_slice(), JPEG);
        for _ in 1..MAX_PER_TRADE {
            shots.store(&old, 7, JPEG).unwrap();
        }
        assert!(matches!(
            shots.store(&old, 7, JPEG),
            Err(ScreenshotError::TooMany)
        ));
        assert!(shots.reseal(&old, &new).unwrap().is_empty());
        assert_eq!(shots.read(&new, 7, &name).unwrap().as_slice(), JPEG);
        assert!(shots.read(&old, 7, &name).is_err());
        // Idempotent: a second pass finds everything already on the new key.
        assert!(shots.reseal(&old, &new).unwrap().is_empty());
        assert!(shots.read(&new, 7, "../../journal.sealed").is_err());
        shots.delete(7, &name).unwrap();
        assert!(shots.read(&new, 7, &name).is_err());
        shots.delete_all().unwrap();
        assert!(shots.all().unwrap().is_empty());
    }
}
