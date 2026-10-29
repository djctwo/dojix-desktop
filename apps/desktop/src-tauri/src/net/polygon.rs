//! Polygon.io forex WebSocket (Dojix, SPEC 8.3). Mac: `Services/LiveData/PolygonWebSocket.swift`
//! and the REST check in `SettingsViewModel.testDataSource`.
//!
//! The key goes in the `auth` message (as on the Mac); the REST check sends it as a bearer
//! token. Fix (logged in PARITY): Polygon sends a `connected` status before the auth answer;
//! the Mac reads only the first message and so treats every connection as an auth failure.
//! Here the stream waits for `auth_success` / `auth_failed`.

use std::sync::Arc;

use serde_json::Value;

use super::quotes::{
    reconnecting, ws_session, PriceTick, StreamTiming, TickSink, WsEvent, WsProtocol,
};
use super::{checked_url, fetch, status_error, NetError, NetPolicy};

pub const PROVIDER: &str = "Polygon.io";
/// The endpoint names in use when this was written; the provider has announced a rename, so
/// they are listed in one place (SPEC 8.3 "checked at build time").
pub const HOSTS: &[&str] = &["socket.polygon.io", "api.polygon.io"];
pub const WS_URL: &str = "wss://socket.polygon.io/forex";
pub const REST_BASE: &str = "https://api.polygon.io";
const MAX_BODY: usize = 256 * 1024;

pub struct Ws {
    pub key: zeroize::Zeroizing<String>,
    pub symbols: Vec<String>,
}

impl WsProtocol for Ws {
    fn auth(&self) -> Option<String> {
        Some(serde_json::json!({"action": "auth", "params": self.key.as_str()}).to_string())
    }

    /// `C.EUR/USD,C.GBP/USD` (forex quotes channel).
    fn subscribe(&self) -> String {
        let params = self
            .symbols
            .iter()
            .map(|s| format!("C.{s}"))
            .collect::<Vec<_>>()
            .join(",");
        serde_json::json!({"action": "subscribe", "params": params}).to_string()
    }

    fn heartbeat(&self) -> Option<String> {
        None
    }

    fn parse(&self, text: &str, _now_ms: i64) -> WsEvent {
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(text) else {
            return WsEvent::Ignore;
        };
        let mut ticks = Vec::new();
        for item in &items {
            match item.get("ev").and_then(Value::as_str) {
                Some("status") => match item.get("status").and_then(Value::as_str) {
                    Some("auth_success") => return WsEvent::AuthOk,
                    Some("auth_failed") => {
                        return WsEvent::Refused(
                            "Polygon.io did not accept the key. Check it in Settings.".into(),
                        )
                    }
                    _ => {}
                },
                Some("C") => {
                    let pair = item.get("p").and_then(Value::as_str);
                    let bid = item.get("b").and_then(Value::as_f64);
                    let ask = item.get("a").and_then(Value::as_f64);
                    let t = item.get("t").and_then(Value::as_f64);
                    if let (Some(pair), Some(bid), Some(ask), Some(t)) = (pair, bid, ask, t) {
                        if (0.0..1e14).contains(&t) {
                            if let Some(tick) = PriceTick::new(pair, bid, ask, t as i64) {
                                ticks.push(tick);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if ticks.is_empty() {
            WsEvent::Ignore
        } else {
            WsEvent::Ticks(ticks)
        }
    }
}

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

/// Settings → Test: `GET /v2/last/nbbo/C:EURUSD` with the key as a bearer token.
pub async fn test(
    http: &reqwest::Client,
    base: &str,
    policy: NetPolicy,
    key: &str,
) -> Result<String, NetError> {
    let url = checked_url(
        &format!("{}/v2/last/nbbo/C:EURUSD", base.trim_end_matches('/')),
        HOSTS,
        policy,
    )?;
    let got = fetch(PROVIDER, http.get(url).bearer_auth(key), MAX_BODY).await?;
    match got.status {
        200 => Ok("Connected to Polygon.io".to_string()),
        s => Err(status_error(PROVIDER, s, super::retry_after(&got.headers))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_subscribe_and_quotes() {
        let ws = Ws {
            key: zeroize::Zeroizing::new("pg-fictional".into()),
            symbols: vec!["EUR/USD".into(), "GBP/USD".into()],
        };
        assert_eq!(
            ws.auth().unwrap(),
            r#"{"action":"auth","params":"pg-fictional"}"#
        );
        assert_eq!(
            ws.subscribe(),
            r#"{"action":"subscribe","params":"C.EUR/USD,C.GBP/USD"}"#
        );
        assert!(ws.heartbeat().is_none());

        let connected =
            r#"[{"ev":"status","status":"connected","message":"Connected Successfully"}]"#;
        assert_eq!(ws.parse(connected, 0), WsEvent::Ignore);
        let ok = r#"[{"ev":"status","status":"auth_success","message":"authenticated"}]"#;
        assert_eq!(ws.parse(ok, 0), WsEvent::AuthOk);
        let bad = r#"[{"ev":"status","status":"auth_failed","message":"authentication failed"}]"#;
        assert!(matches!(ws.parse(bad, 0), WsEvent::Refused(_)));

        let quotes = r#"[{"ev":"C","p":"EUR/USD","b":1.1,"a":1.1002,"t":1793017800000},
                         {"ev":"C","p":"GBP/USD","b":"1.2","a":1.3,"t":1},
                         {"ev":"C","p":"USD/JPY","b":150.1,"a":150.2,"t":-5},
                         {"ev":"XQ"}]"#;
        match ws.parse(quotes, 0) {
            WsEvent::Ticks(t) => {
                assert_eq!(t.len(), 1);
                assert_eq!(t[0].timestamp_ms, 1_793_017_800_000);
            }
            other => panic!("{other:?}"),
        }
        for ignored in ["{}", "nope", "[]", r#"[{"ev":"C"}]"#] {
            assert_eq!(ws.parse(ignored, 0), WsEvent::Ignore);
        }
    }
}
