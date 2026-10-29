//! Twelve Data: REST quotes polled every 120 s and the WebSocket price stream (Dojix, SPEC 8.3).
//! Mac: `Services/LiveData/TwelveDataService.swift`, `TwelveDataWebSocket.swift`, and
//! `TwelveDataRESTProvider` in `LiveDataManager.swift`.
//!
//! Differences (PARITY B2): the REST key goes in the `Authorization: apikey …` header instead of
//! the URL, and the daily budget is persisted and counted in credits (one per symbol).

use std::sync::Arc;

use serde_json::Value;

use super::quotes::{
    normalize_symbol, reconnecting, ws_session, PriceTick, StreamStatus, StreamTiming, TickSink,
    WsEvent, WsProtocol,
};
use super::usage::DailyCounter;
use super::{checked_url, fetch, status_error, NetError, NetPolicy};

pub const PROVIDER: &str = "Twelve Data";
pub const HOSTS: &[&str] = &["api.twelvedata.com", "ws.twelvedata.com"];
pub const REST_BASE: &str = "https://api.twelvedata.com";
pub const WS_URL: &str = "wss://ws.twelvedata.com/v1/quotes/price";
const MAX_BODY: usize = 1024 * 1024;
/// The REST provider's synthetic half-spread (`TwelveDataRESTProvider`: close ± 0.00005).
pub const REST_HALF_SPREAD: f64 = 0.00005;

/// `TwelveDataService.Quote`.
#[derive(Debug, Clone, PartialEq)]
pub struct Quote {
    pub symbol: String,
    pub close: f64,
    pub change_percent: f64,
}

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
    .filter(|x| x.is_finite())
}

/// `parseQuote`: `close` is required; a missing change is 0.
fn parse_quote(entry: &Value, symbol: &str) -> Option<Quote> {
    if entry.get("status").and_then(Value::as_str) == Some("error") {
        return None;
    }
    Some(Quote {
        symbol: symbol.to_string(),
        close: number(entry.get("close")?)?,
        change_percent: entry.get("percent_change").and_then(number).unwrap_or(0.0),
    })
}

/// A Twelve Data error object (`{"status":"error","code":401,"message":…}`, sent with HTTP 200).
fn api_error(json: &Value) -> Option<NetError> {
    if json.get("status").and_then(Value::as_str) != Some("error") {
        return None;
    }
    let code = json.get("code").and_then(Value::as_u64).unwrap_or(0);
    Some(match code {
        401 | 403 => status_error(PROVIDER, 401, None),
        429 => status_error(PROVIDER, 429, None),
        _ => NetError::bad_response(PROVIDER),
    })
}

/// `getQuotes`: one request for every symbol. A single symbol's answer is one object; several
/// symbols' answer is keyed by symbol (entries that fail are skipped, as on the Mac).
pub fn parse_quotes(json: &Value, symbols: &[String]) -> Result<Vec<Quote>, NetError> {
    if let Some(e) = api_error(json) {
        return Err(e);
    }
    if symbols.len() == 1 {
        return parse_quote(json, &symbols[0])
            .map(|q| vec![q])
            .ok_or_else(|| NetError::bad_response(PROVIDER));
    }
    let map = json.as_object().ok_or_else(|| NetError::bad_response(PROVIDER))?;
    Ok(symbols
        .iter()
        .filter_map(|s| map.get(s).and_then(|entry| parse_quote(entry, s)))
        .collect())
}

/// `GET /quote?symbol=A,B` with the key in a header. Spends one credit per symbol.
pub async fn get_quotes(
    http: &reqwest::Client,
    base: &str,
    policy: NetPolicy,
    key: &str,
    symbols: &[String],
    budget: &DailyCounter,
) -> Result<Vec<Quote>, NetError> {
    let credits = u32::try_from(symbols.len()).unwrap_or(u32::MAX);
    let now = crate::journal::now_ms();
    budget.check(credits, now)?;
    let mut url = checked_url(&format!("{}/quote", base.trim_end_matches('/')), HOSTS, policy)?;
    url.query_pairs_mut()
        .append_pair("symbol", &symbols.join(","));
    let request = http
        .get(url)
        .header("Authorization", format!("apikey {key}"));
    let got = fetch(PROVIDER, request, MAX_BODY).await?;
    if got.status != 200 {
        return Err(status_error(PROVIDER, got.status, super::retry_after(&got.headers)));
    }
    budget.record(credits, now);
    let json: Value =
        serde_json::from_slice(&got.body).map_err(|_| NetError::bad_response(PROVIDER))?;
    parse_quotes(&json, symbols)
}

