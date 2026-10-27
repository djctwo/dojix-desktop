//! Backup file formats (SPEC 6.8).
//!
//! Written by this app:
//!
//! ```text
//! "DXBK" | version u8 (=1) | kdf id u8 (1 = Argon2id) | m KiB u32 | t u32 | p u8 | salt [16]
//!        | AES-256-GCM box of the SQLite image   (the 31-byte header is the AAD)
//! ```
//!
//! or, without a password, the plain SQLite image (the UI says it is unencrypted).
//!
//! Read as well (Mac backups, PBKDF2-SHA256):
//! - Dojix `DJXB`: `"DJXB" | 0x01 | iterations u32 | salt [16]`, 25-byte header as AAD,
//!   iterations accepted 1,000–10,000,000.
//! - Dojix 1.x `DOJX`: `"DOJX" | salt [16] | box`, 100,000 iterations, no AAD.
//! - Greenwick `GWBK` v2: `"GWBK" | 0x02 | rounds u32 | salt length u8 (=16) | salt`, 26-byte
//!   header as AAD, rounds 1–10,000,000.
//! - Greenwick legacy `SJNL`: `"SJNL" | salt [16] | box`, 100,000 rounds, no AAD.
//!
//! Decryption happens in memory only; the image then goes through the validated restore
//! (`restore.rs`). A backup file is never copied over the journal.

use zeroize::Zeroizing;

use crate::crypto::{self, HeaderError, KdfParams, PasswordHeader, BOX_OVERHEAD, SALT_LEN};
use crate::seal::SQLITE_MAGIC;

pub const DESKTOP_MAGIC: &[u8; 4] = b"DXBK";
pub const DESKTOP_VERSION: u8 = 1;
/// Largest backup accepted (the Mac limit).
pub const MAX_BACKUP_BYTES: u64 = 512 * 1024 * 1024;

const DJXB: &[u8; 4] = b"DJXB";
const DOJX: &[u8; 4] = b"DOJX";
const GWBK: &[u8; 4] = b"GWBK";
const SJNL: &[u8; 4] = b"SJNL";
const LEGACY_ROUNDS: u32 = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupKind {
    /// `DXBK`, this app.
    Desktop,
    /// A plain SQLite image (desktop or Mac schema; decided by the restore).
    Plain,
    MacDojix,
    MacDojixLegacy,
    MacGreenwick,
    MacGreenwickLegacy,
    /// Not a backup at all.
    Unknown,
}

impl BackupKind {
    pub fn needs_password(self) -> bool {
        !matches!(self, BackupKind::Plain | BackupKind::Unknown)
    }

