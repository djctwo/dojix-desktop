//! Shared cryptography (SPEC 6.4, 6.8): AES-256-GCM boxes with associated data, Argon2id for
//! App Lock and desktop backups, and PBKDF2-SHA256 to read Mac backups.
//!
//! Every derived key and every decrypted secret lives in a `Zeroizing` buffer. Nothing here
//! logs or formats secret bytes.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;
pub const SALT_LEN: usize = 16;
/// Nonce + tag around every box.
pub const BOX_OVERHEAD: usize = NONCE_LEN + TAG_LEN;

/// KDF identifier stored in password headers.
pub const KDF_ARGON2ID: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    #[error("the operating system's random generator failed")]
    Random,
    #[error("encryption failed")]
    Encrypt,
    /// Wrong key or password, or a changed file: the two can't be told apart.
    #[error("decryption failed")]
    Decrypt,
    #[error("key derivation parameters are outside the accepted range")]
    BadParams,
}

/// A 256-bit key-encryption key derived from a password. Wiped when dropped.
pub type Kek = Zeroizing<[u8; KEY_LEN]>;

/// Fills `buf` from the OS CSPRNG.
pub fn random(buf: &mut [u8]) -> Result<(), CryptoError> {
    getrandom::fill(buf).map_err(|_| CryptoError::Random)
}

pub fn random_salt() -> Result<[u8; SALT_LEN], CryptoError> {
    let mut salt = [0u8; SALT_LEN];
    random(&mut salt)?;
    Ok(salt)
}

/// Constant-time equality for secrets of equal or different length.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// `nonce | ciphertext | tag` of `plaintext` under `key`, authenticating `aad`.
pub fn seal_box(key: &[u8; KEY_LEN], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut nonce = [0u8; NONCE_LEN];
    random(&mut nonce)?;
    seal_box_with_nonce(key, aad, plaintext, &nonce)
}

/// Deterministic variant for test vectors only. Never reuse a nonce with the same key.
pub fn seal_box_with_nonce(
    key: &[u8; KEY_LEN],
    aad: &[u8],
    plaintext: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Encrypt)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Opens a `nonce | ciphertext | tag` box.
pub fn open_box(
    key: &[u8; KEY_LEN],
    aad: &[u8],
    boxed: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if boxed.len() < BOX_OVERHEAD {
        return Err(CryptoError::Decrypt);
    }
    let (nonce, ciphertext) = boxed.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::Decrypt)
}

/// Argon2id parameters (SPEC 6.4): memory in KiB, passes, lanes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u8,
}

impl KdfParams {
    /// m = 64 MiB, t = 3, p = 1.
    pub const DEFAULT: KdfParams = KdfParams {
        m_kib: 64 * 1024,
        t: 3,
        p: 1,
    };
    /// The cheapest parameters still inside the accepted range. Tests only.
    pub const TEST_MIN: KdfParams = KdfParams {
        m_kib: 8 * 1024,
        t: 1,
        p: 1,
    };

    /// Refuses parameters a tampered item could use to ask for no work, or for hours of it:
    /// m 8–1024 MiB, t 1–20, p 1–8.
    pub fn is_sane(&self) -> bool {
        (8 * 1024..=1024 * 1024).contains(&self.m_kib)
            && (1..=20).contains(&self.t)
            && (1..=8).contains(&self.p)
    }
}

/// Argon2id(password, salt) → 32-byte key. Parameters outside the sane range are refused.
pub fn argon2id(password: &[u8], salt: &[u8], params: KdfParams) -> Result<Kek, CryptoError> {
    if !params.is_sane() {
        return Err(CryptoError::BadParams);
    }
    let argon_params =
        argon2::Params::new(params.m_kib, params.t, u32::from(params.p), Some(KEY_LEN))
            .map_err(|_| CryptoError::BadParams)?;
    let argon = argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon_params,
    );
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password, salt, out.as_mut())
        .map_err(|_| CryptoError::BadParams)?;
    Ok(out)
}

/// PBKDF2-HMAC-SHA256(password, salt, rounds) → 32-byte key. Used only to read Mac backups.
pub fn pbkdf2_sha256(password: &[u8], salt: &[u8], rounds: u32) -> Kek {
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password, salt, rounds, out.as_mut());
    out
}

/// SHA-256 of `bytes`.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).into()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

/// The password header shared by wrapped keys (`DXKW`) and desktop backups (`DXBK`):
///
/// ```text
/// magic [4] | version u8 | kdf id u8 (1 = Argon2id) | m KiB u32 BE | t u32 BE | p u8 | salt [16]
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PasswordHeader {
    pub magic: [u8; 4],
    pub version: u8,
    pub params: KdfParams,
    pub salt: [u8; SALT_LEN],
}

/// Why a password header could not be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderError {
    /// Wrong magic or too short.
    NotThisFormat,
    /// A version this build doesn't know (newer).
    NewerVersion,
    /// Unknown KDF, or parameters outside the sane range.
    Damaged,
}