/// The REST source: polls every [`StreamTiming::poll_interval`]; transient errors keep polling
/// (as on the Mac), a refused key or an exhausted budget stops it.
#[allow(clippy::too_many_arguments)]
pub async fn poll(
    http: reqwest::Client,
    base: String,
    policy: NetPolicy,
    key: zeroize::Zeroizing<String>,
    symbols: Vec<String>,
    budget: Arc<DailyCounter>,
    timing: StreamTiming,
    sink: Arc<dyn TickSink>,
) {
    sink.status(StreamStatus::Connecting);
    loop {
        match get_quotes(&http, &base, policy, &key, &symbols, &budget).await {
            Ok(quotes) => {
                sink.status(StreamStatus::Connected);
                let now = crate::journal::now_ms();
                for q in quotes {
                    if let Some(mut t) = PriceTick::new(
                        &q.symbol,
                        q.close - REST_HALF_SPREAD,
                        q.close + REST_HALF_SPREAD,
                        now,
                    ) {
                        t.change_percent = Some(q.change_percent);
                        sink.tick(t);
                    }
                }
            }
            Err(e) if matches!(e.code, "invalid_key" | "rate_limited" | "blocked_host") => {
                sink.status(StreamStatus::Error { message: e.message });
                return;
            }
            Err(e) => log::info!("Twelve Data poll failed ({}); retrying", e.code),
        }
        tokio::time::sleep(timing.poll_interval).await;
    }
}

/// `TwelveDataWebSocket`: subscribe with the key in the message (as on the Mac), answer with a
/// heartbeat every 10 s, read `price` events.
pub struct Ws {
    pub key: zeroize::Zeroizing<String>,
    pub symbols: Vec<String>,
}

impl WsProtocol for Ws {
    fn auth(&self) -> Option<String> {
        None
    }

    fn subscribe(&self) -> String {
        serde_json::json!({
            "action": "subscribe",
            "params": { "symbols": self.symbols.join(","), "apikey": self.key.as_str() }
        })
        .to_string()
    }