    pub fn is_mac(self) -> bool {
        matches!(
            self,
            BackupKind::MacDojix
                | BackupKind::MacDojixLegacy
                | BackupKind::MacGreenwick
                | BackupKind::MacGreenwickLegacy
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BackupError {
    #[error("This backup is protected with a password. Enter it to restore.")]
    PasswordRequired,
    #[error(
        "Wrong password for this backup (or the file was changed). Your journal was not changed."
    )]
    WrongPassword,
    #[error("This backup file is damaged or not a backup. Your journal was not changed.")]
    Damaged,
    #[error("This backup was made by a newer version. Update the app, then restore it.")]
    NewerVersion,
    #[error("The selected file is not a backup.")]
    NotABackup,
    #[error("The backup is larger than 512 MB, so it was not restored.")]
    TooLarge,
    #[error("The backup could not be encrypted.")]
    Encrypt,
}

pub fn kind(bytes: &[u8]) -> BackupKind {
    if bytes.len() < 4 {
        return BackupKind::Unknown;
    }
    match &bytes[..4] {
        m if m == DESKTOP_MAGIC => BackupKind::Desktop,
        m if m == DJXB => BackupKind::MacDojix,
        m if m == DOJX => BackupKind::MacDojixLegacy,
        m if m == GWBK => BackupKind::MacGreenwick,
        m if m == SJNL => BackupKind::MacGreenwickLegacy,
        _ if bytes.len() >= SQLITE_MAGIC.len() && &bytes[..SQLITE_MAGIC.len()] == SQLITE_MAGIC => {
            BackupKind::Plain
        }
        _ => BackupKind::Unknown,
    }
}

/// Seals a SQLite image as a desktop backup.
pub fn seal_desktop(
    image: &[u8],
    password: &str,
    params: KdfParams,
) -> Result<Vec<u8>, BackupError> {
    let header = PasswordHeader {
        magic: *DESKTOP_MAGIC,
        version: DESKTOP_VERSION,
        params,
        salt: crypto::random_salt().map_err(|_| BackupError::Encrypt)?,
    };
    let key = crypto::argon2id(password.as_bytes(), &header.salt, params)
        .map_err(|_| BackupError::Encrypt)?;
    let header_bytes = header.to_bytes();
    let boxed = crypto::seal_box(&key, &header_bytes, image).map_err(|_| BackupError::Encrypt)?;
    let mut out = header_bytes.to_vec();
    out.extend_from_slice(&boxed);
    Ok(out)
}

/// Decrypts any supported backup to its SQLite image. A plain file is returned as it is.
pub fn open(bytes: &[u8], password: Option<&str>) -> Result<Zeroizing<Vec<u8>>, BackupError> {
    if bytes.len() as u64 > MAX_BACKUP_BYTES {
        return Err(BackupError::TooLarge);
    }
    let k = kind(bytes);
    match k {
        BackupKind::Unknown => return Err(BackupError::NotABackup),
        BackupKind::Plain => return Ok(Zeroizing::new(bytes.to_vec())),
        _ => {}
    }
    let password = match password {
        Some(p) if !p.is_empty() => p,
        _ => return Err(BackupError::PasswordRequired),
    };
    match k {
        BackupKind::Desktop => open_desktop(bytes, password),
        BackupKind::MacDojix => open_djxb(bytes, password),
        BackupKind::MacDojixLegacy | BackupKind::MacGreenwickLegacy => open_legacy(bytes, password),
        BackupKind::MacGreenwick => open_gwbk(bytes, password),
        BackupKind::Plain | BackupKind::Unknown => Err(BackupError::NotABackup),
    }
}

fn open_desktop(bytes: &[u8], password: &str) -> Result<Zeroizing<Vec<u8>>, BackupError> {
    let header = match PasswordHeader::parse(bytes, DESKTOP_MAGIC, DESKTOP_VERSION) {
        Ok(h) => h,
        Err(HeaderError::NewerVersion) => return Err(BackupError::NewerVersion),
        Err(_) => return Err(BackupError::Damaged),
    };
    if bytes.len() < PasswordHeader::LEN + BOX_OVERHEAD {
        return Err(BackupError::Damaged);
    }
    let key = crypto::argon2id(password.as_bytes(), &header.salt, header.params)
        .map_err(|_| BackupError::Damaged)?;
    let (head, boxed) = bytes.split_at(PasswordHeader::LEN);
    crypto::open_box(&key, head, boxed).map_err(|_| BackupError::WrongPassword)
}

fn be_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes[..4].try_into().expect("4 bytes"))
}

/// Mac Dojix `DJXB` v1.
fn open_djxb(bytes: &[u8], password: &str) -> Result<Zeroizing<Vec<u8>>, BackupError> {
    const HEADER: usize = 4 + 1 + 4 + SALT_LEN;
    if bytes.len() < HEADER + BOX_OVERHEAD {
        return Err(BackupError::Damaged);
    }
    match bytes[4] {
        1 => {}
        v if v > 1 => return Err(BackupError::NewerVersion),
        _ => return Err(BackupError::Damaged),
    }
    let iterations = be_u32(&bytes[5..9]);
    if !(1_000..=10_000_000).contains(&iterations) {
        return Err(BackupError::Damaged);
    }
    let key = crypto::pbkdf2_sha256(password.as_bytes(), &bytes[9..HEADER], iterations);
    crypto::open_box(&key, &bytes[..HEADER], &bytes[HEADER..])
        .map_err(|_| BackupError::WrongPassword)
}

