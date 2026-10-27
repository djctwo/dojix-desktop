//! Wrong-password throttle (SPEC 6.6), identical schedule to both Mac apps' `UnlockThrottle`:
//! attempts 1–4 free ("n/5"), then 30 s, 60 s, 5 min, 15 min and 30 min from the 9th on.
//!
//! The count and the wait end live in the vault, so they survive a relaunch, and one counter
//! is shared by the lock screen, the older-copy screen and Settings. Fail closed: while either
//! item exists but can't be read, no password is checked and nothing is written, so the
//! count is never restarted.

use std::sync::atomic::{AtomicI64, Ordering};

use serde::Serialize;

use crate::vault::{Lookup, SecretStore, FAILED_ATTEMPTS, LOCKOUT_UNTIL};

/// Wall-clock milliseconds since the Unix epoch, injectable for tests.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    }
}

/// A clock that only moves when told to.
#[derive(Debug, Default)]
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn at(ms: i64) -> Self {
        Self(AtomicI64::new(ms))
    }
    pub fn advance_ms(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// The wait after the n-th wrong password, in seconds.
pub fn lockout_seconds(attempts: u32) -> i64 {
    match attempts {
        0..=4 => 0,
        5 => 30,
        6 => 60,
        7 => 300,
        8 => 900,
        _ => 1800,
    }
}

/// Whether a password may be checked now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    Allowed,
    /// Seconds left before the next try.
    Wait(i64),
    /// The count or the wait exists but can't be read.
    Unreadable,
}

/// What the UI shows under a password field.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleStatus {
    pub attempts: u32,
    pub wait_seconds: i64,
    pub unreadable: bool,
    pub message: Option<String>,
}

pub struct Throttle<'a> {
    store: &'a dyn SecretStore,
    clock: &'a dyn Clock,
    product: &'a str,
}

/// A value that is absent, present, or unreadable.
enum Item {
    Absent,
    Value(String),
    Unreadable,
}

impl<'a> Throttle<'a> {
    pub fn new(store: &'a dyn SecretStore, clock: &'a dyn Clock, product: &'a str) -> Self {
        Self {
            store,
            clock,
            product,
        }
    }

    fn item(&self, account: &str) -> Item {
        match self.store.lookup(account) {
            Lookup::Absent => Item::Absent,
            Lookup::Found(bytes) => match std::str::from_utf8(&bytes) {
                Ok(text) => Item::Value(text.to_string()),
                // Present but not ours: count it as unreadable rather than "none".
                Err(_) => Item::Unreadable,
            },
            Lookup::Failed(e) => {
                log::error!("wrong-password limit unreadable ({e}); no password checked");
                Item::Unreadable
            }
        }
    }

    fn attempts_item(&self) -> Result<u32, ()> {
        match self.item(FAILED_ATTEMPTS) {
            Item::Absent => Ok(0),
            Item::Value(v) => v.trim().parse::<u32>().map_err(|_| ()),
            Item::Unreadable => Err(()),
        }
    }

    fn until_item(&self) -> Result<Option<i64>, ()> {
        match self.item(LOCKOUT_UNTIL) {
            Item::Absent => Ok(None),
            Item::Value(v) => v.trim().parse::<i64>().map(Some).map_err(|_| ()),
            Item::Unreadable => Err(()),
        }
    }

    pub fn unreadable_message(&self) -> String {
        format!(
            "{} can't read its wrong-password count from the system keyring right now, so no \
             password can be checked. Quit and reopen {}.",
            self.product, self.product
        )
    }

    pub fn check(&self) -> Gate {
        let (Ok(_), Ok(until)) = (self.attempts_item(), self.until_item()) else {
            return Gate::Unreadable;
        };
        let now = self.clock.now_ms();
        match until {
            Some(until) if now < until => {
                // A clock set back can't stretch a wait beyond the longest step.
                let left = ((until - now) + 999) / 1000;
                Gate::Wait(left.min(lockout_seconds(u32::MAX)))
            }
            _ => Gate::Allowed,
        }
    }

    pub fn status(&self) -> ThrottleStatus {
        let attempts = self.attempts_item().unwrap_or(0);
        match self.check() {
            Gate::Allowed => ThrottleStatus {
                attempts,
                wait_seconds: 0,
                unreadable: false,
                message: None,
            },
            Gate::Wait(s) => ThrottleStatus {
                attempts,
                wait_seconds: s,
                unreadable: false,
                message: Some(wait_message(s)),
            },
            Gate::Unreadable => ThrottleStatus {
                attempts,
                wait_seconds: 0,
                unreadable: true,
                message: Some(self.unreadable_message()),
            },
        }
    }

