//! OANDA v20 (Dojix): the pricing stream (SPEC 8.3) and the history import (SPEC 8.4).
//! Mac: `Services/LiveData/OANDAStreamService.swift`, `Services/Import/OANDAService.swift`.
//!
//! - Every URL, page URLs from the API included, must be HTTPS on `oanda.com` / `*.oanda.com`
//!   (`OANDAService.isTrustedOANDAURL`); the account ID must match `[A-Za-z0-9-]{1,64}`.
//! - The token goes in `Authorization: Bearer`.
//! - The import returns the raw `ORDER_FILL` transactions; the web view maps them with
//!   `@dojix-desktop/importers` (`mapOandaTransactions`: units ÷ 100,000 = lots) and commits
//!   them like any other import (origin `oanda`).

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::quotes::{reconnecting, PriceTick, SessionEnd, StreamStatus, StreamTiming, TickSink};
use super::secrets::valid_oanda_account;
use super::{checked_url, fetch, fetch_json, status_error, transport_error, NetError, NetPolicy};

pub const PROVIDER: &str = "OANDA";
pub const HOSTS: &[&str] = &["oanda.com", "*.oanda.com"];
pub const REST_PRACTICE: &str = "https://api-fxpractice.oanda.com";
pub const REST_LIVE: &str = "https://api-fxtrade.oanda.com";
pub const STREAM_PRACTICE: &str = "https://stream-fxpractice.oanda.com";
pub const STREAM_LIVE: &str = "https://stream-fxtrade.oanda.com";

const MAX_SMALL_BODY: usize = 1024 * 1024;
const MAX_PAGE_BODY: usize = 16 * 1024 * 1024;
const MAX_PAGES: usize = 1000;
/// The most transactions one import reads.
pub const MAX_TRANSACTIONS: usize = 500_000;
/// The longest line accepted from the pricing stream.
pub const MAX_STREAM_LINE: usize = 64 * 1024;

fn account(id: &str) -> Result<&str, NetError> {
    if valid_oanda_account(id) {
        Ok(id)
    } else {
        Err(NetError::invalid(
            "The OANDA account ID has letters, digits and dashes only.",
        ))
    }
}

fn base_url(base: &str, path: &str, policy: NetPolicy) -> Result<reqwest::Url, NetError> {
    checked_url(
        &format!("{}{path}", base.trim_end_matches('/')),
        HOSTS,
        policy,
    )
}

/// Settings → Test (import): the account summary, as on the Mac ("Connected — USD account").
pub async fn account_summary(
    http: &reqwest::Client,
    rest: &str,
    policy: NetPolicy,
    token: &str,
    account_id: &str,
) -> Result<String, NetError> {
    let id = account(account_id)?;
    let url = base_url(rest, &format!("/v3/accounts/{id}/summary"), policy)?;
    let json = fetch_json(
        PROVIDER,
        http.get(url)
            .bearer_auth(token)
            .header("Accept", "application/json"),
        MAX_SMALL_BODY,
    )
    .await?;
    let currency = json
        .get("account")
        .and_then(|a| a.get("currency"))
        .and_then(Value::as_str)
        .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()))
        .ok_or_else(|| NetError::bad_response(PROVIDER))?;
    Ok(format!("Connected — {currency} account"))
}

/// Settings → Test (stream source): `GET /v3/accounts/{id}/pricing?instruments=EUR_USD`.
pub async fn pricing_test(
    http: &reqwest::Client,
    rest: &str,
    policy: NetPolicy,
    token: &str,
    account_id: &str,
    live: bool,
) -> Result<String, NetError> {
    let id = account(account_id)?;
    let mut url = base_url(rest, &format!("/v3/accounts/{id}/pricing"), policy)?;
    url.query_pairs_mut().append_pair("instruments", "EUR_USD");
    let got = fetch(PROVIDER, http.get(url).bearer_auth(token), MAX_SMALL_BODY).await?;
    match got.status {
        200 => Ok(format!(
            "Connected to OANDA {}",
            if live { "Live" } else { "Practice" }
        )),
        s => Err(status_error(PROVIDER, s, super::retry_after(&got.headers))),
    }
}

/// What the import hands to the web view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OandaHistory {
    /// The `ORDER_FILL` transactions, in API order (input for `decodeOandaPage` /
    /// `mapOandaTransactions`).
    pub transactions: Vec<Value>,
    pub pages: usize,
    pub from: String,
}