/// Mac Greenwick `GWBK` v2.
fn open_gwbk(bytes: &[u8], password: &str) -> Result<Zeroizing<Vec<u8>>, BackupError> {
    const HEADER: usize = 4 + 1 + 4 + 1 + SALT_LEN;
    if bytes.len() < HEADER + BOX_OVERHEAD {
        return Err(BackupError::Damaged);
    }
    match bytes[4] {
        2 => {}
        v if v > 2 => return Err(BackupError::NewerVersion),
        _ => return Err(BackupError::Damaged),
    }
    let rounds = be_u32(&bytes[5..9]);
    if !(1..=10_000_000).contains(&rounds) || usize::from(bytes[9]) != SALT_LEN {
        return Err(BackupError::Damaged);
    }
    let key = crypto::pbkdf2_sha256(password.as_bytes(), &bytes[10..HEADER], rounds);
    crypto::open_box(&key, &bytes[..HEADER], &bytes[HEADER..])
        .map_err(|_| BackupError::WrongPassword)
}

/// Dojix 1.x `DOJX` and Greenwick `SJNL`: magic, 16-byte salt, box; 100,000 rounds, no AAD.
fn open_legacy(bytes: &[u8], password: &str) -> Result<Zeroizing<Vec<u8>>, BackupError> {
    const HEADER: usize = 4 + SALT_LEN;
    if bytes.len() < HEADER + BOX_OVERHEAD {
        return Err(BackupError::Damaged);
    }
    let key = crypto::pbkdf2_sha256(password.as_bytes(), &bytes[4..HEADER], LEGACY_ROUNDS);
    crypto::open_box(&key, &[], &bytes[HEADER..]).map_err(|_| BackupError::WrongPassword)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &str = "fixture-password-1";

    fn image() -> Vec<u8> {
        let mut v = SQLITE_MAGIC.to_vec();
        v.extend_from_slice(b"fictional backup image");
        v
    }

    fn unhex(s: &str) -> Vec<u8> {
        crypto::from_hex(s).unwrap()
    }

    #[test]
    fn desktop_backups_round_trip_and_bind_the_header() {
        let sealed = seal_desktop(&image(), PW, KdfParams::TEST_MIN).unwrap();
        assert_eq!(kind(&sealed), BackupKind::Desktop);
        assert_eq!(&sealed[..6], b"DXBK\x01\x01");
        assert_eq!(
            open(&sealed, Some(PW)).unwrap().as_slice(),
            image().as_slice()
        );
        assert_eq!(
            open(&sealed, Some("wrong-password")).unwrap_err(),
            BackupError::WrongPassword
        );
        assert_eq!(
            open(&sealed, None).unwrap_err(),
            BackupError::PasswordRequired
        );
        assert_eq!(
            open(&sealed, Some("")).unwrap_err(),
            BackupError::PasswordRequired
        );
        let mut salt = sealed.clone();
        salt[20] ^= 1;
        assert_eq!(
            open(&salt, Some(PW)).unwrap_err(),
            BackupError::WrongPassword
        );
        let mut newer = sealed.clone();
        newer[4] = 2;
        assert_eq!(
            open(&newer, Some(PW)).unwrap_err(),
            BackupError::NewerVersion
        );
        let mut hours = sealed.clone();
        hours[10..14].copy_from_slice(&1000u32.to_be_bytes());
        assert_eq!(open(&hours, Some(PW)).unwrap_err(), BackupError::Damaged);
        assert_eq!(
            open(&sealed[..40], Some(PW)).unwrap_err(),
            BackupError::Damaged
        );
    }

    #[test]
    fn plain_and_unknown_files() {
        assert_eq!(kind(&image()), BackupKind::Plain);
        assert_eq!(open(&image(), None).unwrap().as_slice(), image().as_slice());
        assert_eq!(kind(b"PK\x03\x04zip"), BackupKind::Unknown);
        assert_eq!(
            open(b"PK\x03\x04zip", Some(PW)).unwrap_err(),
            BackupError::NotABackup
        );
        assert_eq!(kind(b"ab"), BackupKind::Unknown);
    }

    /// Vectors made with an independent implementation (Python `cryptography` 48) from the
    /// formats documented above, password "fixture-password-1", fictional plaintext.
    #[test]
    fn mac_and_desktop_vectors_from_an_independent_implementation() {
        let plaintext = unhex(VECTOR_PLAINTEXT);
        for (name, hex, expected_kind) in [
            ("DJXB", VECTOR_DJXB, BackupKind::MacDojix),
            ("DOJX", VECTOR_DOJX, BackupKind::MacDojixLegacy),
            ("GWBK", VECTOR_GWBK, BackupKind::MacGreenwick),
            ("SJNL", VECTOR_SJNL, BackupKind::MacGreenwickLegacy),
            ("DXBK", VECTOR_DXBK, BackupKind::Desktop),
        ] {
            let bytes = unhex(hex);
            assert_eq!(kind(&bytes), expected_kind, "{name}");
            assert!(expected_kind.needs_password());
            assert_eq!(
                open(&bytes, Some(PW)).unwrap().as_slice(),
                plaintext.as_slice(),
                "{name}"
            );
            assert_eq!(
                open(&bytes, Some("not-the-password")).unwrap_err(),
                BackupError::WrongPassword,
                "{name}"
            );
        }
    }

    #[test]
    fn mac_headers_are_authenticated_and_round_counts_bounded() {
        // DJXB: the iteration count is part of the AAD and bounded.
        let djxb = unhex(VECTOR_DJXB);
        let mut t = djxb.clone();
        t[20] ^= 1; // salt
        assert_eq!(open(&t, Some(PW)).unwrap_err(), BackupError::WrongPassword);
        let mut t = djxb.clone();
        t[5..9].copy_from_slice(&999u32.to_be_bytes());
        assert_eq!(open(&t, Some(PW)).unwrap_err(), BackupError::Damaged);
        let mut t = djxb.clone();
        t[5..9].copy_from_slice(&10_000_001u32.to_be_bytes());
        assert_eq!(open(&t, Some(PW)).unwrap_err(), BackupError::Damaged);
        let mut t = djxb.clone();
        t[4] = 2;
        assert_eq!(open(&t, Some(PW)).unwrap_err(), BackupError::NewerVersion);
        // GWBK: salt length must be 16; rounds up to 10,000,000.
        let gwbk = unhex(VECTOR_GWBK);
        let mut t = gwbk.clone();
        t[9] = 15;
        assert_eq!(open(&t, Some(PW)).unwrap_err(), BackupError::Damaged);
        let mut t = gwbk.clone();
        t[5..9].copy_from_slice(&0u32.to_be_bytes());
        assert_eq!(open(&t, Some(PW)).unwrap_err(), BackupError::Damaged);
        let mut t = gwbk.clone();
        t[4] = 1;
        assert_eq!(open(&t, Some(PW)).unwrap_err(), BackupError::Damaged);
        // Legacy formats: a changed salt means a wrong key.
        let mut t = unhex(VECTOR_SJNL);
        t[6] ^= 1;
        assert_eq!(open(&t, Some(PW)).unwrap_err(), BackupError::WrongPassword);
    }

    const VECTOR_PLAINTEXT: &str =
        "53514c69746520666f726d617420330066696374696f6e616c206261636b757020696d616765";
    const VECTOR_DJXB: &str =
        "444a584201000003e8101112131415161718191a1b1c1d1e1f404142434445464748494a4b28b6928b433413868d9677f36a25414aad6877f83768b94a6e688f10fe17c20db595d9b63730354bc07e8d669cd74e801d97ba5fb579";
    const VECTOR_DOJX: &str =
        "444f4a58101112131415161718191a1b1c1d1e1f404142434445464748494a4b615b872b317f769a41bfe83af1e1515d81ff03513d05bdae6576118f30602285c9d0da4004c46f02e69c3dcc28e1394b06d97166eb9b";
    const VECTOR_GWBK: &str =
        "4757424b02000003e810101112131415161718191a1b1c1d1e1f404142434445464748494a4b28b6928b433413868d9677f36a25414aad6877f83768b94a6e688f10fe17c20db595d9b637303fdba00ba2ba43edc0b4eecb24add09a";
    const VECTOR_SJNL: &str =
        "534a4e4c101112131415161718191a1b1c1d1e1f404142434445464748494a4b615b872b317f769a41bfe83af1e1515d81ff03513d05bdae6576118f30602285c9d0da4004c46f02e69c3dcc28e1394b06d97166eb9b";
    const VECTOR_DXBK: &str =
        "4458424b0101000020000000000101101112131415161718191a1b1c1d1e1f404142434445464748494a4b8ac2cd0ab26979b91ab77c34a351028185b4e17a8cc07d6cb8898040130933f07a6f2a9341852e00cc5a4b3a1316ee37c14c15fd27b7";
}