    /// Counts a wrong password and returns the message to show. Writes nothing while the
    /// count or the wait can't be read.
    pub fn record_failure(&self) -> String {
        let Ok(count) = self.attempts_item() else {
            return self.unreadable_message();
        };
        if self.until_item().is_err() {
            return self.unreadable_message();
        }
        let count = count.min(1_000) + 1;
        if let Err(e) = self
            .store
            .write(FAILED_ATTEMPTS, count.to_string().as_bytes())
        {
            log::error!("could not store the wrong-password count: {e}");
        }
        let wait = lockout_seconds(count);
        if wait == 0 {
            return format!("Incorrect password ({count}/5)");
        }
        let until = self.clock.now_ms().saturating_add(wait * 1000);
        if let Err(e) = self.store.write(LOCKOUT_UNTIL, until.to_string().as_bytes()) {
            log::error!("could not store the wrong-password wait: {e}");
        }
        wait_message(wait)
    }

    /// The right password was entered.
    pub fn reset(&self) {
        for account in [FAILED_ATTEMPTS, LOCKOUT_UNTIL] {
            if let Err(e) = self.store.delete(account) {
                log::error!("could not reset the wrong-password limit: {e}");
            }
        }
    }
}

pub fn wait_message(seconds: i64) -> String {
    if seconds > 60 {
        format!(
            "Too many attempts. Try again in {} minutes.",
            (seconds + 59) / 60
        )
    } else {
        format!("Too many attempts. Try again in {seconds} seconds.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::MemoryVault;

    const T0: i64 = 1_767_225_600_000;

    #[test]
    fn the_schedule_matches_the_mac() {
        let waits: Vec<i64> = (1..=10).map(lockout_seconds).collect();
        assert_eq!(waits, vec![0, 0, 0, 0, 30, 60, 300, 900, 1800, 1800]);
    }

    #[test]
    fn four_free_attempts_then_waits_that_survive_a_new_instance() {
        let store = MemoryVault::default();
        let clock = ManualClock::at(T0);
        let t = Throttle::new(&store, &clock, "Dojix");
        for n in 1..=4 {
            assert_eq!(t.check(), Gate::Allowed);
            assert_eq!(t.record_failure(), format!("Incorrect password ({n}/5)"));
        }
        assert_eq!(
            t.record_failure(),
            "Too many attempts. Try again in 30 seconds."
        );
        // A relaunch reads the same vault.
        let again = Throttle::new(&store, &clock, "Dojix");
        assert_eq!(again.check(), Gate::Wait(30));
        assert_eq!(again.status().attempts, 5);
        clock.advance_ms(30_000);
        assert_eq!(again.check(), Gate::Allowed);
        assert_eq!(
            again.record_failure(),
            "Too many attempts. Try again in 60 seconds."
        );
        clock.advance_ms(60_000);
        assert_eq!(
            again.record_failure(),
            "Too many attempts. Try again in 5 minutes."
        );
        again.reset();
        assert_eq!(again.check(), Gate::Allowed);
        assert_eq!(again.status().attempts, 0);
    }

    #[test]
    fn an_unreadable_count_or_wait_checks_nothing_and_writes_nothing() {
        for account in [FAILED_ATTEMPTS, LOCKOUT_UNTIL] {
            let store = MemoryVault::default();
            let clock = ManualClock::at(T0);
            store.write(FAILED_ATTEMPTS, b"3").unwrap();
            store.fail(account);
            let t = Throttle::new(&store, &clock, "Greenwick");
            assert_eq!(t.check(), Gate::Unreadable);
            assert!(t.status().unreadable);
            assert!(t.record_failure().contains("can't read its wrong-password count"));
            store.heal();
            // The count was not restarted at 1 and no wait was written.
            assert!(matches!(store.lookup(FAILED_ATTEMPTS), Lookup::Found(ref v) if v.as_slice() == b"3"));
            assert!(matches!(store.lookup(LOCKOUT_UNTIL), Lookup::Absent));
        }
    }

    #[test]
    fn a_damaged_count_is_unreadable_not_zero() {
        let store = MemoryVault::default();
        let clock = ManualClock::at(T0);
        store.write(FAILED_ATTEMPTS, b"not a number").unwrap();
        let t = Throttle::new(&store, &clock, "Dojix");
        assert_eq!(t.check(), Gate::Unreadable);
    }

    #[test]
    fn a_clock_set_back_never_waits_more_than_the_longest_step() {
        let store = MemoryVault::default();
        let clock = ManualClock::at(T0);
        store
            .write(LOCKOUT_UNTIL, (T0 + 86_400_000).to_string().as_bytes())
            .unwrap();
        let t = Throttle::new(&store, &clock, "Dojix");
        assert_eq!(t.check(), Gate::Wait(1800));
    }
}
