//! `--self-test` (SPEC 9.3): vault reachable, data folder protected, lock file takeable, and a
//! seal → open round trip in memory. Prints one JSON line and exits 0 (all passed) or 1.
//! It never opens the user's journal, and its output holds no paths or secrets.

use serde::Serialize;

use crate::brand::Brand;
use crate::instance::{self, LockOutcome};
use crate::journal::{self, SCHEMA_VERSION};
use crate::paths::DataPaths;
use crate::vault::{self, SecretStore};

#[derive(Debug, Serialize)]
pub struct Check {
    pub name: &'static str,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub ok: bool,
    pub brand: &'static str,
    pub version: &'static str,
    pub data_dir: &'static str,
    pub vault: &'static str,
    pub checks: Vec<Check>,
}

fn check(name: &'static str, result: Result<Option<String>, String>) -> Check {
    match result {
        Ok(detail) => Check {
            name,
            ok: true,
            detail,
        },
        Err(detail) => Check {
            name,
            ok: false,
            detail: Some(detail),
        },
    }
}

pub fn run(brand: &Brand, paths: &DataPaths, vault: &dyn SecretStore) -> Report {
    let mut checks = Vec::new();

    checks.push(check(
        "vault",
        vault::probe(vault).map(|()| Some(vault.backend().to_string())),
    ));

    checks.push(check(
        "data_folder",
        paths
            .ensure()
            .and_then(|_| paths.is_private())
            .map_err(|e| e.to_string())
            .and_then(|private| {
                if private {
                    Ok(Some(if cfg!(windows) {
                        "protected DACL".to_string()
                    } else {
                        "mode 0700".to_string()
                    }))
                } else {
                    Err("data folder is not owner-only".to_string())
                }
            }),
    ));

    checks.push(check(
        "lock_file",
        match instance::acquire(&paths.lock_file()) {
            Ok(LockOutcome::Held(_)) => Ok(None),
            Ok(LockOutcome::AlreadyOpen) => Err("held by a running copy".to_string()),
            Ok(LockOutcome::Unsupported(e)) => Ok(Some(format!("locks unsupported here: {e}"))),
            Err(e) => Err(e.to_string()),
        },
    ));

    checks.push(check(
        "seal_round_trip",
        match journal::seal_round_trip(brand.journal_byte) {
            Ok(v) if v == SCHEMA_VERSION => Ok(Some(format!("schema {v}"))),
            Ok(v) => Err(format!("schema {v}, expected {SCHEMA_VERSION}")),
            Err(e) => Err(e.to_string()),
        },
    ));

    Report {
        ok: checks.iter().all(|c| c.ok),
        brand: brand.id,
        version: env!("CARGO_PKG_VERSION"),
        data_dir: paths.source.as_str(),
        vault: vault.backend(),
        checks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brand::GREENWICK;
    use crate::paths::resolve;
    use crate::vault::{MemoryVault, UnavailableVault};

    #[test]
    fn passes_with_a_working_vault_and_fails_without_one() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = resolve(&GREENWICK, true, Some(tmp.path()), None).unwrap();
        let report = run(&GREENWICK, &paths, &MemoryVault::default());
        assert!(report.ok, "{report:?}");
        assert_eq!(report.checks.len(), 4);
        assert!(!paths.journal().exists(), "self-test must not create a journal");

        let broken = UnavailableVault {
            reason: "no secret service".to_string(),
        };
        let report = run(&GREENWICK, &paths, &broken);
        assert!(!report.ok);
        assert!(!report.checks[0].ok);
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains(&tmp.path().to_string_lossy().to_string()));
    }

    #[test]
    fn reports_a_held_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = resolve(&GREENWICK, true, Some(tmp.path()), None).unwrap();
        paths.ensure().unwrap();
        let _held = instance::acquire(&paths.lock_file()).unwrap();
        let report = run(&GREENWICK, &paths, &MemoryVault::default());
        let lock = report.checks.iter().find(|c| c.name == "lock_file").unwrap();
        assert!(!lock.ok);
    }
}
