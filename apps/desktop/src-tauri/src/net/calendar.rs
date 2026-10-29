//! The economic calendar for Pulse (Dojix, SPEC 8.3): the public weekly JSON at
//! `nfs.faireconomy.media`. Mac: `Services/LiveData/CalendarService.swift`.
//!
//! - No key. Behind a Settings toggle (on by default, `prefs.json`); the app works without it.
//! - Content-type check (JSON only), as on the Mac.
//! - The UI checks every 2 minutes; the feed is fetched again only when the copy is older than
//!   15 minutes (the feed has no SLA and rate-limits hard). A failed refresh keeps showing the
//!   last copy, marked stale; offline failures are silent.
//! - Fix (proposed in PARITY): an event whose date can't be read is dropped. The Mac gives it
//!   the current time, which can invent a high-impact "danger zone" right now.
//!
//! Danger zones (±15 min around high-impact events) and the D-28 recompute schedule are pure
//! functions in `@dojix-desktop/core` (`online/calendar.ts`).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::{checked_url, fetch_json, parse_rfc3339_ms, NetError, NetPolicy};

pub const PROVIDER: &str = "The economic calendar";
pub const HOSTS: &[&str] = &["nfs.faireconomy.media"];
pub const SOURCE_LABEL: &str = "nfs.faireconomy.media";
pub const URL: &str = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_EVENTS: usize = 2000;
const MAX_TEXT: usize = 200;
/// Reload the feed when the copy is older than this.
pub const RELOAD_AFTER: Duration = Duration::from_secs(15 * 60);
/// Never fetch more often than this, even when asked to.
pub const MIN_INTERVAL: Duration = Duration::from_secs(2 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Impact {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EconomicEvent {
    pub title: String,
    /// Currency code the event affects (`USD`, `EUR`, …).
    pub country: String,
    pub time_ms: i64,
    pub impact: Impact,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forecast: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarWeek {
    pub events: Vec<EconomicEvent>,
    pub fetched_at_ms: i64,
    pub source: &'static str,
    /// The last refresh failed; these are the previous events.
    pub stale: bool,
}

fn text(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    Some(
        s.chars()
            .filter(|c| !c.is_control())
            .take(MAX_TEXT)
            .collect(),
    )
}

/// `parseEvent`: title, country and a readable date are required; impact defaults to Low.
pub fn parse_event(json: &Value) -> Option<EconomicEvent> {
    let title = text(json.get("title"))?;
    let country = text(json.get("country"))?;
    let time_ms = parse_rfc3339_ms(json.get("date")?.as_str()?)?;
    let impact = match json
        .get("impact")
        .and_then(Value::as_str)
        .unwrap_or("Low")
        .to_ascii_lowercase()
        .as_str()
    {
        "high" => Impact::High,
        "medium" => Impact::Medium,
        _ => Impact::Low,
    };
    Some(EconomicEvent {
        title,
        country,
        time_ms,
        impact,
        actual: text(json.get("actual")),
        forecast: text(json.get("forecast")),
        previous: text(json.get("previous")),
    })
}

/// `fetchWeekEvents`: every readable event, sorted by time (stable).
pub fn parse_week(json: &Value) -> Result<Vec<EconomicEvent>, NetError> {
    let items = json
        .as_array()
        .ok_or_else(|| NetError::bad_response(PROVIDER))?;
    let mut events: Vec<EconomicEvent> = items
        .iter()
        .take(MAX_EVENTS)
        .filter_map(parse_event)
        .collect();
    events.sort_by_key(|e| e.time_ms);
    Ok(events)
}

struct Cached {
    week: CalendarWeek,
    loaded: Instant,
}

/// The in-memory copy (never written to disk).
#[derive(Default)]
pub struct CalendarCache {
    cached: Mutex<Option<Cached>>,
    last_attempt: Mutex<Option<Instant>>,
}

impl CalendarCache {
    /// The week's events: the cached copy while it is fresh, otherwise a new fetch. `force`
    /// reloads a copy older than [`MIN_INTERVAL`].
    pub async fn week(
        &self,
        http: &reqwest::Client,
        url: &str,
        policy: NetPolicy,
        force: bool,
    ) -> Result<CalendarWeek, NetError> {
        let now = Instant::now();
        let fresh_for = if force { MIN_INTERVAL } else { RELOAD_AFTER };
        if let Some(c) = self.cached.lock().ok().and_then(|g| {
            g.as_ref()
                .filter(|c| now.duration_since(c.loaded) < fresh_for)
                .map(|c| c.week.clone())
        }) {
            return Ok(c);
        }
        // Throttle attempts too (a failing feed is not hammered every time the UI asks).
        let recently_tried = self
            .last_attempt
            .lock()
            .ok()
            .and_then(|g| *g)
            .is_some_and(|t| now.duration_since(t) < MIN_INTERVAL);
        if recently_tried {
            return self.stale_or(NetError::new(
                "rate_limited",
                "The calendar was refreshed a moment ago.",
            ));
        }
        if let Ok(mut g) = self.last_attempt.lock() {
            *g = Some(now);
        }
        let url = checked_url(url, HOSTS, policy)?;
        let result = fetch_json(PROVIDER, http.get(url), MAX_BODY)
            .await
            .and_then(|json| parse_week(&json));
        match result {
            Ok(events) => {
                let week = CalendarWeek {
                    events,
                    fetched_at_ms: crate::journal::now_ms(),
                    source: SOURCE_LABEL,
                    stale: false,
                };
                if let Ok(mut g) = self.cached.lock() {
                    *g = Some(Cached {
                        week: week.clone(),
                        loaded: Instant::now(),
                    });
                }
                Ok(week)
            }
            Err(e) => {
                log::info!("economic calendar refresh failed ({})", e.code);
                self.stale_or(e)
            }
        }
    }

    fn stale_or(&self, e: NetError) -> Result<CalendarWeek, NetError> {
        match self
            .cached
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|c| c.week.clone()))
        {
            Some(mut week) => {
                week.stale = true;
                Ok(week)
            }
            None => Err(e),
        }
    }

    /// Forgets the copy (the toggle was switched off, or the journal locked).
    pub fn clear(&self) {
        if let Ok(mut g) = self.cached.lock() {
            *g = None;
        }
        if let Ok(mut g) = self.last_attempt.lock() {
            *g = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn events_parse_and_sort_and_unreadable_dates_are_dropped() {
        let feed = json!([
            {"title": "Fictional PMI", "country": "EUR", "date": "2026-10-27T09:00:00+01:00", "impact": "Medium", "forecast": "50.1", "previous": "49.8"},
            {"title": "Fictional Payrolls", "country": "USD", "date": "2026-10-26T08:30:00-04:00", "impact": "High", "actual": ""},
            {"title": "No date", "country": "USD", "impact": "High"},
            {"title": "Bad date", "country": "USD", "date": "next Tuesday", "impact": "High"},
            {"title": "Bank holiday", "country": "JPY", "date": "2026-10-28T00:00:00Z", "impact": "Holiday"},
            {"country": "GBP", "date": "2026-10-28T00:00:00Z"},
            "junk"
        ]);
        let events = parse_week(&feed).unwrap();
        let titles: Vec<&str> = events.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(
            titles,
            ["Fictional Payrolls", "Fictional PMI", "Bank holiday"]
        );
        assert_eq!(events[0].impact, Impact::High);
        assert_eq!(events[0].time_ms, 1_793_017_800_000);
        assert_eq!(events[0].actual, None);
        assert_eq!(events[1].forecast.as_deref(), Some("50.1"));
        assert_eq!(events[2].impact, Impact::Low);
        assert_eq!(
            parse_week(&json!({"events": []})).unwrap_err().code,
            "bad_response"
        );
        let v = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(v["impact"], "medium");
        assert!(v.get("actual").is_none());
    }

    #[test]
    fn long_text_is_cut_and_control_characters_removed() {
        let e = parse_event(&json!({
            "title": format!("A\u{0007}{}", "b".repeat(500)),
            "country": "USD",
            "date": "2026-10-26T12:30:00Z"
        }))
        .unwrap();
        assert_eq!(e.title.chars().count(), MAX_TEXT);
        assert!(e.title.starts_with("Ab"));
    }
}
