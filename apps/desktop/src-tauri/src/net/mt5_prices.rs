//! Live prices from MetaTrader 5 (Dojix, SPEC 8.3): `DojixPrices.json`, written about once a
//! second by the `DojixPriceFeed.mq5` script into MT5's shared `Terminal\Common\Files` folder.
//! Mac: `Services/LiveData/MT5FileProvider.swift`. No key, no network.
//!
//! - Read-only: opened for reading with full sharing (MT5 is never locked out), never written.
//! - Capped at 256 KB (`MT5FileProvider.maximumFileSize`): any MQL5 program can write there.
//! - Tolerant of half-written files: a read that doesn't parse is skipped and the last prices
//!   stay. A symbolic link is refused (it could point anywhere).
//! - Symbols are normalised (`EURUSD.r` → `EUR/USD`) so they match the watchlist; the Mac
//!   keeps the broker's names, which then never match.
//! - The file is checked every second (size and modification time), which also works on the
//!   network drives and Wine prefixes where change notifications don't.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde_json::Value;

use super::quotes::{PriceTick, StreamStatus, StreamTiming, TickSink};
use super::{parse_mt5_time_ms, NetError};

pub const FILE_NAME: &str = "DojixPrices.json";
pub const MAX_FILE_BYTES: u64 = 256 * 1024;

/// MT5's shared `Common\Files` folders on this computer: `%APPDATA%\MetaQuotes\Terminal\
/// Common\Files` on Windows; on Linux the same folder inside Wine prefixes (`$WINEPREFIX`,
/// `~/.wine`), for every Wine user.
pub fn common_files_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let tail = ["MetaQuotes", "Terminal", "Common", "Files"];
    let join = |base: PathBuf| tail.iter().fold(base, |p, t| p.join(t));
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        out.push(join(PathBuf::from(appdata)));
    }
    #[cfg(not(windows))]
    {
        let mut prefixes: Vec<PathBuf> = Vec::new();
        if let Some(p) = std::env::var_os("WINEPREFIX") {
            prefixes.push(PathBuf::from(p));
        }
        if let Some(home) = dirs::home_dir() {
            prefixes.push(home.join(".wine"));
        }
        for prefix in prefixes {
            let users = prefix.join("drive_c").join("users");
            let Ok(entries) = std::fs::read_dir(&users) else {
                continue;
            };
            for entry in entries.flatten() {
                let user = entry.path();
                out.push(join(user.join("AppData").join("Roaming")));
                out.push(join(user.join("Application Data")));
            }
        }
    }
    out
}

/// The price file to read: the most recently written `DojixPrices.json` in `dirs`.
pub fn find_price_file(dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter()
        .map(|d| d.join(FILE_NAME))
        .filter_map(|p| {
            let meta = std::fs::symlink_metadata(&p).ok()?;
            meta.is_file()
                .then(|| (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), p))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, p)| p)
}

/// Reads the file with the size cap. `None` when it is missing, a link, too large or unreadable.
pub fn read_capped(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let file = open_shared(path).ok()?;
    let mut bytes = Vec::new();
    // Bounded read too: the file may grow between the size check and the read.
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_FILE_BYTES).then_some(bytes)
}

#[cfg(windows)]
fn open_shared(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE: MT5 keeps writing meanwhile.
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2 | 0x4)
        .open(path)
}

#[cfg(not(windows))]
fn open_shared(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().read(true).open(path)
}

/// `readAndEmit`: `{"ts":"2026.10.26 12:30:00","prices":[{"s":"EURUSD","b":1.1,"a":1.1002}]}`.
/// `None` when the text doesn't parse (a half-written file).
pub fn parse_prices(bytes: &[u8], now_ms: i64) -> Option<Vec<PriceTick>> {
    let json: Value = serde_json::from_slice(bytes).ok()?;
    let prices = json.get("prices")?.as_array()?;
    let ts = json
        .get("ts")
        .and_then(Value::as_str)
        .and_then(parse_mt5_time_ms)
        .unwrap_or(now_ms);
    Some(
        prices
            .iter()
            .filter_map(|p| {
                PriceTick::new(
                    p.get("s")?.as_str()?,
                    p.get("b")?.as_f64()?,
                    p.get("a")?.as_f64()?,
                    ts,
                )
            })
            .collect(),
    )
}

/// Settings → Test, as on the Mac: how fresh the file is.
pub fn test(dirs: &[PathBuf], now: SystemTime) -> Result<String, NetError> {
    let not_found = || {
        NetError::new(
            "not_found",
            "DojixPrices.json not found. Attach the DojixPriceFeed script in MT5.",
        )
    };
    let path = find_price_file(dirs).ok_or_else(not_found)?;
    let modified = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(|_| not_found())?;
    let age = now
        .duration_since(modified)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if age < 10 {
        Ok(format!("Receiving prices (updated {age}s ago)"))
    } else if age < 60 {
        Ok(format!("File found (last update {age}s ago)"))
    } else {
        Err(NetError::new(
            "stale",
            format!(
                "File stale — last update {}m ago. Is the script running?",
                age / 60
            ),
        ))
    }
}

