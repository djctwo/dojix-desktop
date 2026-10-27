//! The journal key in the vault (SPEC 6.4), the desktop counterpart of the Mac's
//! `DatabaseKeyVault` / `AppLockVault`:
//!
//! - App Lock off: the bare key is `database_encryption_key`.
//! - App Lock on: only `database_key_wrapped` exists:
//!
//! ```text
//! "DXKW" | version u8 (=1) | kdf id u8 (1 = Argon2id) | m KiB u32 | t u32 | p u8 | salt [16]
//!        | AES-256-GCM box of [current key, previous key?]   (the 31-byte header is the AAD)
//! ```
//!
//! Every transition writes the new form, reads it back, checks it unwraps to the same key(s),
//! and only then deletes the old form, so a crash never leaves no usable key. Two keys inside
//! the wrapped item mean a key rotation is still pending (SPEC 6.1 item 5).

use zeroize::Zeroizing;

use crate::crypto::{self, CryptoError, KdfParams, Kek, PasswordHeader, BOX_OVERHEAD, KEY_LEN};
use crate::seal::JournalKey;
use crate::vault::{Lookup, SecretStore, DATABASE_KEY, WRAPPED_KEY};

pub const WRAP_MAGIC: &[u8; 4] = b"DXKW";
pub const WRAP_VERSION: u8 = 1;

