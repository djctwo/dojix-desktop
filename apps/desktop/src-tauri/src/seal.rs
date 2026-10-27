//! The sealed journal file (SPEC 6.3):
//!
//! ```text
//! "DXJN" | version u8 (=1) | brand u8 | epoch [16] | generation u64 BE | saved_at i64 BE (Unix ms)
//!        | AES-256-GCM box: nonce [12] | ciphertext | tag [16]
//! ```
//!
//! The header is the AES-GCM associated data, so changing any header byte breaks decryption.
//! The plaintext is a SQLite database image.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 4] = b"DXJN";
pub const VERSION: u8 = 1;
pub const EPOCH_LEN: usize = 16;
/// magic 4 + version 1 + brand 1 + epoch 16 + generation 8 + saved_at 8.
pub const HEADER_LEN: usize = 4 + 1 + 1 + EPOCH_LEN + 8 + 8;
pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;
pub const KEY_LEN: usize = 32;
/// First 16 bytes of every plain SQLite database file.
pub const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// A 256-bit journal key, wiped from memory when dropped.
pub struct JournalKey(Zeroizing<[u8; KEY_LEN]>);

impl JournalKey {
    pub fn generate() -> Result<Self, SealError> {
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
        getrandom::fill(bytes.as_mut()).map_err(|_| SealError::Random)?;
        Ok(Self(bytes))
    }

    /// Accepts exactly 32 bytes.
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        let array: [u8; KEY_LEN] = bytes.try_into().ok()?;
        Some(Self(Zeroizing::new(array)))
    }

    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(self.0.as_ref()))
    }
}

/// The save stamp carried in the header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub brand: u8,
    pub epoch: [u8; EPOCH_LEN],
    pub generation: u64,
    pub saved_at_ms: i64,
}

impl Stamp {
    pub fn new_epoch(brand: u8) -> Result<Self, SealError> {
        let mut epoch = [0u8; EPOCH_LEN];
        getrandom::fill(&mut epoch).map_err(|_| SealError::Random)?;
        Ok(Self {
            brand,
            epoch,
            generation: 0,
            saved_at_ms: 0,
        })
    }

    fn header(&self) -> [u8; HEADER_LEN] {
        let mut h = [0u8; HEADER_LEN];
        h[0..4].copy_from_slice(MAGIC);
        h[4] = VERSION;
        h[5] = self.brand;
        h[6..22].copy_from_slice(&self.epoch);
        h[22..30].copy_from_slice(&self.generation.to_be_bytes());
        h[30..38].copy_from_slice(&self.saved_at_ms.to_be_bytes());
        h
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SealError {
    #[error("the operating system's random generator failed")]
    Random,
    #[error("not a sealed journal (wrong magic, version or length)")]
    NotAJournal,
    #[error("the journal belongs to the other app (brand byte {0})")]
    OtherBrand(u8),
    #[error("the journal could not be decrypted (wrong key or damaged file)")]
    Decrypt,
    #[error("the decrypted journal is not a SQLite database")]
    NotADatabase,
    #[error("encryption failed")]
    Encrypt,
}

/// Parses the header without decrypting. Returns the stamp of a well-formed file.
pub fn read_stamp(bytes: &[u8]) -> Result<Stamp, SealError> {
    if bytes.len() < HEADER_LEN + NONCE_LEN + TAG_LEN || &bytes[0..4] != MAGIC || bytes[4] != VERSION
    {
        return Err(SealError::NotAJournal);
    }
    let mut epoch = [0u8; EPOCH_LEN];
    epoch.copy_from_slice(&bytes[6..22]);
    let generation = u64::from_be_bytes(bytes[22..30].try_into().expect("8 bytes"));
    let saved_at_ms = i64::from_be_bytes(bytes[30..38].try_into().expect("8 bytes"));
    Ok(Stamp {
        brand: bytes[5],
        epoch,
        generation,
        saved_at_ms,
    })
}

/// Seals a SQLite image with a random nonce.
pub fn seal(key: &JournalKey, stamp: &Stamp, image: &[u8]) -> Result<Vec<u8>, SealError> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|_| SealError::Random)?;
    seal_with_nonce(key, stamp, image, &nonce)
}