/// The MT5 source: checks the file every [`StreamTiming::file_interval`] and emits its prices
/// whenever its size or modification time changes.
pub async fn watch(
    dirs: Vec<PathBuf>,
    symbols: Vec<String>,
    timing: StreamTiming,
    sink: Arc<dyn TickSink>,
) {
    let wanted = |t: &PriceTick| symbols.is_empty() || symbols.contains(&t.symbol);
    let mut last: Option<(u64, Option<SystemTime>, PathBuf)> = None;
    let mut connected = false;
    let mut missing_reported = false;
    loop {
        let dirs_now = dirs.clone();
        let found = tokio::task::spawn_blocking(move || {
            let path = find_price_file(&dirs_now)?;
            let meta = std::fs::symlink_metadata(&path).ok()?;
            Some((meta.len(), meta.modified().ok(), path))
        })
        .await
        .ok()
        .flatten();
        match found {
            None => {
                if !missing_reported {
                    sink.status(StreamStatus::Error {
                        message:
                            "DojixPrices.json not found. Attach the DojixPriceFeed script in MT5."
                                .into(),
                    });
                    missing_reported = true;
                }
                connected = false;
                last = None;
            }
            Some(state) if last.as_ref() != Some(&state) => {
                missing_reported = false;
                let path = state.2.clone();
                let bytes = tokio::task::spawn_blocking(move || read_capped(&path))
                    .await
                    .ok()
                    .flatten();
                if let Some(ticks) = bytes.and_then(|b| parse_prices(&b, crate::journal::now_ms()))
                {
                    if !connected {
                        sink.status(StreamStatus::Connected);
                        connected = true;
                    }
                    ticks
                        .into_iter()
                        .filter(|t| wanted(t))
                        .for_each(|t| sink.tick(t));
                    last = Some(state);
                }
                // Otherwise: half-written or oversized; try again next time.
            }
            Some(_) => {}
        }
        tokio::time::sleep(timing.file_interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::quotes::test_support::{eventually, Collect, FAST};
    use super::*;

    const SAMPLE: &str = r#"{"ts":"2026.10.26 12:30:00","prices":[
        {"s":"EURUSD.r","b":1.0851,"a":1.0852},
        {"s":"GBPUSD","b":"bad","a":1.3},
        {"s":"USDJPY","b":150.1,"a":150.12}]}"#;

    #[test]
    fn prices_parse_with_normalised_symbols_and_the_file_time() {
        let ticks = parse_prices(SAMPLE.as_bytes(), 0).unwrap();
        let syms: Vec<&str> = ticks.iter().map(|t| t.symbol.as_str()).collect();
        assert_eq!(syms, ["EUR/USD", "USD/JPY"]);
        assert_eq!(ticks[0].timestamp_ms, 1_793_017_800_000);
        assert!(parse_prices(br#"{"ts":"2026.10.26 12:30","prices":[]}"#, 9)
            .unwrap()
            .is_empty());
        assert!(
            parse_prices(br#"{"prices":[{"s":"EURUSD","b":1,"a"#, 0).is_none(),
            "half written"
        );
        assert!(parse_prices(b"[]", 0).is_none());
    }

    #[test]
    fn reads_are_capped_and_links_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(FILE_NAME);
        std::fs::write(&path, SAMPLE).unwrap();
        assert_eq!(read_capped(&path).unwrap(), SAMPLE.as_bytes());
        std::fs::write(&path, vec![b' '; MAX_FILE_BYTES as usize + 1]).unwrap();
        assert!(read_capped(&path).is_none());
        assert!(read_capped(&tmp.path().join("missing.json")).is_none());
        #[cfg(unix)]
        {
            let target = tmp.path().join("elsewhere.json");
            std::fs::write(&target, SAMPLE).unwrap();
            let link_dir = tmp.path().join("linked");
            std::fs::create_dir(&link_dir).unwrap();
            std::os::unix::fs::symlink(&target, link_dir.join(FILE_NAME)).unwrap();
            assert!(read_capped(&link_dir.join(FILE_NAME)).is_none());
            assert!(find_price_file(&[link_dir]).is_none());
        }
    }

    #[test]
    fn the_test_reports_freshness() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = vec![tmp.path().to_path_buf()];
        assert_eq!(
            test(&dirs, SystemTime::now()).unwrap_err().code,
            "not_found"
        );
        std::fs::write(tmp.path().join(FILE_NAME), SAMPLE).unwrap();
        let modified = std::fs::metadata(tmp.path().join(FILE_NAME))
            .unwrap()
            .modified()
            .unwrap();
        assert!(test(&dirs, modified)
            .unwrap()
            .starts_with("Receiving prices"));
        let later = modified + std::time::Duration::from_secs(30);
        assert!(test(&dirs, later).unwrap().starts_with("File found"));
        let much_later = modified + std::time::Duration::from_secs(600);
        let e = test(&dirs, much_later).unwrap_err();
        assert_eq!(e.code, "stale");
        assert!(e.message.contains("10m"));
    }

    #[test]
    fn common_files_dirs_end_in_the_shared_folder() {
        for d in common_files_dirs() {
            assert!(
                d.ends_with(Path::new("MetaQuotes/Terminal/Common/Files")),
                "{}",
                d.display()
            );
        }
    }

    #[tokio::test]
    async fn the_watcher_emits_on_change_and_survives_half_written_files() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(FILE_NAME);
        let sink = Arc::new(Collect::default());
        let task = tokio::spawn(watch(
            vec![tmp.path().to_path_buf()],
            vec!["EUR/USD".into()],
            FAST,
            sink.clone(),
        ));
        eventually(|| matches!(sink.last_status(), Some(StreamStatus::Error { .. }))).await;
        std::fs::write(&file, r#"{"prices":[{"s":"EURUSD","b":1"#).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(sink.ticks.lock().unwrap().is_empty());
        std::fs::write(&file, SAMPLE).unwrap();
        eventually(|| sink.tick_symbols() == ["EUR/USD"]).await;
        assert_eq!(sink.last_status(), Some(StreamStatus::Connected));
        task.abort();
    }
}