/// Total length of a wrapped item holding `keys` keys.
pub const fn wrapped_len(keys: usize) -> usize {
    PasswordHeader::LEN + BOX_OVERHEAD + KEY_LEN * keys
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyState {
    /// No key yet (first launch, or after "erase all").
    Empty,
    /// Bare key (App Lock off).
    Plain,
    /// Key wrapped with the App Lock password.
    Wrapped,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VaultError {
    /// The item exists but can't be read (fail closed).
    #[error("the key could not be read from the system keyring ({0})")]
    Unreadable(String),
    #[error("incorrect password")]
    WrongPassword,
    #[error("the stored key is damaged")]
    Corrupt,
    #[error("the key could not be saved in the system keyring ({0})")]
    StoreFailed(String),
    #[error("a key already exists")]
    KeyAlreadyExists,
    /// Two keys are stored: a rotation must finish before the key or password changes again.
    #[error("a key change is still being finished")]
    RotationPending,
    /// The vault accepted the new wrapped key but it couldn't be read back to check it.
    #[error("the new key was saved but could not be read back")]
    Unconfirmed,
    #[error("the operating system's random generator failed")]
    Random,
}

/// The keys inside the wrapped item: the current one, plus the previous one while a rotation
/// is pending.
pub struct UnwrappedKeys {
    pub current: JournalKey,
    pub previous: Option<JournalKey>,
}

/// A key-encryption key derived once per operation (one Argon2id run), used to write and then
/// verify the wrapped item.
pub struct Wrapper {
    header: PasswordHeader,
    kek: Kek,
}

impl Wrapper {
    /// Derives a new KEK from `password` with a fresh salt.
    pub fn new(password: &str, params: KdfParams) -> Result<Self, VaultError> {
        let salt = crypto::random_salt().map_err(|_| VaultError::Random)?;
        let header = PasswordHeader {
            magic: *WRAP_MAGIC,
            version: WRAP_VERSION,
            params,
            salt,
        };
        let kek = crypto::argon2id(password.as_bytes(), &salt, params).map_err(|e| match e {
            CryptoError::Random => VaultError::Random,
            _ => VaultError::Corrupt,
        })?;
        Ok(Self { header, kek })
    }

    fn seal(&self, keys: &[&JournalKey]) -> Result<Vec<u8>, VaultError> {
        let mut payload = Zeroizing::new(Vec::with_capacity(KEY_LEN * keys.len()));
        for key in keys {
            payload.extend_from_slice(key.as_bytes());
        }
        let header = self.header.to_bytes();
        let sealed =
            crypto::seal_box(&self.kek, &header, &payload).map_err(|_| VaultError::Random)?;
        let mut out = header.to_vec();
        out.extend_from_slice(&sealed);
        Ok(out)
    }
}

fn split_keys(raw: &[u8]) -> Result<UnwrappedKeys, VaultError> {
    match raw.len() {
        32 => Ok(UnwrappedKeys {
            current: JournalKey::from_bytes(raw).ok_or(VaultError::Corrupt)?,
            previous: None,
        }),
        64 => Ok(UnwrappedKeys {
            current: JournalKey::from_bytes(&raw[..32]).ok_or(VaultError::Corrupt)?,
            previous: Some(JournalKey::from_bytes(&raw[32..]).ok_or(VaultError::Corrupt)?),
        }),
        _ => Err(VaultError::Corrupt),
    }
}

/// Opens a wrapped item with a password (one Argon2id run with the item's own parameters).
pub fn open_wrapped(blob: &[u8], password: &str) -> Result<UnwrappedKeys, VaultError> {
    if blob.len() != wrapped_len(1) && blob.len() != wrapped_len(2) {
        return Err(VaultError::Corrupt);
    }
    let header =
        PasswordHeader::parse(blob, WRAP_MAGIC, WRAP_VERSION).map_err(|_| VaultError::Corrupt)?;
    let kek = crypto::argon2id(password.as_bytes(), &header.salt, header.params)
        .map_err(|_| VaultError::Corrupt)?;
    open_with_kek(blob, &kek)
}

fn open_with_kek(blob: &[u8], kek: &Kek) -> Result<UnwrappedKeys, VaultError> {
    if blob.len() < PasswordHeader::LEN {
        return Err(VaultError::Corrupt);
    }
    let (header, boxed) = blob.split_at(PasswordHeader::LEN);
    let raw = crypto::open_box(kek, header, boxed).map_err(|_| VaultError::WrongPassword)?;
    split_keys(&raw)
}

/// The vault operations on the journal key, over any [`SecretStore`].
pub struct KeyVault<'a> {
    store: &'a dyn SecretStore,
    params: KdfParams,
}

impl<'a> KeyVault<'a> {
    pub fn new(store: &'a dyn SecretStore, params: KdfParams) -> Self {
        Self { store, params }
    }

    /// The KDF parameters new wrapped items use.
    pub fn params(&self) -> KdfParams {
        self.params
    }

    /// nil when the item does not exist; an error when it exists but can't be read.
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultError> {
        match self.store.lookup(account) {
            Lookup::Found(v) => Ok(Some(v)),
            Lookup::Absent => Ok(None),
            Lookup::Failed(e) => Err(VaultError::Unreadable(e)),
        }
    }

    /// Wrapped wins over plain: a bare key left next to a wrapped one is a leftover of an
    /// interrupted Enable and is removed by [`Self::remove_plain_copy_if_wrapped`].
    pub fn state(&self) -> Result<KeyState, VaultError> {
        if self.read(WRAPPED_KEY)?.is_some() {
            return Ok(KeyState::Wrapped);
        }
        if self.read(DATABASE_KEY)?.is_some() {
            return Ok(KeyState::Plain);
        }
        Ok(KeyState::Empty)
    }

    /// The bare key, or `None` when there is none.
    pub fn plain_key(&self) -> Result<Option<JournalKey>, VaultError> {
        match self.read(DATABASE_KEY)? {
            None => Ok(None),
            Some(bytes) => JournalKey::from_bytes(&bytes)
                .map(Some)
                .ok_or(VaultError::Corrupt),
        }
    }

    /// Creates the first key. Refuses when any key already exists (or can't be read), so a
    /// real key is never replaced.
    pub fn create_plain_key(&self) -> Result<JournalKey, VaultError> {
        if self.state()? != KeyState::Empty {
            return Err(VaultError::KeyAlreadyExists);
        }
        let key = JournalKey::generate().map_err(|_| VaultError::Random)?;
        self.store_plain_unchecked(&key)?;
        Ok(key)
    }

    fn store_plain_unchecked(&self, key: &JournalKey) -> Result<(), VaultError> {
        self.store
            .write(DATABASE_KEY, key.as_bytes())
            .map_err(VaultError::StoreFailed)?;
        match self.read(DATABASE_KEY) {
            Ok(Some(back)) if crypto::ct_eq(&back, key.as_bytes()) => Ok(()),
            Ok(_) => Err(VaultError::StoreFailed(
                "the key did not read back".to_string(),
            )),
            Err(_) => Err(VaultError::Unconfirmed),
        }
    }

    /// The wrapped item's bytes, or `Corrupt` when there is none.
    fn wrapped_blob(&self) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        self.read(WRAPPED_KEY)?.ok_or(VaultError::Corrupt)
    }

    /// True when a wrapped item exists (without a password).
    pub fn has_wrapped(&self) -> Result<bool, VaultError> {
        Ok(self.read(WRAPPED_KEY)?.is_some())
    }

    /// Unwraps with the App Lock password.
    pub fn unwrap_keys(&self, password: &str) -> Result<UnwrappedKeys, VaultError> {
        open_wrapped(&self.wrapped_blob()?, password)
    }

    /// Two keys stored: a rotation not finished yet. Known from the length, without the
    /// password.
    pub fn has_pending_rotation(&self) -> Result<bool, VaultError> {
        Ok(self
            .read(WRAPPED_KEY)?
            .is_some_and(|blob| blob.len() == wrapped_len(2)))
    }

    /// Writes the wrapped item in place, reads it back and checks it opens to the same keys.
    fn write_wrapped(&self, keys: &[&JournalKey], wrapper: &Wrapper) -> Result<(), VaultError> {
        let blob = wrapper.seal(keys)?;
        self.store
            .write(WRAPPED_KEY, &blob)
            .map_err(VaultError::StoreFailed)?;
        let stored = match self.read(WRAPPED_KEY) {
            Ok(Some(stored)) => stored,
            Ok(None) => {
                return Err(VaultError::StoreFailed(
                    "the wrapped key did not read back".to_string(),
                ))
            }
            Err(_) => return Err(VaultError::Unconfirmed),
        };
        let opened = open_with_kek(&stored, &wrapper.kek)
            .map_err(|_| VaultError::StoreFailed("the wrapped key did not verify".to_string()))?;
        let mut same = crypto::ct_eq(opened.current.as_bytes(), keys[0].as_bytes());
        same &= match (opened.previous.as_ref(), keys.get(1)) {
            (None, None) => true,
            (Some(a), Some(b)) => crypto::ct_eq(a.as_bytes(), b.as_bytes()),
            _ => false,
        };
        if same {
            Ok(())
        } else {
            Err(VaultError::StoreFailed(
                "the wrapped key did not verify".to_string(),
            ))
        }
    }

    /// Step 1 of a rotation (App Lock turned on, password changed): a NEW key is stored
    /// wrapped with the password *together with* `old`, then the bare key is deleted. Until
    /// [`Self::finish_rotation`], files not yet re-sealed stay readable.
    /// Refuses while an earlier rotation is unfinished (its old key would be lost).
    pub fn begin_rotation(
        &self,
        old: &JournalKey,
        wrapper: &Wrapper,
    ) -> Result<JournalKey, VaultError> {
        if self.has_pending_rotation()? {
            return Err(VaultError::RotationPending);
        }
        let new = JournalKey::generate().map_err(|_| VaultError::Random)?;
        self.write_wrapped(&[&new, old], wrapper)?;
        if let Err(e) = self.store.delete(DATABASE_KEY) {
            // The wrapped item wins over a leftover bare key; it is removed later.
            log::warn!("could not remove the bare key yet: {e}");
        }
        Ok(new)
    }

    /// Last step of a rotation, once the journal and every file are sealed with `key`: only
    /// `key` stays stored (wrapped).
    pub fn finish_rotation(&self, key: &JournalKey, wrapper: &Wrapper) -> Result<(), VaultError> {
        self.write_wrapped(&[key], wrapper)?;
        if let Err(e) = self.store.delete(DATABASE_KEY) {
            log::warn!("could not remove a leftover bare key: {e}");
        }
        Ok(())
    }

    /// Turns App Lock off with a key just unwrapped with the password: store it bare, check it
    /// reads back, then remove the wrapped copy. Refuses while a rotation is unfinished, and
    /// when the store has no place for a bare key.
    pub fn store_plain(&self, key: &JournalKey) -> Result<(), VaultError> {
        if self.store.lock_required() {
            return Err(VaultError::StoreFailed(
                "App Lock can't be turned off without a system keyring".to_string(),
            ));
        }
        if self.has_pending_rotation()? {
            return Err(VaultError::RotationPending);
        }
        self.store_plain_unchecked(key)?;
        self.store
            .delete(WRAPPED_KEY)
            .map_err(VaultError::StoreFailed)
    }

    /// Wraps a brand-new key (no journal exists yet): used when App Lock is mandatory.
    pub fn create_wrapped_key(&self, wrapper: &Wrapper) -> Result<JournalKey, VaultError> {
        if self.state()? != KeyState::Empty {
            return Err(VaultError::KeyAlreadyExists);
        }
        let key = JournalKey::generate().map_err(|_| VaultError::Random)?;
        self.write_wrapped(&[&key], wrapper)?;
        Ok(key)
    }

    /// Removes a bare key left next to a wrapped one (an interrupted Enable).
    pub fn remove_plain_copy_if_wrapped(&self) {
        if matches!(self.has_wrapped(), Ok(true)) && matches!(self.read(DATABASE_KEY), Ok(Some(_)))
        {
            if let Err(e) = self.store.delete(DATABASE_KEY) {
                log::warn!("could not remove a leftover bare key: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::MemoryVault;

    const PW: &str = "fictional-pass-1";

    fn vault(store: &MemoryVault) -> KeyVault<'_> {
        KeyVault::new(store, KdfParams::TEST_MIN)
    }

    fn wrapper(pw: &str) -> Wrapper {
        Wrapper::new(pw, KdfParams::TEST_MIN).unwrap()
    }

    #[test]
    fn wrapped_items_have_the_documented_layout() {
        let key = JournalKey::from_bytes(&[5u8; 32]).unwrap();
        let blob = wrapper(PW).seal(&[&key]).unwrap();
        assert_eq!(blob.len(), wrapped_len(1));
        assert_eq!(&blob[0..4], b"DXKW");
        assert_eq!(blob[4], 1);
        assert_eq!(blob[5], 1);
        assert_eq!(&blob[6..10], &(8u32 * 1024).to_be_bytes());
        assert_eq!(&blob[10..14], &1u32.to_be_bytes());
        assert_eq!(blob[14], 1);
        let opened = open_wrapped(&blob, PW).unwrap();
        assert_eq!(opened.current.as_bytes(), key.as_bytes());
        assert!(opened.previous.is_none());
        assert!(matches!(
            open_wrapped(&blob, "other-password"),
            Err(VaultError::WrongPassword)
        ));
    }

    #[test]
    fn every_header_byte_is_authenticated() {
        let key = JournalKey::from_bytes(&[5u8; 32]).unwrap();
        let blob = wrapper(PW).seal(&[&key]).unwrap();
        // Changing the salt or a parameter (still in range) breaks the box.
        for i in [12usize, 20, 30] {
            let mut t = blob.clone();
            t[i] ^= 1;
            assert!(open_wrapped(&t, PW).is_err(), "byte {i}");
        }
        // Parameters out of range are refused before any work.
        let mut t = blob.clone();
        t[6..10].copy_from_slice(&0u32.to_be_bytes());
        assert!(matches!(open_wrapped(&t, PW), Err(VaultError::Corrupt)));
        assert!(matches!(
            open_wrapped(&blob[..40], PW),
            Err(VaultError::Corrupt)
        ));
    }

    #[test]
    fn first_key_is_plain_and_never_replaces_an_existing_one() {
        let store = MemoryVault::default();
        let v = vault(&store);
        assert_eq!(v.state().unwrap(), KeyState::Empty);
        let key = v.create_plain_key().unwrap();
        assert_eq!(v.state().unwrap(), KeyState::Plain);
        assert_eq!(v.plain_key().unwrap().unwrap().as_bytes(), key.as_bytes());
        assert!(matches!(
            v.create_plain_key(),
            Err(VaultError::KeyAlreadyExists)
        ));
    }

    #[test]
    fn an_unreadable_item_is_never_treated_as_absent() {
        let store = MemoryVault::default();
        let v = vault(&store);
        store.fail(WRAPPED_KEY);
        assert!(matches!(v.state(), Err(VaultError::Unreadable(_))));
        assert!(matches!(
            v.create_plain_key(),
            Err(VaultError::Unreadable(_))
        ));
        assert!(!store.contains(DATABASE_KEY));
        store.heal();
        store.fail(DATABASE_KEY);
        assert!(matches!(v.state(), Err(VaultError::Unreadable(_))));
        assert!(matches!(v.plain_key(), Err(VaultError::Unreadable(_))));
    }

    #[test]
    fn a_rotation_keeps_both_keys_until_it_is_finished() {
        let store = MemoryVault::default();
        let v = vault(&store);
        let old = v.create_plain_key().unwrap();
        let w = wrapper(PW);
        let new = v.begin_rotation(&old, &w).unwrap();
        assert_eq!(v.state().unwrap(), KeyState::Wrapped);
        assert!(!store.contains(DATABASE_KEY), "bare key removed");
        assert!(v.has_pending_rotation().unwrap());
        let keys = v.unwrap_keys(PW).unwrap();
        assert_eq!(keys.current.as_bytes(), new.as_bytes());
        assert_eq!(keys.previous.unwrap().as_bytes(), old.as_bytes());

        // A second rotation is refused while the first is pending.
        assert!(matches!(
            v.begin_rotation(&new, &wrapper("another-pass")),
            Err(VaultError::RotationPending)
        ));
        assert!(matches!(
            v.store_plain(&new),
            Err(VaultError::RotationPending)
        ));

        v.finish_rotation(&new, &w).unwrap();
        assert!(!v.has_pending_rotation().unwrap());
        let keys = v.unwrap_keys(PW).unwrap();
        assert_eq!(keys.current.as_bytes(), new.as_bytes());
        assert!(keys.previous.is_none());
    }

    #[test]
    fn a_failed_begin_changes_nothing() {
        let store = MemoryVault::default();
        let v = vault(&store);
        let old = v.create_plain_key().unwrap();
        store.fail_writes(WRAPPED_KEY);
        assert!(matches!(
            v.begin_rotation(&old, &wrapper(PW)),
            Err(VaultError::StoreFailed(_))
        ));
        assert_eq!(v.state().unwrap(), KeyState::Plain);
        assert_eq!(v.plain_key().unwrap().unwrap().as_bytes(), old.as_bytes());
    }

    #[test]
    fn disabling_stores_the_key_bare_then_drops_the_wrapped_copy() {
        let store = MemoryVault::default();
        let v = vault(&store);
        let old = v.create_plain_key().unwrap();
        let w = wrapper(PW);
        let new = v.begin_rotation(&old, &w).unwrap();
        v.finish_rotation(&new, &w).unwrap();
        let keys = v.unwrap_keys(PW).unwrap();
        v.store_plain(&keys.current).unwrap();
        assert_eq!(v.state().unwrap(), KeyState::Plain);
        assert!(!store.contains(WRAPPED_KEY));
        assert_eq!(v.plain_key().unwrap().unwrap().as_bytes(), new.as_bytes());
    }

    #[test]
    fn a_failed_bare_write_keeps_the_wrapped_key() {
        let store = MemoryVault::default();
        let v = vault(&store);
        let w = wrapper(PW);
        let key = v.create_wrapped_key(&w).unwrap();
        store.fail_writes(DATABASE_KEY);
        assert!(v.store_plain(&key).is_err());
        assert_eq!(v.state().unwrap(), KeyState::Wrapped);
    }

    #[test]
    fn a_leftover_bare_key_next_to_a_wrapped_one_is_removed() {
        let store = MemoryVault::default();
        let v = vault(&store);
        let old = v.create_plain_key().unwrap();
        // The bare key can't be deleted: the rotation still begins (the wrapped item wins).
        store.fail(DATABASE_KEY);
        let new = v.begin_rotation(&old, &wrapper(PW)).unwrap();
        store.heal();
        assert!(store.contains(DATABASE_KEY));
        assert_eq!(v.state().unwrap(), KeyState::Wrapped);
        v.remove_plain_copy_if_wrapped();
        assert!(!store.contains(DATABASE_KEY));
        assert_eq!(
            v.unwrap_keys(PW).unwrap().current.as_bytes(),
            new.as_bytes()
        );
    }
}
