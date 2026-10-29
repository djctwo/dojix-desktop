//! Twelve Data's daily request budget, persisted per UTC day (PARITY: the Mac's counter lives
//! in one service instance and resets on every relaunch, so it is never enforced in practice).
//!
//! Twelve Data charges one API credit per symbol, so a batch quote for 8 pairs costs 8 credits;
//! the counter counts credits, not HTTP requests. The free plan allows 800 credits a day.
//! The file holds only a date and a number (no trading data), next to `prefs.json`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::NetError;
use crate::fsec;

pub const FILE: &str = "net-usage.json";
/// Twelve Data's free daily allowance (`TwelveDataService.dailyLimit`).
pub const TWELVE_DATA_DAILY_LIMIT: u32 = 800;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Usage {
    day: String,
    twelve_data_credits: u32,
}

pub struct DailyCounter {
    path: PathBuf,
    limit: u32,
    lock: Mutex<()>,
}

fn utc_day(now_ms: i64) -> String {
    crate::logging::utc_timestamp(u64::try_from(now_ms / 1000).unwrap_or(0))[..10].to_string()
}

impl DailyCounter {
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join(FILE),
            limit: TWELVE_DATA_DAILY_LIMIT,
            lock: Mutex::new(()),
        }
    }

    fn load(&self, now_ms: i64) -> Usage {
        let today = utc_day(now_ms);
        let usage = std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Usage>(&b).ok())
            .unwrap_or_default();
        if usage.day == today {
            usage
        } else {
            Usage {
                day: today,
                twelve_data_credits: 0,
            }
        }
    }

    /// Credits left today.
    pub fn remaining(&self, now_ms: i64) -> u32 {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        self.limit
            .saturating_sub(self.load(now_ms).twelve_data_credits)
    }

    /// Refuses a request that would go over today's budget.
    pub fn check(&self, credits: u32, now_ms: i64) -> Result<(), NetError> {
        if self.remaining(now_ms) < credits.max(1) {
            return Err(NetError::new(
                "rate_limited",
                format!(
                    "Daily Twelve Data limit reached ({} credits). It resets at midnight UTC.",
                    self.limit
                ),
            ));
        }
        Ok(())
    }

    /// Records credits spent (after a successful response). A failed write is logged only.
    pub fn record(&self, credits: u32, now_ms: i64) {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut usage = self.load(now_ms);
        usage.twelve_data_credits = usage.twelve_data_credits.saturating_add(credits);
        match serde_json::to_vec(&usage) {
            Ok(bytes) => {
                if let Err(e) = fsec::write_atomic(&self.path, &bytes) {
                    log::warn!("could not save the daily request count: {}", e.kind());
                }
            }
            Err(_) => log::warn!("could not encode the daily request count"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY1: i64 = 1_793_017_800_000; // 2026-10-26 12:30 UTC
    const DAY2: i64 = DAY1 + 86_400_000;

    #[test]
    fn counts_credits_per_utc_day_and_survives_a_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let c = DailyCounter::new(tmp.path());
        assert_eq!(c.remaining(DAY1), 800);
        c.record(8, DAY1);
        c.record(8, DAY1);
        let again = DailyCounter::new(tmp.path());
        assert_eq!(again.remaining(DAY1), 784);
        assert_eq!(again.remaining(DAY2), 800, "a new day starts at zero");
        c.record(780, DAY1);
        assert_eq!(c.remaining(DAY1), 4);
        assert!(c.check(4, DAY1).is_ok());
        assert_eq!(c.check(5, DAY1).unwrap_err().code, "rate_limited");
        c.record(u32::MAX, DAY1);
        assert_eq!(c.remaining(DAY1), 0);
        assert_eq!(c.check(0, DAY1).unwrap_err().code, "rate_limited");
    }

    #[test]
    fn a_damaged_file_starts_over() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(FILE), b"{oops").unwrap();
        let c = DailyCounter::new(tmp.path());
        assert_eq!(c.remaining(DAY1), 800);
        c.record(1, DAY1);
        assert_eq!(c.remaining(DAY1), 799);
    }
}
