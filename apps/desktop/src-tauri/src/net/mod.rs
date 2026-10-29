//! Online features (SPEC §8): every network call the app makes lives here, in Rust. The web
//! view has no network access at all (CSP `connect-src ipc: http://ipc.localhost`); it calls the
//! typed commands in [`commands`] instead.
//!
//! Rules shared by every provider (SPEC 8.1):
//! - HTTPS / WSS only, to a per-provider host allow-list ([`check_url`]). Redirects are followed
//!   only to the same host over HTTPS. Nothing is cached on disk.
//! - TLS uses the operating system's trust store (`rustls-platform-verifier`). **No certificate
//!   pinning** (SPEC 8.1, PARITY "Certificate pinning"): pins can't be hot-fixed in an installed
//!   open-source desktop app, and the Mac pins broke when providers rotated certificates.
//! - Keys come from the OS credential vault ([`secrets`]), go into a header wherever the
//!   provider allows it, and never come back out through IPC.
//! - Every response body is read with a size cap; every request has a timeout; streams
//!   reconnect with exponential backoff, at most [`MAX_RECONNECTS`] times.
//! - No telemetry. Logs never contain keys, prices, trade data or response bodies.

pub mod anthropic;
pub mod calendar;
pub mod commands;
pub mod finnhub;
pub mod mt5_prices;
pub mod oanda;
pub mod online;
pub mod polygon;
pub mod quotes;
pub mod secrets;
pub mod settings;
pub mod twelvedata;
pub mod usage;

#[cfg(test)]
mod tests;

use std::time::Duration;

use reqwest::header::{HeaderMap, CONTENT_TYPE, RETRY_AFTER};
use reqwest::Url;
use serde::Serialize;

/// Streams reconnect at most this many times in a row (SPEC 8.3), as on the Mac.
pub const MAX_RECONNECTS: u32 = 10;
/// The longest wait between two reconnects (the Mac's `maxBackoff`).
pub const MAX_BACKOFF_SECS: u64 = 60;

/// An error the UI can show. `message` never contains a key, a response body, a price or a
/// path; text that comes from a provider is redacted and shortened first ([`provider_text`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct NetError {
    pub code: &'static str,
    pub message: String,
    /// Seconds the provider asked us to wait (HTTP `Retry-After`), when it said so.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u64>,
}

impl NetError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_secs: None,
        }
    }

    pub fn off(what: &str) -> Self {
        Self::new(
            "off",
            format!("{what} is switched off. Turn it on in Settings first."),
        )
    }

    pub fn no_key(what: &str) -> Self {
        Self::new(
            "no_key",
            format!("No {what} is saved. Add it in Settings first."),
        )
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }

    pub fn blocked() -> Self {
        Self::new(
            "blocked_host",
            "That address is not on the list of hosts this app may contact.",
        )
    }

    pub fn bad_response(provider: &str) -> Self {
        Self::new(
            "bad_response",
            format!("{provider} sent a response this app could not read."),
        )
    }

    pub fn too_large(provider: &str) -> Self {
        Self::new(
            "too_large",
            format!("{provider} sent a response larger than this app accepts."),
        )
    }

    pub fn unsupported() -> Self {
        Self::new("unsupported", "This feature is not part of this app.")
    }
}

impl From<crate::session::OpError> for NetError {
    fn from(e: crate::session::OpError) -> Self {
        Self::new(e.code, e.message)
    }
}

/// Which URLs a client may contact. Production code always uses [`NetPolicy::STRICT`]; only
/// unit tests may allow plain `http://` / `ws://` to a loopback address (the mock servers).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetPolicy {
    allow_loopback: bool,
}

impl NetPolicy {
    pub const STRICT: Self = Self {
        allow_loopback: false,
    };

    #[cfg(test)]
    pub const LOOPBACK_FOR_TESTS: Self = Self {
        allow_loopback: true,
    };