impl PasswordHeader {
    pub const LEN: usize = 4 + 1 + 1 + 4 + 4 + 1 + SALT_LEN;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut h = [0u8; Self::LEN];
        h[0..4].copy_from_slice(&self.magic);
        h[4] = self.version;
        h[5] = KDF_ARGON2ID;
        h[6..10].copy_from_slice(&self.params.m_kib.to_be_bytes());
        h[10..14].copy_from_slice(&self.params.t.to_be_bytes());
        h[14] = self.params.p;
        h[15..31].copy_from_slice(&self.salt);
        h
    }

    /// Parses and checks a header for `magic`, accepting versions up to `max_version`.
    pub fn parse(bytes: &[u8], magic: &[u8; 4], max_version: u8) -> Result<Self, HeaderError> {
        if bytes.len() < Self::LEN || &bytes[0..4] != magic {
            return Err(HeaderError::NotThisFormat);
        }
        let version = bytes[4];
        if version == 0 {
            return Err(HeaderError::Damaged);
        }
        if version > max_version {
            return Err(HeaderError::NewerVersion);
        }
        if bytes[5] != KDF_ARGON2ID {
            return Err(HeaderError::Damaged);
        }
        let m_kib = u32::from_be_bytes(bytes[6..10].try_into().expect("4 bytes"));
        let t = u32::from_be_bytes(bytes[10..14].try_into().expect("4 bytes"));
        let params = KdfParams {
            m_kib,
            t,
            p: bytes[14],
        };
        if !params.is_sane() {
            return Err(HeaderError::Damaged);
        }
        let mut salt = [0u8; SALT_LEN];
        salt.copy_from_slice(&bytes[15..31]);
        Ok(Self {
            magic: *magic,
            version,
            params,
            salt,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boxes_round_trip_and_authenticate_the_associated_data() {
        let key = [7u8; KEY_LEN];
        let sealed = seal_box(&key, b"header", b"fictional payload").unwrap();
        assert_eq!(sealed.len(), b"fictional payload".len() + BOX_OVERHEAD);
        assert_eq!(
            open_box(&key, b"header", &sealed).unwrap().as_slice(),
            b"fictional payload"
        );
        assert_eq!(
            open_box(&key, b"headeR", &sealed).unwrap_err(),
            CryptoError::Decrypt
        );
        assert_eq!(
            open_box(&[8u8; KEY_LEN], b"header", &sealed).unwrap_err(),
            CryptoError::Decrypt
        );
        assert_eq!(
            open_box(&key, b"header", &sealed[..10]).unwrap_err(),
            CryptoError::Decrypt
        );
    }

    /// RFC 9106 style check: an independent implementation (Python `cryptography` 48,
    /// Argon2id, m = 8192 KiB, t = 1, p = 1, 32-byte output) gave this value for the
    /// fictional password "fixture-password-1" and the salt 00 01 .. 0f.
    #[test]
    fn argon2id_matches_an_independent_implementation() {
        let salt: Vec<u8> = (0u8..16).collect();
        let key = argon2id(b"fixture-password-1", &salt, KdfParams::TEST_MIN).unwrap();
        assert_eq!(hex(key.as_ref()), ARGON2ID_VECTOR);
    }

    /// PBKDF2-HMAC-SHA256, 1,000 rounds, same password and salt (Python `hashlib`).
    #[test]
    fn pbkdf2_matches_an_independent_implementation() {
        let salt: Vec<u8> = (0u8..16).collect();
        let key = pbkdf2_sha256(b"fixture-password-1", &salt, 1_000);
        assert_eq!(hex(key.as_ref()), PBKDF2_VECTOR);
    }

    #[test]
    fn kdf_parameters_outside_the_range_are_refused() {
        let salt = [0u8; SALT_LEN];
        for bad in [
            KdfParams {
                m_kib: 1024,
                t: 1,
                p: 1,
            },
            KdfParams {
                m_kib: 2 * 1024 * 1024,
                t: 1,
                p: 1,
            },
            KdfParams {
                m_kib: 8192,
                t: 0,
                p: 1,
            },
            KdfParams {
                m_kib: 8192,
                t: 21,
                p: 1,
            },
            KdfParams {
                m_kib: 8192,
                t: 1,
                p: 9,
            },
        ] {
            assert_eq!(
                argon2id(b"pw", &salt, bad).unwrap_err(),
                CryptoError::BadParams
            );
        }
        assert!(KdfParams::DEFAULT.is_sane());
        assert!(KdfParams::TEST_MIN.is_sane());
    }

    #[test]
    fn password_headers_round_trip_and_reject_tampering() {
        let header = PasswordHeader {
            magic: *b"DXBK",
            version: 1,
            params: KdfParams::DEFAULT,
            salt: [9u8; SALT_LEN],
        };
        let bytes = header.to_bytes();
        assert_eq!(bytes.len(), 31);
        assert_eq!(PasswordHeader::parse(&bytes, b"DXBK", 1), Ok(header));
        assert_eq!(
            PasswordHeader::parse(&bytes, b"DXKW", 1),
            Err(HeaderError::NotThisFormat)
        );
        let mut newer = bytes;
        newer[4] = 2;
        assert_eq!(
            PasswordHeader::parse(&newer, b"DXBK", 1),
            Err(HeaderError::NewerVersion)
        );
        let mut kdf = bytes;
        kdf[5] = 2;
        assert_eq!(
            PasswordHeader::parse(&kdf, b"DXBK", 1),
            Err(HeaderError::Damaged)
        );
        let mut no_work = bytes;
        no_work[6..10].copy_from_slice(&16u32.to_be_bytes());
        assert_eq!(
            PasswordHeader::parse(&no_work, b"DXBK", 1),
            Err(HeaderError::Damaged)
        );
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(hex(&[0, 255, 16]), "00ff10");
        assert_eq!(from_hex("00ff10"), Some(vec![0, 255, 16]));
        assert_eq!(from_hex("0"), None);
        assert_eq!(from_hex("zz"), None);
    }

    #[test]
    fn constant_time_equality() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }

    const ARGON2ID_VECTOR: &str =
        "ae7030e8810a3ea5c18e87b20fe51910af871db8195671371b8a81cb15fb63b6";
    const PBKDF2_VECTOR: &str = "054717d1aa76c7ebaca1ca72b1b1ee23f5ba74bc29ac676acd4a9bbbb0ca39ce";
}
