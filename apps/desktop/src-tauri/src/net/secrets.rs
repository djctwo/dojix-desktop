//! The user's API keys in the OS credential vault (SPEC 6.4, 8.1).
//!
//! The web view can store, test for and delete a key, never read one: [`set`], [`has`],
//! [`delete`] and [`status`] return no secret, and [`read`] is crate-private (only the
//! provider clients in this module tree call it, and they put the key in a request header).

use std::collections::BTreeMap;

use zeroize::Zeroizing;

use crate::vault::{Lookup, SecretStore};

use super::NetError;

pub const ANTHROPIC: &str = "anthropic_api_key";
pub const TWELVE_DATA: &str = "twelve_data_api_key";
pub const POLYGON: &str = "polygon_api_key";
pub const OANDA_TOKEN: &str = "oanda_api_token";
pub const OANDA_ACCOUNT: &str = "oanda_account_id";
pub const FINNHUB: &str = "finnhub_api_key";

const DOJIX_ACCOUNTS: &[&str] = &[ANTHROPIC, TWELVE_DATA, POLYGON, OANDA_TOKEN, OANDA_ACCOUNT];
const GREENWICK_ACCOUNTS: &[&str] = &[ANTHROPIC, FINNHUB];

/// The longest key accepted. Real keys are well under 200 characters.
pub const MAX_SECRET_LEN: usize = 512;

/// The accounts a brand uses (SPEC 6.4 "brand-dependent").
pub fn accounts_for(brand_id: &str) -> &'static [&'static str] {
    match brand_id {
        "dojix" => DOJIX_ACCOUNTS,
        "greenwick" => GREENWICK_ACCOUNTS,
        _ => &[],
    }
}

/// A human name for an account, for messages.
pub fn label(account: &str) -> &'static str {
    match account {
        ANTHROPIC => "Anthropic API key",
        TWELVE_DATA => "Twelve Data API key",
        POLYGON => "Polygon.io API key",
        OANDA_TOKEN => "OANDA API token",
        OANDA_ACCOUNT => "OANDA account ID",
        FINNHUB => "Finnhub API key",
        _ => "key",
    }
}

fn known(brand_id: &str, account: &str) -> Result<(), NetError> {
    if accounts_for(brand_id).contains(&account) {
        Ok(())
    } else {
        Err(NetError::invalid("Unknown key name."))
    }
}