    pub fn allows_loopback(self) -> bool {
        self.allow_loopback
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// True when `host` is in `allowed`. An entry `*.example.com` allows every subdomain of
/// `example.com` (not `example.com` itself; list that separately).
pub fn host_allowed(host: &str, allowed: &[&str]) -> bool {
    let host = host.to_ascii_lowercase();
    allowed.iter().any(|entry| match entry.strip_prefix("*.") {
        Some(suffix) => {
            host.len() > suffix.len() + 1
                && host.ends_with(suffix)
                && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
        }
        None => host == *entry,
    })
}

/// The URL check every request goes through: HTTPS/WSS to an allowed host, no credentials in
/// the URL. With [`NetPolicy::LOOPBACK_FOR_TESTS`], loopback mock servers are also allowed.
pub fn check_url(url: &Url, allowed: &[&str], policy: NetPolicy) -> Result<(), NetError> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NetError::blocked());
    }
    let secure = matches!(url.scheme(), "https" | "wss");
    if secure && url.host_str().is_some_and(|h| host_allowed(h, allowed)) {
        return Ok(());
    }
    if policy.allow_loopback
        && is_loopback(url)
        && matches!(url.scheme(), "http" | "https" | "ws" | "wss")
    {
        return Ok(());
    }
    Err(NetError::blocked())
}

/// Parses `text` and runs [`check_url`].
pub fn checked_url(text: &str, allowed: &[&str], policy: NetPolicy) -> Result<Url, NetError> {
    let url = Url::parse(text).map_err(|_| NetError::blocked())?;
    check_url(&url, allowed, policy)?;
    Ok(url)
}

/// An HTTPS client with a total timeout. Redirects are followed only to the same host and port
/// over HTTPS (at most 5). TLS: rustls with the OS trust store, no pinning.
pub fn http_client(timeout: Duration, policy: NetPolicy) -> Result<reqwest::Client, NetError> {
    builder(policy).timeout(timeout).build().map_err(|e| {
        log::error!("could not create the HTTPS client: {}", e.is_builder());
        NetError::new("unavailable", "The network client could not start.")
    })
}

/// A client for long-lived streams: no total timeout, but a read timeout so a silent
/// connection (no heartbeat) is noticed and reconnected.
pub fn stream_client(
    read_timeout: Duration,
    policy: NetPolicy,
) -> Result<reqwest::Client, NetError> {
    builder(policy)
        .read_timeout(read_timeout)
        .build()
        .map_err(|_| NetError::new("unavailable", "The network client could not start."))
}

fn builder(policy: NetPolicy) -> reqwest::ClientBuilder {
    let redirect = reqwest::redirect::Policy::custom(move |attempt| {
        let hops = attempt.previous().len();
        let same_origin = attempt.previous().first().is_some_and(|first| {
            first.host_str() == attempt.url().host_str()
                && first.port_or_known_default() == attempt.url().port_or_known_default()
        });
        let secure = attempt.url().scheme() == "https"
            || (policy.allow_loopback && is_loopback(attempt.url()));
        if hops >= 5 {
            attempt.error("too many redirects")
        } else if same_origin && secure {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(redirect)
        .https_only(!policy.allow_loopback)
        .user_agent(concat!("dojix-desktop/", env!("CARGO_PKG_VERSION")))
}

/// Maps a transport error to something the UI can show (never the error's text: it can
/// contain the URL, which for some providers carries a symbol or an account ID).
pub fn transport_error(provider: &str, e: &reqwest::Error) -> NetError {
    if e.is_timeout() {
        NetError::new("timeout", format!("{provider} did not answer in time."))
    } else if e.is_redirect() {
        NetError::blocked()
    } else if e.is_body() || e.is_decode() {
        NetError::bad_response(provider)
    } else {
        NetError::new(
            "offline",
            format!("{provider} could not be reached. Check the internet connection."),
        )
    }
}

/// The seconds in a `Retry-After` header (the delta-seconds form), capped at an hour.
pub fn retry_after(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(|s| s.min(3600))
}

/// True when the response says it is JSON.
pub fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("json"))
}

/// The error for a non-success HTTP status.
pub fn status_error(provider: &str, status: u16, retry: Option<u64>) -> NetError {
    match status {
        401 | 403 => NetError::new(
            "invalid_key",
            format!("{provider} did not accept the key. Check it in Settings."),
        ),
        429 => NetError {
            code: "rate_limited",
            message: match retry {
                Some(s) => format!("{provider}'s rate limit was reached. Try again in {s} s."),
                None => format!("{provider}'s rate limit was reached. Try again in a moment."),
            },
            retry_after_secs: retry,
        },
        500..=599 => NetError {
            code: "unavailable",
            message: format!("{provider} is temporarily unavailable. Try again later."),
            retry_after_secs: retry,
        },
        _ => NetError::new("http", format!("{provider} answered with HTTP {status}.")),
    }
}

/// Reads at most `max` bytes of body. A larger body (declared or actual) is refused.
pub async fn read_limited(
    provider: &str,
    mut response: reqwest::Response,
    max: usize,
) -> Result<Vec<u8>, NetError> {
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err(NetError::too_large(provider));
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > max {
                    return Err(NetError::too_large(provider));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(body),
            Err(e) => return Err(transport_error(provider, &e)),
        }
    }
}

