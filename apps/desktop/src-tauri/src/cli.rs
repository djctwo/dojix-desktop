//! Command-line flags. Unknown flags are ignored so tooling (installers, WebDriver) can't break start-up.

use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Args {
    /// `--data-dir <path>` or `--data-dir=<path>`: use this folder instead of the default.
    pub data_dir: Option<PathBuf>,
    /// `--vault-service <name>`: use this credential-vault namespace instead of the brand's.
    pub vault_service: Option<String>,
    /// `--self-test`: check the vault, data folder, lock file and seal round trip; print JSON; exit.
    pub self_test: bool,
}

/// Parses process arguments (the first item, the program name, is skipped).
pub fn parse<I: IntoIterator<Item = OsString>>(args: I) -> Result<Args, String> {
    let mut out = Args::default();
    let mut iter = args.into_iter().skip(1);
    while let Some(arg) = iter.next() {
        let text = arg.to_string_lossy();
        if text == "--self-test" {
            out.self_test = true;
        } else if text == "--data-dir" {
            let value = iter
                .next()
                .ok_or_else(|| "--data-dir needs a folder path".to_string())?;
            out.data_dir = Some(non_empty(PathBuf::from(value))?);
        } else if let Some(value) = text.strip_prefix("--data-dir=") {
            out.data_dir = Some(non_empty(PathBuf::from(value))?);
        } else if text == "--vault-service" {
            let value = iter
                .next()
                .ok_or_else(|| "--vault-service needs a name".to_string())?;
            out.vault_service = Some(service_name(&value.to_string_lossy())?);
        } else if let Some(value) = text.strip_prefix("--vault-service=") {
            out.vault_service = Some(service_name(value)?);
        }
    }
    Ok(out)
}

fn non_empty(path: PathBuf) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        Err("--data-dir needs a folder path".to_string())
    } else {
        Ok(path)
    }
}

fn service_name(value: &str) -> Result<String, String> {
    let ok = !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if ok {
        Ok(value.to_string())
    } else {
        Err("--vault-service takes 1-128 letters, digits, '.', '-' or '_'".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, String> {
        parse(list.iter().map(OsString::from))
    }

    #[test]
    fn defaults_when_no_flags() {
        assert_eq!(args(&["app"]).unwrap(), Args::default());
    }

    #[test]
    fn reads_self_test_and_data_dir_in_both_forms() {
        let a = args(&["app", "--self-test", "--data-dir", "scratch one"]).unwrap();
        assert!(a.self_test);
        assert_eq!(a.data_dir, Some(PathBuf::from("scratch one")));
        let b = args(&["app", "--data-dir=other"]).unwrap();
        assert_eq!(b.data_dir, Some(PathBuf::from("other")));
        assert!(!b.self_test);
    }

    #[test]
    fn rejects_a_missing_or_empty_data_dir() {
        assert!(args(&["app", "--data-dir"]).is_err());
        assert!(args(&["app", "--data-dir="]).is_err());
    }

    #[test]
    fn reads_a_vault_service_and_rejects_odd_names() {
        let a = args(&["app", "--vault-service", "e2e.dojix.1"]).unwrap();
        assert_eq!(a.vault_service.as_deref(), Some("e2e.dojix.1"));
        let b = args(&["app", "--vault-service=scratch_2"]).unwrap();
        assert_eq!(b.vault_service.as_deref(), Some("scratch_2"));
        assert!(args(&["app", "--vault-service", "has space"]).is_err());
        assert!(args(&["app", "--vault-service="]).is_err());
    }

    #[test]
    fn ignores_unknown_flags() {
        let a = args(&["app", "--automation", "-psn_0_1", "--data-dir", "x"]).unwrap();
        assert_eq!(a.data_dir, Some(PathBuf::from("x")));
    }
}