/// `GET /v3/accounts/{id}/transactions?type=ORDER_FILL&from=…`, then every page URL it lists.
pub async fn fetch_history(
    http: &reqwest::Client,
    rest: &str,
    policy: NetPolicy,
    token: &str,
    account_id: &str,
    days: u32,
    now_ms: i64,
) -> Result<OandaHistory, NetError> {
    let id = account(account_id)?;
    let from_secs = u64::try_from(now_ms / 1000 - i64::from(days) * 86_400).unwrap_or(0);
    let from = crate::logging::utc_timestamp(from_secs);
    let mut url = base_url(rest, &format!("/v3/accounts/{id}/transactions"), policy)?;
    url.query_pairs_mut()
        .append_pair("type", "ORDER_FILL")
        .append_pair("from", &from);
    let index = fetch_json(
        PROVIDER,
        http.get(url)
            .bearer_auth(token)
            .header("Accept", "application/json"),
        MAX_SMALL_BODY,
    )
    .await?;
    let pages = index
        .get("pages")
        .and_then(Value::as_array)
        .ok_or_else(|| NetError::bad_response(PROVIDER))?;
    if pages.len() > MAX_PAGES {
        return Err(NetError::too_large(PROVIDER));
    }
    // Validate every page URL before sending the token anywhere.
    let page_urls = pages
        .iter()
        .map(|p| {
            p.as_str()
                .ok_or_else(|| NetError::bad_response(PROVIDER))
                .and_then(|s| checked_url(s, HOSTS, policy))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut transactions = Vec::new();
    for page_url in page_urls {
        let page = fetch_json(
            PROVIDER,
            http.get(page_url)
                .bearer_auth(token)
                .header("Accept", "application/json"),
            MAX_PAGE_BODY,
        )
        .await?;
        let Some(Value::Array(items)) = page.get("transactions").cloned() else {
            return Err(NetError::bad_response(PROVIDER));
        };
        if transactions.len() + items.len() > MAX_TRANSACTIONS {
            return Err(NetError::too_large(PROVIDER));
        }
        transactions.extend(items.into_iter().filter(Value::is_object));
    }
    log::info!("OANDA import fetched {} transaction(s)", transactions.len());
    Ok(OandaHistory {
        pages: pages.len(),
        transactions,
        from,
    })
}

/// One line of the pricing stream: a `PRICE` becomes a tick; `HEARTBEAT`s and anything
/// malformed are skipped.
pub fn parse_stream_line(line: &str, now_ms: i64) -> Option<PriceTick> {
    let json: Value = serde_json::from_str(line).ok()?;
    if json.get("type").and_then(Value::as_str) != Some("PRICE") {
        return None;
    }
    let instrument = json.get("instrument")?.as_str()?;
    let first = |side: &str| -> Option<f64> {
        json.get(side)?
            .as_array()?
            .first()?
            .get("price")?
            .as_str()?
            .parse::<f64>()
            .ok()
    };
    let (bid, ask) = (first("bids")?, first("asks")?);
    let ts = json
        .get("time")
        .and_then(Value::as_str)
        .and_then(super::parse_rfc3339_ms)
        .unwrap_or(now_ms);
    PriceTick::new(&instrument.replace('_', "/"), bid, ask, ts)
}

/// Splits complete lines off `buffer`. `None` when a line is longer than [`MAX_STREAM_LINE`].
pub fn take_lines(buffer: &mut Vec<u8>) -> Option<Vec<String>> {
    let mut lines = Vec::new();
    while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buffer.drain(..=pos).collect();
        let text = String::from_utf8_lossy(&line).trim().to_string();
        if !text.is_empty() {
            lines.push(text);
        }
    }
    if buffer.len() > MAX_STREAM_LINE {
        return None;
    }
    Some(lines)
}

/// The OANDA pricing stream (`GET {stream}/v3/accounts/{id}/pricing/stream?instruments=…`).
#[allow(clippy::too_many_arguments)]
pub async fn stream(
    http: reqwest::Client,
    stream_base: String,
    policy: NetPolicy,
    token: zeroize::Zeroizing<String>,
    account_id: String,
    symbols: Vec<String>,
    timing: StreamTiming,
    sink: Arc<dyn TickSink>,
) {
    let url = account(&account_id)
        .and_then(|id| {
            base_url(
                &stream_base,
                &format!("/v3/accounts/{id}/pricing/stream"),
                policy,
            )
        })
        .map(|mut u| {
            let instruments = symbols
                .iter()
                .map(|s| s.replace('/', "_"))
                .collect::<Vec<_>>()
                .join(",");
            u.query_pairs_mut().append_pair("instruments", &instruments);
            u
        });
    let url = match url {
        Ok(u) => u,
        Err(e) => {
            sink.status(StreamStatus::Error { message: e.message });
            return;
        }
    };
    reconnecting(sink.as_ref(), timing, || {
        session(&http, &url, &token, timing, sink.as_ref())
    })
    .await;
}

async fn session(
    http: &reqwest::Client,
    url: &reqwest::Url,
    token: &str,
    timing: StreamTiming,
    sink: &dyn TickSink,
) -> SessionEnd {
    let request = http.get(url.clone()).bearer_auth(token);
    let response = match tokio::time::timeout(timing.connect_timeout, request.send()).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            log::info!("OANDA stream: {}", transport_error(PROVIDER, &e).code);
            return SessionEnd::Dropped {
                was_connected: false,
            };
        }
        Err(_) => {
            return SessionEnd::Dropped {
                was_connected: false,
            }
        }
    };
    match response.status().as_u16() {
        200 => {}
        401 | 403 => {
            return SessionEnd::Fatal(status_error(PROVIDER, 401, None).message);
        }
        s => {
            log::info!("OANDA stream answered HTTP {s}");
            return SessionEnd::Dropped {
                was_connected: false,
            };
        }
    }
    sink.status(StreamStatus::Connected);
    let mut response = response;
    let mut buffer = Vec::new();
    loop {
        let chunk = tokio::time::timeout(timing.idle_timeout, response.chunk()).await;
        match chunk {
            Ok(Ok(Some(bytes))) => {
                buffer.extend_from_slice(&bytes);
                let Some(lines) = take_lines(&mut buffer) else {
                    return SessionEnd::Dropped {
                        was_connected: true,
                    };
                };
                let now = crate::journal::now_ms();
                for line in lines {
                    if let Some(t) = parse_stream_line(&line, now) {
                        sink.tick(t);
                    }
                }
            }
            // A clean end (the server closed the stream), an error or silence: reconnect.
            Ok(Ok(None)) | Ok(Err(_)) | Err(_) => {
                return SessionEnd::Dropped {
                    was_connected: true,
                }
            }
        }
    }
}