/// A successful response's status, headers and (size-capped) body.
pub struct Fetched {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

/// Sends `request` and reads the body with a cap. Any status is returned (the caller decides).
pub async fn fetch(
    provider: &str,
    request: reqwest::RequestBuilder,
    max: usize,
) -> Result<Fetched, NetError> {
    let response = request
        .send()
        .await
        .map_err(|e| transport_error(provider, &e))?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = read_limited(provider, response, max).await?;
    Ok(Fetched {
        status,
        headers,
        body,
    })
}

/// [`fetch`], then: a non-2xx status becomes [`status_error`], a non-JSON content type or an
/// unparsable body becomes `bad_response`.
pub async fn fetch_json(
    provider: &str,
    request: reqwest::RequestBuilder,
    max: usize,
) -> Result<serde_json::Value, NetError> {
    let got = fetch(provider, request, max).await?;
    if !(200..300).contains(&got.status) {
        return Err(status_error(
            provider,
            got.status,
            retry_after(&got.headers),
        ));
    }
    if !is_json(&got.headers) {
        return Err(NetError::bad_response(provider));
    }
    serde_json::from_slice(&got.body).map_err(|_| NetError::bad_response(provider))
}

/// The wait before reconnect attempt `attempt` (1-based): 2^attempt seconds, at most 60, as on
/// the Mac. `unit` is one second in the app (tests shrink it).
pub fn backoff_delay(attempt: u32, unit: Duration) -> Duration {
    let secs = 2u64.saturating_pow(attempt).min(MAX_BACKOFF_SECS);
    unit.saturating_mul(u32::try_from(secs).unwrap_or(60))
}

/// Text from a provider, made safe to show: every secret removed, control characters
/// dropped, at most 300 characters (the Mac's limit for API error messages).
pub fn provider_text(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for s in secrets {
        if s.len() >= 4 {
            out = out.replace(s, "[redacted]");
        }
    }
    out.chars().filter(|c| !c.is_control()).take(300).collect()
}

/// The last line of defence against a provider that echoes a key back: a result whose JSON
/// contains any of `secrets` is refused. Every result built from provider data passes here
/// before it can reach the web view.
pub fn no_echo<T: Serialize>(value: T, provider: &str, secrets: &[&str]) -> Result<T, NetError> {
    let json = serde_json::to_string(&value).map_err(|_| NetError::bad_response(provider))?;
    if secrets.iter().any(|s| s.len() >= 4 && json.contains(s)) {
        log::warn!("{provider} echoed a key in its response; the response was dropped");
        return Err(NetError::bad_response(provider));
    }
    Ok(value)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn digits(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Epoch milliseconds for a date-time in `YYYY-MM-DD?HH:MM:SS` form with `sep` between the
/// date and the time, and `date_sep` inside the date.
fn civil_ms(date: &str, time: &str, date_sep: char) -> Option<i64> {
    let mut d = date.split(date_sep);
    let (y, mo, da) = (digits(d.next()?)?, digits(d.next()?)?, digits(d.next()?)?);
    if d.next().is_some() || !(1..=12).contains(&mo) || !(1..=31).contains(&da) {
        return None;
    }
    let mut t = time.split(':');
    let (h, mi, s) = (digits(t.next()?)?, digits(t.next()?)?, digits(t.next()?)?);
    if t.next().is_some() || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let days = days_from_civil(y, mo, da);
    Some(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000)
}

/// Parses RFC 3339 (`2026-10-26T08:30:00-04:00`, `…T12:00:00.123456789Z`) to epoch ms.
pub fn parse_rfc3339_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, rest) = text.split_once(['T', 't', ' '])?;
    // Split the zone off the end: "Z", or "+HH:MM" / "-HH:MM".
    let (clock, offset_min) = if let Some(c) = rest.strip_suffix(['Z', 'z']) {
        (c, 0)
    } else {
        let at = rest.rfind(['+', '-'])?;
        let (c, zone) = rest.split_at(at);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let (zh, zm) = zone[1..].split_once(':')?;
        let (zh, zm) = (digits(zh)?, digits(zm)?);
        if zh > 23 || zm > 59 {
            return None;
        }
        (c, sign * (zh * 60 + zm))
    };
    let (whole, frac) = match clock.split_once('.') {
        Some((w, f)) => (w, f),
        None => (clock, ""),
    };
    if !frac.is_empty() && !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let ms_frac = frac
        .chars()
        .chain("000".chars())
        .take(3)
        .collect::<String>()
        .parse::<i64>()
        .ok()?;
    Some(civil_ms(date, whole, '-')? + ms_frac - offset_min * 60_000)
}

/// Parses MT5's `yyyy.MM.dd HH:mm:ss` (read as UTC, as on the Mac) to epoch ms.
pub fn parse_mt5_time_ms(text: &str) -> Option<i64> {
    let (date, time) = text.trim().split_once(' ')?;
    civil_ms(date, time, '.')
}

/// `YYYY-MM-DD HH:MM:SS.SSS` in UTC (the journal's time text, SPEC 4).
pub fn journal_time(ms: i64) -> String {
    let secs = u64::try_from(ms.div_euclid(1000)).unwrap_or(0);
    let iso = crate::logging::utc_timestamp(secs);
    format!("{} {}.{:03}", &iso[..10], &iso[11..19], ms.rem_euclid(1000))
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn host_allow_list_matches_exact_hosts_and_subdomains_only() {
        let list = ["api.anthropic.com", "*.oanda.com", "oanda.com"];
        assert!(host_allowed("api.anthropic.com", &list));
        assert!(host_allowed("API.Anthropic.com", &list));
        assert!(host_allowed("api-fxtrade.oanda.com", &list));
        assert!(host_allowed("oanda.com", &list));
        assert!(!host_allowed("evil-oanda.com", &list));
        assert!(!host_allowed("oanda.com.evil.net", &list));
        assert!(!host_allowed("anthropic.com", &list));
        assert!(!host_allowed(".oanda.com", &list));
    }

    #[test]
    fn urls_must_be_secure_allowed_and_credential_free() {
        let list = ["api.anthropic.com"];
        let strict = NetPolicy::STRICT;
        assert!(checked_url("https://api.anthropic.com/v1/models", &list, strict).is_ok());
        for bad in [
            "http://api.anthropic.com/v1/models",
            "https://api.anthropic.com.evil.net/",
            "https://user:pw@api.anthropic.com/",
            "http://127.0.0.1:9/",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert_eq!(
                checked_url(bad, &list, strict).unwrap_err().code,
                "blocked_host",
                "{bad}"
            );
        }
        let tests = NetPolicy::LOOPBACK_FOR_TESTS;
        assert!(checked_url("http://127.0.0.1:9/x", &list, tests).is_ok());
        assert!(checked_url("ws://localhost:9/x", &list, tests).is_ok());
        assert!(checked_url("http://10.0.0.1/x", &list, tests).is_err());
        assert!(!strict.allows_loopback());
    }

    #[test]
    fn status_codes_map_to_stable_error_codes() {
        assert_eq!(status_error("X", 401, None).code, "invalid_key");
        assert_eq!(status_error("X", 403, None).code, "invalid_key");
        let limited = status_error("X", 429, Some(7));
        assert_eq!(
            (limited.code, limited.retry_after_secs),
            ("rate_limited", Some(7))
        );
        assert!(limited.message.contains("7 s"));
        assert_eq!(status_error("X", 503, None).code, "unavailable");
        assert_eq!(status_error("X", 529, None).code, "unavailable");
        assert_eq!(status_error("X", 404, None).code, "http");
    }

    #[test]
    fn retry_after_reads_seconds_and_caps_them() {
        let mut h = HeaderMap::new();
        assert_eq!(retry_after(&h), None);
        h.insert(RETRY_AFTER, "12".parse().unwrap());
        assert_eq!(retry_after(&h), Some(12));
        h.insert(RETRY_AFTER, "999999".parse().unwrap());
        assert_eq!(retry_after(&h), Some(3600));
        h.insert(
            RETRY_AFTER,
            "Wed, 21 Oct 2026 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after(&h), None);
    }

    #[test]
    fn backoff_doubles_up_to_a_minute() {
        let s = Duration::from_secs(1);
        let waits: Vec<u64> = (1..=10).map(|a| backoff_delay(a, s).as_secs()).collect();
        assert_eq!(waits, [2, 4, 8, 16, 32, 60, 60, 60, 60, 60]);
        assert_eq!(backoff_delay(1000, s).as_secs(), 60);
    }

    #[test]
    fn provider_text_removes_secrets_and_control_characters() {
        let text = format!("bad key sk-fictional-1234\u{0007} {}", "x".repeat(400));
        let safe = provider_text(&text, &["sk-fictional-1234", ""]);
        assert!(!safe.contains("sk-fictional"));
        assert!(safe.starts_with("bad key [redacted] "));
        assert!(!safe.contains('\u{0007}'));
        assert_eq!(safe.chars().count(), 300);
    }

    #[test]
    fn rfc3339_and_mt5_times_parse_to_utc_milliseconds() {
        let t = parse_rfc3339_ms("2026-10-26T12:30:00Z").unwrap();
        assert_eq!(t, 1_793_017_800_000);
        assert_eq!(parse_rfc3339_ms("2026-10-26T08:30:00-04:00"), Some(t));
        assert_eq!(parse_rfc3339_ms("2026-10-26T14:00:00+01:30"), Some(t));
        assert_eq!(
            parse_rfc3339_ms("2026-10-26T12:30:00.123456789Z"),
            Some(t + 123)
        );
        assert_eq!(parse_rfc3339_ms("2026-10-26T12:30:00.5Z"), Some(t + 500));
        for bad in [
            "",
            "2026-10-26",
            "2026-13-26T12:30:00Z",
            "2026-10-26T25:30:00Z",
            "2026-10-26T12:30:00",
            "2026-10-26T12:30:00+99:00",
            "2026-10-26T12:30:00.x1Z",
            "２０２６-10-26T12:30:00Z",
        ] {
            assert_eq!(parse_rfc3339_ms(bad), None, "{bad}");
        }
        assert_eq!(parse_mt5_time_ms("2026.10.26 12:30:00"), Some(t));
        assert_eq!(parse_mt5_time_ms("2026-10-26 12:30:00"), None);
        assert_eq!(parse_mt5_time_ms("garbage"), None);
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
    }

    #[test]
    fn echoed_keys_are_refused() {
        let ok = no_echo(vec!["EUR/USD".to_string()], "X", &["sk-fictional-9"]).unwrap();
        assert_eq!(ok, ["EUR/USD"]);
        let e = no_echo(
            vec!["has sk-fictional-9".to_string()],
            "X",
            &["sk-fictional-9"],
        );
        assert_eq!(e.unwrap_err().code, "bad_response");
        assert!(
            no_echo("abc", "X", &["", "ab"]).is_ok(),
            "too short to match"
        );
    }

    #[test]
    fn journal_time_text() {
        assert_eq!(journal_time(1_793_017_800_123), "2026-10-26 12:30:00.123");
    }
}