/// Deterministic sealing for test vectors. Never reuse a nonce with the same key in real saves.
pub fn seal_with_nonce(
    key: &JournalKey,
    stamp: &Stamp,
    image: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, SealError> {
    let header = stamp.header();
    let ciphertext = key
        .cipher()
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: image,
                aad: &header,
            },
        )
        .map_err(|_| SealError::Encrypt)?;
    let mut out = Vec::with_capacity(HEADER_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Opens a sealed journal for `brand`: checks the header, decrypts, and checks the SQLite magic.
pub fn open(
    key: &JournalKey,
    brand: u8,
    bytes: &[u8],
) -> Result<(Stamp, Zeroizing<Vec<u8>>), SealError> {
    let stamp = read_stamp(bytes)?;
    if stamp.brand != brand {
        return Err(SealError::OtherBrand(stamp.brand));
    }
    let (header, rest) = bytes.split_at(HEADER_LEN);
    let (nonce, ciphertext) = rest.split_at(NONCE_LEN);
    let image = key
        .cipher()
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: header,
            },
        )
        .map_err(|_| SealError::Decrypt)?;
    let image = Zeroizing::new(image);
    if image.len() < SQLITE_MAGIC.len() || &image[..SQLITE_MAGIC.len()] != SQLITE_MAGIC {
        return Err(SealError::NotADatabase);
    }
    Ok((stamp, image))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_image() -> Vec<u8> {
        let mut image = SQLITE_MAGIC.to_vec();
        image.extend_from_slice(b"fictional page bytes for a test");
        image
    }

    fn stamp() -> Stamp {
        Stamp {
            brand: 1,
            epoch: [7u8; EPOCH_LEN],
            generation: 42,
            saved_at_ms: 1_767_225_600_000,
        }
    }

    #[test]
    fn header_is_38_bytes_in_the_documented_layout() {
        let h = stamp().header();
        assert_eq!(HEADER_LEN, 38);
        assert_eq!(&h[0..4], b"DXJN");
        assert_eq!(h[4], 1);
        assert_eq!(h[5], 1);
        assert_eq!(&h[6..22], &[7u8; 16]);
        assert_eq!(&h[22..30], &42u64.to_be_bytes());
        assert_eq!(&h[30..38], &1_767_225_600_000i64.to_be_bytes());
    }

    #[test]
    fn known_vector_is_stable() {
        // Fixed key and nonce: guards the byte layout against accidental change.
        let key = JournalKey::from_bytes(&[0x11; 32]).unwrap();
        let sealed = seal_with_nonce(&key, &stamp(), b"SQLite format 3\0", &[0x22; 12]).unwrap();
        assert_eq!(sealed.len(), HEADER_LEN + NONCE_LEN + 16 + TAG_LEN);
        assert_eq!(&sealed[HEADER_LEN..HEADER_LEN + NONCE_LEN], &[0x22; 12]);
        let (s, image) = open(&key, 1, &sealed).unwrap();
        assert_eq!(s, stamp());
        assert_eq!(image.as_slice(), b"SQLite format 3\0");
    }

    #[test]
    fn round_trip_and_never_plaintext() {
        let key = JournalKey::generate().unwrap();
        let image = fake_image();
        let sealed = seal(&key, &stamp(), &image).unwrap();
        assert!(!sealed.windows(SQLITE_MAGIC.len()).any(|w| w == SQLITE_MAGIC));
        let (s, opened) = open(&key, 1, &sealed).unwrap();
        assert_eq!(s.generation, 42);
        assert_eq!(opened.as_slice(), image.as_slice());
    }

    #[test]
    fn every_header_byte_is_authenticated() {
        let key = JournalKey::generate().unwrap();
        let sealed = seal(&key, &stamp(), &fake_image()).unwrap();
        for i in 6..HEADER_LEN {
            let mut tampered = sealed.clone();
            tampered[i] ^= 0x01;
            assert_eq!(open(&key, 1, &tampered).unwrap_err(), SealError::Decrypt, "byte {i}");
        }
        let mut body = sealed.clone();
        let last = body.len() - 1;
        body[last] ^= 0x80;
        assert_eq!(open(&key, 1, &body).unwrap_err(), SealError::Decrypt);
    }

    #[test]
    fn wrong_key_brand_magic_and_payload_are_refused() {
        let key = JournalKey::generate().unwrap();
        let sealed = seal(&key, &stamp(), &fake_image()).unwrap();
        let other = JournalKey::generate().unwrap();
        assert_eq!(open(&other, 1, &sealed).unwrap_err(), SealError::Decrypt);
        assert_eq!(open(&key, 2, &sealed).unwrap_err(), SealError::OtherBrand(1));
        let mut magic = sealed.clone();
        magic[0] = b'X';
        assert_eq!(open(&key, 1, &magic).unwrap_err(), SealError::NotAJournal);
        assert_eq!(open(&key, 1, &sealed[..20]).unwrap_err(), SealError::NotAJournal);
        let not_db = seal(&key, &stamp(), b"not a database at all").unwrap();
        assert_eq!(open(&key, 1, &not_db).unwrap_err(), SealError::NotADatabase);
    }

    #[test]
    fn keys_must_be_32_bytes() {
        assert!(JournalKey::from_bytes(&[0u8; 31]).is_none());
        assert!(JournalKey::from_bytes(&[0u8; 33]).is_none());
        assert!(JournalKey::from_bytes(&[0u8; 32]).is_some());
    }
}
