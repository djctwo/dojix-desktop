//! Build-time brand. Exactly one of the Cargo features `brand-dojix` / `brand-greenwick` is on.

#[cfg(all(feature = "brand-dojix", feature = "brand-greenwick"))]
compile_error!("Enable exactly one brand feature, not both.");

#[cfg(not(any(feature = "brand-dojix", feature = "brand-greenwick")))]
compile_error!("Enable a brand: --features brand-dojix or --features brand-greenwick.");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Brand {
    pub id: &'static str,
    pub product_name: &'static str,
    /// Reverse-DNS identifier: vault service name and data folder name.
    /// Deliberately different from the Mac apps' bundle IDs.
    pub identifier: &'static str,
    /// Environment variable that overrides the data folder (like `--data-dir`).
    pub data_dir_env: &'static str,
    /// Brand byte in the sealed journal header (1 Dojix, 2 Greenwick).
    pub journal_byte: u8,
}

pub const DOJIX: Brand = Brand {
    id: "dojix",
    product_name: "Dojix",
    identifier: "io.github.djctwo.dojix",
    data_dir_env: "DOJIX_DATA_DIR",
    journal_byte: 1,
};

pub const GREENWICK: Brand = Brand {
    id: "greenwick",
    product_name: "Greenwick",
    identifier: "io.github.djctwo.greenwick",
    data_dir_env: "GREENWICK_DATA_DIR",
    journal_byte: 2,
};

#[cfg(feature = "brand-dojix")]
pub const CURRENT: Brand = DOJIX;

#[cfg(all(feature = "brand-greenwick", not(feature = "brand-dojix")))]
pub const CURRENT: Brand = GREENWICK;

#[cfg(test)]
mod tests {
    use super::*;

    fn overlay(brand: &Brand) -> serde_json::Value {
        let path = format!("{}/tauri.{}.conf.json", env!("CARGO_MANIFEST_DIR"), brand.id);
        let text = std::fs::read_to_string(path).expect("brand overlay exists");
        serde_json::from_str(&text).expect("brand overlay is JSON")
    }

    #[test]
    fn overlays_match_the_brand_constants() {
        for brand in [DOJIX, GREENWICK] {
            let conf = overlay(&brand);
            assert_eq!(conf["identifier"], brand.identifier);
            assert_eq!(conf["productName"], brand.product_name);
            assert_eq!(conf["mainBinaryName"], brand.id);
        }
    }

    #[test]
    fn identifiers_never_reuse_the_mac_bundle_ids() {
        for brand in [DOJIX, GREENWICK] {
            assert!(!["com.dojix.app", "com.greenwick.app"].contains(&brand.identifier));
        }
        assert_ne!(DOJIX.identifier, GREENWICK.identifier);
        assert_ne!(DOJIX.data_dir_env, GREENWICK.data_dir_env);
        assert_eq!((DOJIX.journal_byte, GREENWICK.journal_byte), (1, 2));
    }
}