/// OANDA account IDs: letters, digits and dashes, 1–64 (`OANDAService.isValidAccountID`).
pub fn valid_oanda_account(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Trims and checks a value before it is stored: printable ASCII without spaces (every
/// provider's keys are), at most [`MAX_SECRET_LEN`]; account IDs by their own rule.
pub fn validate(account: &str, value: &str) -> Result<Zeroizing<String>, NetError> {
    let value = Zeroizing::new(value.trim().to_string());
    if value.is_empty() {
        return Err(NetError::invalid("Enter a value first."));
    }
    if value.len() > MAX_SECRET_LEN || !value.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(NetError::invalid(
            "That doesn't look like a key: use letters, digits and symbols only, no spaces.",
        ));
    }
    if account == OANDA_ACCOUNT && !valid_oanda_account(&value) {
        return Err(NetError::invalid(
            "An OANDA account ID has letters, digits and dashes only (e.g. 101-004-1234567-001).",
        ));
    }
    Ok(value)
}

fn vault_error(reason: &str) -> NetError {
    log::warn!("credential vault: {reason}");
    NetError::new(
        "vault",
        "The system keyring could not be used. Check that it is unlocked and try again.",
    )
}

/// Stores a key (replacing any earlier one). Returns nothing about it.
pub fn set(
    store: &dyn SecretStore,
    brand_id: &str,
    account: &str,
    value: &str,
) -> Result<(), NetError> {
    known(brand_id, account)?;
    let value = validate(account, value)?;
    if store.lock_required() {
        // The data-folder store (Linux without a Secret Service) refuses API keys: they would
        // otherwise sit on disk unencrypted (SPEC 6.4).
        return Err(NetError::new(
            "vault",
            "API keys need the system keyring (Secret Service), which isn't available here.",
        ));
    }
    store
        .write(account, value.as_bytes())
        .map_err(|e| vault_error(&e))
}

/// True when the key is stored. A vault that can't answer is an error, not "absent".
pub fn has(store: &dyn SecretStore, brand_id: &str, account: &str) -> Result<bool, NetError> {
    known(brand_id, account)?;
    match store.lookup(account) {
        Lookup::Found(v) => Ok(!v.is_empty()),
        Lookup::Absent => Ok(false),
        Lookup::Failed(e) => Err(vault_error(&e)),
    }
}

pub fn delete(store: &dyn SecretStore, brand_id: &str, account: &str) -> Result<(), NetError> {
    known(brand_id, account)?;
    store.delete(account).map_err(|e| vault_error(&e))
}

/// Which of the brand's keys are stored (`false` when the vault can't answer).
pub fn status(store: &dyn SecretStore, brand_id: &str) -> BTreeMap<String, bool> {
    accounts_for(brand_id)
        .iter()
        .map(|a| {
            (
                a.to_string(),
                matches!(store.lookup(a), Lookup::Found(ref v) if !v.is_empty()),
            )
        })
        .collect()
}

/// Reads a key for a request header. Crate-private: no IPC command returns its result.
pub(crate) fn read(
    store: &dyn SecretStore,
    account: &str,
) -> Result<Option<Zeroizing<String>>, NetError> {
    match store.lookup(account) {
        Lookup::Found(bytes) => {
            let text = String::from_utf8(bytes.to_vec()).map_err(|_| vault_error("not UTF-8"))?;
            let text = Zeroizing::new(text);
            Ok(if text.is_empty() { None } else { Some(text) })
        }
        Lookup::Absent => Ok(None),
        Lookup::Failed(e) => Err(vault_error(&e)),
    }
}

/// [`read`], with "no key" as an error naming the key.
pub(crate) fn require(
    store: &dyn SecretStore,
    account: &str,
) -> Result<Zeroizing<String>, NetError> {
    read(store, account)?.ok_or_else(|| NetError::no_key(label(account)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{FolderVault, MemoryVault};

    #[test]
    fn brands_use_their_own_accounts() {
        assert!(accounts_for("dojix").contains(&TWELVE_DATA));
        assert!(!accounts_for("dojix").contains(&FINNHUB));
        assert_eq!(accounts_for("greenwick"), &[ANTHROPIC, FINNHUB]);
        assert!(accounts_for("other").is_empty());
        for a in accounts_for("dojix")
            .iter()
            .chain(accounts_for("greenwick"))
        {
            assert!(crate::vault::API_KEYS.contains(a), "erase covers {a}");
            assert_ne!(label(a), "key");
        }
        assert_eq!(label("x"), "key");
    }

    #[test]
    fn set_has_delete_round_trip_and_never_return_the_value() {
        let v = MemoryVault::default();
        assert!(!has(&v, "dojix", ANTHROPIC).unwrap());
        set(&v, "dojix", ANTHROPIC, "  sk-fictional-key-0001  ").unwrap();
        assert!(has(&v, "dojix", ANTHROPIC).unwrap());
        assert_eq!(
            require(&v, ANTHROPIC).unwrap().as_str(),
            "sk-fictional-key-0001"
        );
        let st = status(&v, "dojix");
        assert_eq!(st.get(ANTHROPIC), Some(&true));
        assert_eq!(st.get(TWELVE_DATA), Some(&false));
        delete(&v, "dojix", ANTHROPIC).unwrap();
        assert!(!has(&v, "dojix", ANTHROPIC).unwrap());
        assert_eq!(require(&v, ANTHROPIC).unwrap_err().code, "no_key");
    }

    #[test]
    fn values_and_names_are_validated() {
        let v = MemoryVault::default();
        assert_eq!(set(&v, "dojix", FINNHUB, "k").unwrap_err().code, "invalid");
        assert_eq!(
            set(&v, "greenwick", "database_encryption_key", "k")
                .unwrap_err()
                .code,
            "invalid"
        );
        assert_eq!(
            set(&v, "dojix", ANTHROPIC, "   ").unwrap_err().code,
            "invalid"
        );
        assert_eq!(
            set(&v, "dojix", ANTHROPIC, "has space").unwrap_err().code,
            "invalid"
        );
        assert_eq!(
            set(&v, "dojix", ANTHROPIC, "ключ").unwrap_err().code,
            "invalid"
        );
        let long = "k".repeat(MAX_SECRET_LEN + 1);
        assert_eq!(
            set(&v, "dojix", ANTHROPIC, &long).unwrap_err().code,
            "invalid"
        );
        assert_eq!(
            set(&v, "dojix", OANDA_ACCOUNT, "101/004").unwrap_err().code,
            "invalid"
        );
        set(&v, "dojix", OANDA_ACCOUNT, "101-004-1234567-001").unwrap();
        assert!(valid_oanda_account("A-1"));
        assert!(!valid_oanda_account(""));
        assert!(!valid_oanda_account(&"1".repeat(65)));
        assert_eq!(has(&v, "dojix", "nope").unwrap_err().code, "invalid");
        assert_eq!(delete(&v, "dojix", "nope").unwrap_err().code, "invalid");
    }

    #[test]
    fn vault_failures_are_errors_never_absent() {
        let v = MemoryVault::default();
        v.fail(ANTHROPIC);
        assert_eq!(has(&v, "dojix", ANTHROPIC).unwrap_err().code, "vault");
        assert_eq!(read(&v, ANTHROPIC).unwrap_err().code, "vault");
        assert_eq!(
            set(&v, "dojix", ANTHROPIC, "abcd").unwrap_err().code,
            "vault"
        );
        assert_eq!(delete(&v, "dojix", ANTHROPIC).unwrap_err().code, "vault");
        assert_eq!(status(&v, "dojix").get(ANTHROPIC), Some(&false));
    }

    #[test]
    fn folder_vault_refuses_api_keys() {
        let tmp = tempfile::tempdir().unwrap();
        let v = FolderVault::new(tmp.path());
        let e = set(&v, "dojix", ANTHROPIC, "sk-fictional").unwrap_err();
        assert_eq!(e.code, "vault");
        assert!(read(&v, ANTHROPIC).unwrap().is_none());
    }

    #[test]
    fn an_empty_or_non_utf8_item_reads_as_absent_or_error() {
        let v = MemoryVault::default();
        v.write(ANTHROPIC, b"").unwrap();
        assert!(read(&v, ANTHROPIC).unwrap().is_none());
        v.write(ANTHROPIC, &[0xff, 0xfe]).unwrap();
        assert_eq!(read(&v, ANTHROPIC).unwrap_err().code, "vault");
    }
}