    fn heartbeat(&self) -> Option<String> {
        Some(r#"{"action":"heartbeat"}"#.to_string())
    }

    fn parse(&self, text: &str, now_ms: i64) -> WsEvent {
        let Ok(json) = serde_json::from_str::<Value>(text) else {
            return WsEvent::Ignore;
        };
        match json.get("event").and_then(Value::as_str) {
            Some("price") => {
                let Some(symbol) = json.get("symbol").and_then(Value::as_str) else {
                    return WsEvent::Ignore;
                };
                // The Mac reads bid/ask as strings; numbers are accepted too.
                let (bid, ask) = match (
                    json.get("bid").and_then(number),
                    json.get("ask").and_then(number),
                ) {
                    (Some(b), Some(a)) => (b, a),
                    _ => return WsEvent::Ignore,
                };
                let ts = json
                    .get("timestamp")
                    .and_then(Value::as_f64)
                    .filter(|t| *t > 0.0 && *t < 1e11)
                    .map_or(now_ms, |t| (t * 1000.0) as i64);
                match PriceTick::new(symbol, bid, ask, ts) {
                    Some(t) => WsEvent::Ticks(vec![t]),
                    None => WsEvent::Ignore,
                }
            }
            Some("subscribe-status") => {
                let refused = json.get("status").and_then(Value::as_str) == Some("error");
                let none_ok = json
                    .get("success")
                    .and_then(Value::as_array)
                    .is_some_and(|a| a.is_empty());
                let some_failed = json
                    .get("fails")
                    .and_then(Value::as_array)
                    .is_some_and(|f| !f.is_empty());
                let failed = refused || (none_ok && some_failed);
                if failed {
                    WsEvent::Refused(
                        "Twelve Data refused the subscription. Check the key and the plan in Settings."
                            .into(),
                    )
                } else {
                    WsEvent::Ignore
                }
            }
            _ => WsEvent::Ignore,
        }
    }
}

/// The WebSocket source.
pub async fn stream(
    url: reqwest::Url,
    policy: NetPolicy,
    proto: Ws,
    timing: StreamTiming,
    sink: Arc<dyn TickSink>,
) {
    reconnecting(sink.as_ref(), timing, || {
        ws_session(&proto, &url, policy, HOSTS, timing, sink.as_ref())
    })
    .await;
}

/// The symbols Twelve Data expects (`EUR/USD`).
pub fn provider_symbols(symbols: &[String]) -> Vec<String> {
    symbols
        .iter()
        .filter_map(|s| normalize_symbol(s))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn syms(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn single_and_batch_quotes_parse_like_the_mac() {
        let one = json!({"symbol": "EUR/USD", "close": "1.08512", "percent_change": "-0.25"});
        let q = parse_quotes(&one, &syms(&["EUR/USD"])).unwrap();
        assert_eq!(q, [Quote { symbol: "EUR/USD".into(), close: 1.08512, change_percent: -0.25 }]);

        let batch = json!({
            "EUR/USD": {"close": "1.1", "percent_change": "0.5"},
            "GBP/USD": {"close": "oops"},
            "USD/JPY": {"status": "error", "message": "not in plan"},
            "AUD/USD": {"close": 0.66}
        });
        let q = parse_quotes(&batch, &syms(&["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "NZD/USD"])).unwrap();
        let got: Vec<&str> = q.iter().map(|q| q.symbol.as_str()).collect();
        assert_eq!(got, ["EUR/USD", "AUD/USD"]);
        assert_eq!(q[1].change_percent, 0.0);

        assert_eq!(parse_quotes(&json!({"close": "x"}), &syms(&["EUR/USD"])).unwrap_err().code, "bad_response");
        assert_eq!(parse_quotes(&json!([1, 2]), &syms(&["A", "B"])).unwrap_err().code, "bad_response");
    }

    #[test]
    fn error_objects_map_to_codes() {
        let e = |code: u64| json!({"status": "error", "code": code, "message": "fictional"});
        assert_eq!(parse_quotes(&e(401), &syms(&["EUR/USD"])).unwrap_err().code, "invalid_key");
        assert_eq!(parse_quotes(&e(429), &syms(&["EUR/USD", "GBP/USD"])).unwrap_err().code, "rate_limited");
        assert_eq!(parse_quotes(&e(400), &syms(&["EUR/USD"])).unwrap_err().code, "bad_response");
    }

    #[test]
    fn websocket_messages() {
        let ws = Ws { key: zeroize::Zeroizing::new("td-fictional".into()), symbols: syms(&["EUR/USD", "GBP/USD"]) };
        let sub: Value = serde_json::from_str(&ws.subscribe()).unwrap();
        assert_eq!(sub, json!({"action": "subscribe", "params": {"symbols": "EUR/USD,GBP/USD", "apikey": "td-fictional"}}));
        assert!(ws.auth().is_none());
        assert_eq!(ws.heartbeat().as_deref(), Some(r#"{"action":"heartbeat"}"#));

        let price = r#"{"event":"price","symbol":"EUR/USD","bid":"1.1","ask":"1.1002","timestamp":1793017800}"#;
        match ws.parse(price, 0) {
            WsEvent::Ticks(t) => {
                assert_eq!(t[0].symbol, "EUR/USD");
                assert_eq!(t[0].timestamp_ms, 1_793_017_800_000);
            }
            other => panic!("{other:?}"),
        }
        let numeric = r#"{"event":"price","symbol":"EURUSD","bid":1.1,"ask":1.2}"#;
        assert!(matches!(ws.parse(numeric, 77), WsEvent::Ticks(ref t) if t[0].timestamp_ms == 77));
        for ignored in [
            "not json",
            r#"{"event":"heartbeat","status":"ok"}"#,
            r#"{"event":"price","symbol":"EUR/USD","price":1.1}"#,
            r#"{"event":"price","bid":"1","ask":"2"}"#,
            r#"{"event":"price","symbol":"EUR/USD","bid":"NaN","ask":"1"}"#,
            r#"{"event":"subscribe-status","status":"ok","success":[{"symbol":"EUR/USD"}],"fails":[]}"#,
        ] {
            assert_eq!(ws.parse(ignored, 0), WsEvent::Ignore, "{ignored}");
        }
        assert!(matches!(
            ws.parse(r#"{"event":"subscribe-status","status":"error","message":"key"}"#, 0),
            WsEvent::Refused(_)
        ));
        assert!(matches!(
            ws.parse(r#"{"event":"subscribe-status","status":"ok","success":[],"fails":[{"symbol":"EUR/USD"}]}"#, 0),
            WsEvent::Refused(_)
        ));
        assert_eq!(provider_symbols(&syms(&["eurusd", ""])), ["EUR/USD"]);
    }
}