/// The read timeout for the stream client (OANDA sends a heartbeat every 5 s).
pub const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_lines_become_ticks() {
        let price = r#"{"type":"PRICE","time":"2026-10-26T12:30:00.123456789Z","bids":[{"price":"1.08510","liquidity":1000000}],"asks":[{"price":"1.08522","liquidity":1000000}],"instrument":"EUR_USD","tradeable":true}"#;
        let t = parse_stream_line(price, 0).unwrap();
        assert_eq!(t.symbol, "EUR/USD");
        assert_eq!(t.timestamp_ms, 1_793_017_800_123);
        assert!((t.bid - 1.0851).abs() < 1e-12 && (t.ask - 1.08522).abs() < 1e-12);
        for skipped in [
            r#"{"type":"HEARTBEAT","time":"2026-10-26T12:30:05Z"}"#,
            r#"{"type":"PRICE","instrument":"EUR_USD","bids":[],"asks":[{"price":"1"}]}"#,
            r#"{"type":"PRICE","instrument":"EUR_USD","bids":[{"price":"x"}],"asks":[{"price":"1"}]}"#,
            "not json",
        ] {
            assert!(parse_stream_line(skipped, 0).is_none(), "{skipped}");
        }
        let no_time = r#"{"type":"PRICE","bids":[{"price":"1"}],"asks":[{"price":"2"}],"instrument":"GBP_USD"}"#;
        assert_eq!(parse_stream_line(no_time, 42).unwrap().timestamp_ms, 42);
    }

    #[test]
    fn lines_are_split_across_chunks_and_capped() {
        let mut buf = b"{\"a\":1}\n\n{\"b\"".to_vec();
        assert_eq!(take_lines(&mut buf).unwrap(), ["{\"a\":1}"]);
        buf.extend_from_slice(b":2}\r\n");
        assert_eq!(take_lines(&mut buf).unwrap(), ["{\"b\":2}"]);
        assert!(buf.is_empty());
        let mut huge = vec![b'x'; MAX_STREAM_LINE + 1];
        assert!(take_lines(&mut huge).is_none());
    }

    #[test]
    fn account_ids_are_checked_before_any_url_is_built() {
        assert!(account("101-004-1234567-001").is_ok());
        let long = "x".repeat(65);
        for bad in ["", "../summary", "101/004", "a?b=c", long.as_str()] {
            assert_eq!(account(bad).unwrap_err().code, "invalid", "{bad}");
        }
    }

    #[test]
    fn only_oanda_hosts_over_https() {
        let p = NetPolicy::STRICT;
        assert!(checked_url("https://api-fxtrade.oanda.com/v3/x", HOSTS, p).is_ok());
        assert!(checked_url("https://oanda.com/x", HOSTS, p).is_ok());
        for bad in [
            "http://api-fxtrade.oanda.com/v3/x",
            "https://oanda.com.attacker.example/x",
            "https://notoanda.com/x",
        ] {
            assert!(checked_url(bad, HOSTS, p).is_err(), "{bad}");
        }
    }
}
