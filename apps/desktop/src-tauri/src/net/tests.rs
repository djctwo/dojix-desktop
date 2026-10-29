//! Contract tests for every online endpoint against local mock servers (wiremock for HTTP, a
//! small tungstenite server for WebSockets). **No real network**: every address is loopback.
//!
//! For each HTTP endpoint the failure matrix runs: 401, 429 (+ Retry-After), 503, a timeout,
//! malformed JSON and an oversized body. The "no secret leaves" tests store canary keys,
//! make every mock echo them back, and check that no result or error the commands would
//! return contains one.

use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use wiremock::matchers::{body_partial_json, header, method, path, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::anthropic::{self, PROMPT_PREFIX, PROMPT_SUFFIX};
use super::calendar::CalendarCache;
use super::online::{Endpoints, Online, Timeouts};
use super::quotes::test_support::{eventually, Collect, FAST};
use super::quotes::{StreamStatus, TickSink};
use super::secrets::{ANTHROPIC, FINNHUB, OANDA_ACCOUNT, OANDA_TOKEN, POLYGON, TWELVE_DATA};
use super::settings::{LiveSource, OnlineSettings};
use super::{NetError, NetPolicy};
use crate::vault::{MemoryVault, SecretStore};

const CANARY_ANTHROPIC: &str = "sk-ant-CANARY-anthropic-0001";
const CANARY_TWELVE: &str = "CANARY-twelve-0002";
const CANARY_POLYGON: &str = "CANARY-polygon-0003";
const CANARY_OANDA: &str = "CANARY-oanda-token-0004";
const CANARY_FINNHUB: &str = "CANARY-finnhub-0005";
const ACCOUNT_ID: &str = "101-004-0000000-001";

const TIMEOUTS: Timeouts = Timeouts {
    request: Duration::from_millis(700),
    ai: Some(Duration::from_millis(700)),
    stream: FAST,
};

fn prompt() -> String {
    format!("{PROMPT_PREFIX}- Total trades: 42\n- Win rate: 55.0%\n\n{PROMPT_SUFFIX}")
}

struct Env {
    server: MockServer,
    online: Online,
    sink: Arc<Collect>,
    _tmp: tempfile::TempDir,
    mt5_dir: PathBuf,
}

struct SinkRef(Arc<Collect>);
impl TickSink for SinkRef {
    fn tick(&self, tick: super::quotes::PriceTick) {
        self.0.tick(tick)
    }
    fn status(&self, status: StreamStatus) {
        self.0.status(status)
    }
}

async fn env_with(brand: &'static str, ws: &str) -> Env {
    let server = MockServer::start().await;
    let vault = Arc::new(MemoryVault::default());
    for (account, value) in [
        (ANTHROPIC, CANARY_ANTHROPIC),
        (TWELVE_DATA, CANARY_TWELVE),
        (POLYGON, CANARY_POLYGON),
        (OANDA_TOKEN, CANARY_OANDA),
        (OANDA_ACCOUNT, ACCOUNT_ID),
        (FINNHUB, CANARY_FINNHUB),
    ] {
        vault.write(account, value.as_bytes()).unwrap();
    }
    let tmp = tempfile::tempdir().unwrap();
    let mt5_dir = tmp.path().join("mt5");
    std::fs::create_dir_all(&mt5_dir).unwrap();
    let sink = Arc::new(Collect::default());
    let online = Online::with(
        brand,
        vault,
        tmp.path(),
        Arc::new(SinkRef(sink.clone())),
        Endpoints::local(&server.uri(), ws),
        NetPolicy::LOOPBACK_FOR_TESTS,
        TIMEOUTS,
        Some(vec![mt5_dir.clone()]),
    );
    Env {
        server,
        online,
        sink,
        _tmp: tmp,
        mt5_dir,
    }
}

async fn env(brand: &'static str) -> Env {
    env_with(brand, "ws://127.0.0.1:9").await
}

fn on() -> OnlineSettings {
    OnlineSettings {
        ai_enabled: true,
        finnhub_enabled: true,
        ..OnlineSettings::default()
    }
}

/// Fails when `value` (serialised as the UI would get it) contains any canary key.
fn assert_no_secret<T: Serialize>(value: &T) {
    let json = serde_json::to_string(value).unwrap();
    for canary in [
        CANARY_ANTHROPIC,
        CANARY_TWELVE,
        CANARY_POLYGON,
        CANARY_OANDA,
        CANARY_FINNHUB,
    ] {
        assert!(!json.contains(canary), "a key leaked: {json}");
    }
    assert!(!json.contains("CANARY"), "a key fragment leaked: {json}");
}

fn json_body(v: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(v)
}

/// The HTTP failure matrix for one endpoint (`verb` + `path_pattern`, a regex).
/// `echo_key` is the provider's own key, which its error bodies repeat.
async fn failure_matrix<T, F, Fut>(
    env: &Env,
    verb: &str,
    path_pattern: &str,
    echo_key: &str,
    call: F,
    huge: usize,
) where
    T: std::fmt::Debug + Serialize,
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, NetError>>,
{
    let echo = format!("invalid key {echo_key}");
    let cases: Vec<(&str, ResponseTemplate, &str)> = vec![
        (
            "401",
            ResponseTemplate::new(401).set_body_json(json!({"error": {"message": echo}})),
            "invalid_key",
        ),
        (
            "429",
            ResponseTemplate::new(429).insert_header("retry-after", "7"),
            "rate_limited",
        ),
        (
            "503",
            ResponseTemplate::new(503).set_body_json(json!({"error": {"message": echo}})),
            "unavailable",
        ),
        (
            "timeout",
            json_body(json!({})).set_delay(Duration::from_secs(3)),
            "timeout",
        ),
        (
            "malformed",
            ResponseTemplate::new(200).set_body_raw("{\"not\": json", "application/json"),
            "bad_response",
        ),
        (
            "huge",
            ResponseTemplate::new(200).set_body_raw(vec![b' '; huge], "application/json"),
            "too_large",
        ),
    ];
    for (name, template, want) in cases {
        env.server.reset().await;
        Mock::given(method(verb))
            .and(path_regex(path_pattern))
            .respond_with(template)
            .mount(&env.server)
            .await;
        let result = call().await;
        let err = match result {
            Ok(v) => panic!("{path_pattern} {name}: expected {want}, got {v:?}"),
            Err(e) => e,
        };
        assert_eq!(err.code, want, "{path_pattern} {name}: {err:?}");
        if name == "429" {
            assert_eq!(err.retry_after_secs, Some(7), "{path_pattern}");
        }
        assert_no_secret(&err);
    }
    env.server.reset().await;
}

// ---------------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------------

fn anthropic_answer(text: &str) -> serde_json::Value {
    json!({
        "id": "msg_fictional",
        "type": "message",
        "role": "assistant",
        "model": "claude-opus-5-5",
        "content": [
            {"type": "thinking", "thinking": ""},
            {"type": "text", "text": text}
        ],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 812, "output_tokens": 455}
    })
}

#[tokio::test]
async fn anthropic_run_sends_exactly_the_previewed_request() {
    let env = env("dojix").await;
    let s = on();
    let preview = env.online.ai_preview(&s, &prompt()).unwrap();
    assert_no_secret(&preview);
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header("x-api-key", CANARY_ANTHROPIC))
        .and(header("anthropic-version", "2023-06-01"))
        .and(header("anthropic-beta", "server-side-fallback-2026-07-01"))
        .and(body_partial_json(json!({
            "model": "claude-opus-5-5",
            "max_tokens": 16000,
            "output_config": {"effort": "medium"},
            "fallbacks": "default"
        })))
        .respond_with(json_body(anthropic_answer(&format!(
            "1. Trade London — fictional — $120\n(echo {CANARY_ANTHROPIC})"
        ))))
        .expect(1)
        .mount(&env.server)
        .await;
    let (request, answer) = env
        .online
        .ai_run(&s, &prompt(), &preview.request_sha256)
        .await
        .unwrap();
    assert_eq!(request.body, preview.body.as_bytes());
    assert!(answer.text.starts_with("1. Trade London"));
    assert!(answer.text.contains("[redacted]"));
    assert_eq!(
        (answer.input_tokens, answer.output_tokens),
        (Some(812), Some(455))
    );
    assert_eq!(answer.model, "claude-opus-5-5");
    assert_no_secret(&answer.text);
    let sent = env.server.received_requests().await.unwrap();
    assert_eq!(sent[0].body, preview.body.as_bytes(), "byte for byte");
}

#[tokio::test]
async fn anthropic_run_gates() {
    let env = env("dojix").await;
    let preview = env.online.ai_preview(&on(), &prompt()).unwrap();
    // Switch off (the default): nothing is sent.
    let off = env
        .online
        .ai_run(
            &OnlineSettings::default(),
            &prompt(),
            &preview.request_sha256,
        )
        .await
        .unwrap_err();
    assert_eq!(off.code, "off");
    // A different request than the one previewed.
    let changed = format!("{PROMPT_PREFIX}- Total trades: 43\n\n{PROMPT_SUFFIX}");
    let e = env
        .online
        .ai_run(&on(), &changed, &preview.request_sha256)
        .await
        .unwrap_err();
    assert_eq!(e.code, "preview_mismatch");
    // Not a summary.
    let e = env
        .online
        .ai_run(&on(), "Send me every trade", "x")
        .await
        .unwrap_err();
    assert_eq!(e.code, "invalid");
    assert!(env.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn anthropic_refusals_and_empty_answers() {
    let env = env("greenwick").await;
    let s = on();
    let preview = env.online.ai_preview(&s, &prompt()).unwrap();
    assert!(!preview.body.contains("fallbacks"));
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(json_body(json!({"content": [], "stop_reason": "refusal"})))
        .up_to_n_times(1)
        .mount(&env.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(json_body(
            json!({"content": [{"type": "text", "text": "  "}]}),
        ))
        .mount(&env.server)
        .await;
    let e = env
        .online
        .ai_run(&s, &prompt(), &preview.request_sha256)
        .await
        .unwrap_err();
    assert_eq!(e.code, "refused");
    let e = env
        .online
        .ai_run(&s, &prompt(), &preview.request_sha256)
        .await
        .unwrap_err();
    assert_eq!(e.code, "empty");
    env.server.reset().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>proxy</html>"))
        .mount(&env.server)
        .await;
    let e = env
        .online
        .ai_run(&s, &prompt(), &preview.request_sha256)
        .await
        .unwrap_err();
    assert_eq!(e.code, "bad_response", "content-type is checked");
    env.server.reset().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(400).set_body_json(
            json!({"type": "error", "error": {"type": "invalid_request_error", "message": format!("model not found {CANARY_ANTHROPIC}")}}),
        ))
        .mount(&env.server)
        .await;
    let e = env
        .online
        .ai_run(&s, &prompt(), &preview.request_sha256)
        .await
        .unwrap_err();
    assert_eq!(e.code, "http");
    assert!(
        e.message.contains("model not found [redacted]"),
        "{}",
        e.message
    );
    assert_no_secret(&e);
}

#[tokio::test]
async fn anthropic_messages_failure_matrix() {
    let env = env("dojix").await;
    let s = on();
    let p = prompt();
    let sha = env.online.ai_preview(&s, &p).unwrap().request_sha256;
    failure_matrix(
        &env,
        "POST",
        "^/v1/messages$",
        CANARY_ANTHROPIC,
        || env.online.ai_run(&s, &p, &sha),
        5 * 1024 * 1024,
    )
    .await;
}

#[tokio::test]
async fn anthropic_models_list_pages_and_failure_matrix() {
    let env = env("dojix").await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(query_param("after_id", "claude-sonnet-5-5"))
        .respond_with(json_body(json!({
            "data": [{"id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5", "type": "model"}],
            "has_more": false, "first_id": "claude-haiku-5-5", "last_id": "claude-haiku-5-5"
        })))
        .mount(&env.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(header("x-api-key", CANARY_ANTHROPIC))
        .respond_with(json_body(json!({
            "data": [
                {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "type": "model"},
                {"id": "NOT A MODEL", "type": "model"},
                {"id": "claude-sonnet-5-5", "type": "model"}
            ],
            "has_more": true, "first_id": "claude-opus-5-5", "last_id": "claude-sonnet-5-5"
        })))
        .mount(&env.server)
        .await;
    let models = env.online.ai_models().await.unwrap();
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
    );
    assert_eq!(models[1].display_name, "claude-sonnet-5-5");
    assert_no_secret(&models);

    let test = env
        .online
        .test_connection("anthropic", &on())
        .await
        .unwrap();
    assert!(test.ok);
    assert_no_secret(&test);

    failure_matrix(
        &env,
        "GET",
        "^/v1/models$",
        CANARY_ANTHROPIC,
        || env.online.ai_models(),
        2 * 1024 * 1024,
    )
    .await;
}

// ---------------------------------------------------------------------------------------------
// Twelve Data
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn twelve_data_rest_uses_the_header_and_counts_credits() {
    let env = env("dojix").await;
    Mock::given(method("GET"))
        .and(path("/td/quote"))
        .and(header(
            "authorization",
            format!("apikey {CANARY_TWELVE}").as_str(),
        ))
        .and(query_param("symbol", "EUR/USD"))
        .respond_with(json_body(
            json!({"symbol": "EUR/USD", "close": "1.08512", "percent_change": "0.1"}),
        ))
        .mount(&env.server)
        .await;
    let before = env.online.credits_left_today();
    let t = env
        .online
        .test_connection("twelve_data", &on())
        .await
        .unwrap();
    assert_eq!(t.message, "Connected — EUR/USD: 1.08512");
    assert_eq!(env.online.credits_left_today(), before - 1);
    let sent = env.server.received_requests().await.unwrap();
    assert!(
        !sent[0].url.as_str().contains(CANARY_TWELVE),
        "never in the URL"
    );

    // A Twelve Data error object (HTTP 200).
    env.server.reset().await;
    Mock::given(method("GET"))
        .and(path("/td/quote"))
        .respond_with(json_body(
            json!({"status": "error", "code": 401, "message": format!("bad {CANARY_TWELVE}")}),
        ))
        .mount(&env.server)
        .await;
    let e = env
        .online
        .test_connection("twelve_data", &on())
        .await
        .unwrap_err();
    assert_eq!(e.code, "invalid_key");
    assert_no_secret(&e);

    let s = on();
    failure_matrix(
        &env,
        "GET",
        "^/td/quote$",
        CANARY_TWELVE,
        || env.online.test_connection("twelve_data", &s),
        2 * 1024 * 1024,
    )
    .await;
}

#[tokio::test]
async fn twelve_data_rest_source_polls_and_stops_on_a_bad_key() {
    let env = env("dojix").await;
    Mock::given(method("GET"))
        .and(path("/td/quote"))
        .respond_with(json_body(json!({
            "EUR/USD": {"close": "1.1", "percent_change": "0.5"},
            "GBP/USD": {"close": "1.3", "percent_change": "-0.2"}
        })))
        .mount(&env.server)
        .await;
    let s = OnlineSettings {
        live_source: LiveSource::TwelveDataRest,
        ..on()
    };
    let started = env
        .online
        .quotes_start(&s, &["EURUSD".into(), "GBP/USD".into()])
        .unwrap();
    assert_eq!(started.symbols, ["EUR/USD", "GBP/USD"]);
    eventually(|| env.sink.ticks.lock().unwrap().len() >= 4).await;
    let st = env.online.quotes_status();
    assert_eq!(st.status, StreamStatus::Connected);
    let eur = st.latest.iter().find(|t| t.symbol == "EUR/USD").unwrap();
    assert!((eur.bid - (1.1 - 0.00005)).abs() < 1e-12);
    assert_eq!(eur.change_percent, Some(0.5));
    assert!(st.credits_left_today.unwrap() < 800);
    assert_no_secret(&st);

    env.server.reset().await;
    Mock::given(method("GET"))
        .and(path("/td/quote"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&env.server)
        .await;
    eventually(|| {
        matches!(
            env.online.quotes_status().status,
            StreamStatus::Error { .. }
        )
    })
    .await;
    env.online.quotes_stop();
}

/// A one-connection-at-a-time WebSocket server running `script` for every connection.
async fn ws_server<F, Fut>(script: F) -> (String, Arc<AtomicUsize>)
where
    F: Fn(tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let script = Arc::new(script);
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            seen.fetch_add(1, Ordering::SeqCst);
            let script = script.clone();
            tokio::spawn(async move {
                if let Ok(ws) = tokio_tungstenite::accept_async(tcp).await {
                    script(ws).await;
                }
            });
        }
    });
    (format!("ws://{addr}"), count)
}

async fn next_text(ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> String {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => return t.as_str().to_string(),
            Some(Ok(_)) => continue,
            _ => return String::new(),
        }
    }
}

#[tokio::test]
async fn twelve_data_websocket_subscribes_streams_and_answers_heartbeats() {
    let subscribed = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = subscribed.clone();
    let (ws_url, _) = ws_server(move |mut ws| {
        let log = log.clone();
        async move {
            let sub = next_text(&mut ws).await;
            log.lock().unwrap().push(sub);
            let _ = ws
                .send(Message::text(r#"{"event":"subscribe-status","status":"ok","success":[{"symbol":"EUR/USD"}],"fails":[]}"#))
                .await;
            let _ = ws
                .send(Message::text(r#"{"event":"price","symbol":"EUR/USD","bid":"1.1","ask":"1.1002","timestamp":1793017800}"#))
                .await;
            let _ = ws.send(Message::text("garbage")).await;
            let heartbeat = next_text(&mut ws).await;
            log.lock().unwrap().push(heartbeat);
            std::future::pending::<()>().await;
        }
    })
    .await;
    let env = env_with("dojix", &ws_url).await;
    let s = OnlineSettings {
        live_source: LiveSource::TwelveDataWs,
        ..on()
    };
    env.online.quotes_start(&s, &["EUR/USD".into()]).unwrap();
    eventually(|| subscribed.lock().unwrap().len() == 2).await;
    let messages = subscribed.lock().unwrap().clone();
    let sub: serde_json::Value = serde_json::from_str(&messages[0]).unwrap();
    assert_eq!(sub["params"]["symbols"], "EUR/USD");
    assert_eq!(
        sub["params"]["apikey"], CANARY_TWELVE,
        "the key goes in the message, as on the Mac"
    );
    assert_eq!(messages[1], r#"{"action":"heartbeat"}"#);
    eventually(|| env.sink.tick_symbols() == ["EUR/USD"]).await;
    assert_eq!(env.online.quotes_status().status, StreamStatus::Connected);
    assert_no_secret(&env.online.quotes_status());
    env.online.quotes_stop();
}

#[tokio::test]
async fn twelve_data_websocket_refused_subscription_does_not_reconnect() {
    let (ws_url, connections) = ws_server(|mut ws| async move {
        let _ = next_text(&mut ws).await;
        let _ = ws
            .send(Message::text(
                r#"{"event":"subscribe-status","status":"error","message":"invalid key"}"#,
            ))
            .await;
        std::future::pending::<()>().await;
    })
    .await;
    let env = env_with("dojix", &ws_url).await;
    let s = OnlineSettings {
        live_source: LiveSource::TwelveDataWs,
        ..on()
    };
    env.online.quotes_start(&s, &["EUR/USD".into()]).unwrap();
    eventually(|| {
        matches!(
            env.online.quotes_status().status,
            StreamStatus::Error { .. }
        )
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(connections.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn websocket_oversized_messages_drop_the_connection_and_reconnect() {
    let (ws_url, connections) = ws_server(|mut ws| async move {
        let _ = next_text(&mut ws).await;
        let huge = format!(
            r#"{{"event":"price","symbol":"EUR/USD","bid":"1","ask":"1","pad":"{}"}}"#,
            "x".repeat(super::quotes::MAX_WS_MESSAGE + 10)
        );
        let _ = ws.send(Message::text(huge)).await;
        std::future::pending::<()>().await;
    })
    .await;
    let env = env_with("dojix", &ws_url).await;
    let s = OnlineSettings {
        live_source: LiveSource::TwelveDataWs,
        ..on()
    };
    env.online.quotes_start(&s, &["EUR/USD".into()]).unwrap();
    eventually(|| connections.load(Ordering::SeqCst) >= 3).await;
    assert!(env.sink.ticks.lock().unwrap().is_empty());
    assert!(env
        .sink
        .statuses
        .lock()
        .unwrap()
        .iter()
        .any(|s| matches!(s, StreamStatus::Reconnecting { .. })));
    env.online.quotes_stop();
}

#[tokio::test]
async fn websocket_reconnects_at_most_ten_times() {
    // Accepts TCP and hangs up before the WebSocket handshake.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            seen.fetch_add(1, Ordering::SeqCst);
            drop(tcp);
        }
    });
    let env = env_with("dojix", &format!("ws://{addr}")).await;
    let s = OnlineSettings {
        live_source: LiveSource::PolygonWs,
        ..on()
    };
    env.online.quotes_start(&s, &["EUR/USD".into()]).unwrap();
    eventually(|| {
        matches!(
            env.online.quotes_status().status,
            StreamStatus::Error { .. }
        )
    })
    .await;
    assert_eq!(
        count.load(Ordering::SeqCst),
        11,
        "one try plus ten reconnects"
    );
}

// ---------------------------------------------------------------------------------------------
// Polygon
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn polygon_waits_for_auth_then_subscribes() {
    let received = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = received.clone();
    let (ws_url, _) = ws_server(move |mut ws| {
        let log = log.clone();
        async move {
            let _ = ws
                .send(Message::text(r#"[{"ev":"status","status":"connected","message":"Connected Successfully"}]"#))
                .await;
            let auth = next_text(&mut ws).await;
            log.lock().unwrap().push(auth);
            let _ = ws
                .send(Message::text(r#"[{"ev":"status","status":"auth_success","message":"authenticated"}]"#))
                .await;
            let sub = next_text(&mut ws).await;
            log.lock().unwrap().push(sub);
            let _ = ws
                .send(Message::text(r#"[{"ev":"C","p":"EUR/USD","b":1.1,"a":1.1002,"t":1793017800000},{"ev":"C","p":"USD/JPY","b":150,"a":150.1,"t":1793017800000}]"#))
                .await;
            std::future::pending::<()>().await;
        }
    })
    .await;
    let env = env_with("dojix", &ws_url).await;
    let s = OnlineSettings {
        live_source: LiveSource::PolygonWs,
        ..on()
    };
    env.online.quotes_start(&s, &["EURUSD".into()]).unwrap();
    eventually(|| env.sink.tick_symbols() == ["EUR/USD"]).await;
    let log = received.lock().unwrap().clone();
    assert_eq!(
        log[0],
        format!(r#"{{"action":"auth","params":"{CANARY_POLYGON}"}}"#)
    );
    assert_eq!(log[1], r#"{"action":"subscribe","params":"C.EUR/USD"}"#);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        env.sink.tick_symbols(),
        ["EUR/USD"],
        "only requested symbols reach the window"
    );
    env.online.quotes_stop();
}

#[tokio::test]
async fn polygon_auth_failure_is_final() {
    let (ws_url, connections) = ws_server(|mut ws| async move {
        let _ = next_text(&mut ws).await;
        let _ = ws
            .send(Message::text(
                r#"[{"ev":"status","status":"auth_failed","message":"authentication failed"}]"#,
            ))
            .await;
        std::future::pending::<()>().await;
    })
    .await;
    let env = env_with("dojix", &ws_url).await;
    let s = OnlineSettings {
        live_source: LiveSource::PolygonWs,
        ..on()
    };
    env.online.quotes_start(&s, &["EUR/USD".into()]).unwrap();
    eventually(|| {
        matches!(
            env.online.quotes_status().status,
            StreamStatus::Error { .. }
        )
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(connections.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn polygon_rest_test_and_failure_matrix() {
    let env = env("dojix").await;
    Mock::given(method("GET"))
        .and(path("/pg/v2/last/nbbo/C:EURUSD"))
        .and(header(
            "authorization",
            format!("Bearer {CANARY_POLYGON}").as_str(),
        ))
        .respond_with(json_body(json!({"status": "OK"})))
        .mount(&env.server)
        .await;
    let t = env.online.test_connection("polygon", &on()).await.unwrap();
    assert_eq!(t.message, "Connected to Polygon.io");
    // The REST check reads no JSON, so malformed bodies pass; the rest of the matrix applies.
    for (status, want) in [
        (401, "invalid_key"),
        (403, "invalid_key"),
        (429, "rate_limited"),
        (502, "unavailable"),
    ] {
        env.server.reset().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(status))
            .mount(&env.server)
            .await;
        let e = env
            .online
            .test_connection("polygon", &on())
            .await
            .unwrap_err();
        assert_eq!(e.code, want);
    }
    env.server.reset().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(3)))
        .mount(&env.server)
        .await;
    assert_eq!(
        env.online
            .test_connection("polygon", &on())
            .await
            .unwrap_err()
            .code,
        "timeout"
    );
    env.server.reset().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b'x'; 300 * 1024]))
        .mount(&env.server)
        .await;
    assert_eq!(
        env.online
            .test_connection("polygon", &on())
            .await
            .unwrap_err()
            .code,
        "too_large"
    );
}

// ---------------------------------------------------------------------------------------------
// OANDA
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn oanda_tests_use_the_practice_or_live_host() {
    let env = env("dojix").await;
    Mock::given(method("GET"))
        .and(path(
            format!("/oanda-practice/v3/accounts/{ACCOUNT_ID}/summary").as_str(),
        ))
        .and(header(
            "authorization",
            format!("Bearer {CANARY_OANDA}").as_str(),
        ))
        .respond_with(json_body(
            json!({"account": {"id": ACCOUNT_ID, "currency": "USD", "balance": "1000.00"}}),
        ))
        .mount(&env.server)
        .await;
    Mock::given(method("GET"))
        .and(path(
            format!("/oanda-live/v3/accounts/{ACCOUNT_ID}/pricing").as_str(),
        ))
        .and(query_param("instruments", "EUR_USD"))
        .respond_with(json_body(json!({"prices": []})))
        .mount(&env.server)
        .await;
    let t = env
        .online
        .test_connection("oanda_import", &on())
        .await
        .unwrap();
    assert_eq!(t.message, "Connected — USD account");
    let live = OnlineSettings {
        oanda_live: true,
        ..on()
    };
    let t = env
        .online
        .test_connection("oanda_stream", &live)
        .await
        .unwrap();
    assert_eq!(t.message, "Connected to OANDA Live");

    let s = on();
    failure_matrix(
        &env,
        "GET",
        "/summary$",
        CANARY_OANDA,
        || env.online.test_connection("oanda_import", &s),
        2 * 1024 * 1024,
    )
    .await;
}

#[tokio::test]
async fn oanda_history_follows_trusted_pages_only() {
    let env = env("dojix").await;
    let base = format!(
        "{}/oanda-practice/v3/accounts/{ACCOUNT_ID}",
        env.server.uri()
    );
    Mock::given(method("GET"))
        .and(path(format!("/oanda-practice/v3/accounts/{ACCOUNT_ID}/transactions").as_str()))
        .and(query_param("type", "ORDER_FILL"))
        .respond_with(json_body(json!({
            "count": 3,
            "pages": [format!("{base}/transactions/idrange?from=1&to=2"), format!("{base}/transactions/idrange?from=3&to=3")]
        })))
        .mount(&env.server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/oanda-practice/v3/accounts/{ACCOUNT_ID}/transactions/idrange").as_str()))
        .and(query_param("from", "1"))
        .respond_with(json_body(json!({"transactions": [
            {"id": "1", "type": "ORDER_FILL", "instrument": "EUR_USD", "units": "10000", "price": "1.1000", "time": "2026-10-20T09:00:00.000000000Z", "tradeOpened": {"tradeID": "1"}, "accountID": ACCOUNT_ID},
            "not an object",
            {"id": "2", "type": "ORDER_FILL", "instrument": "EUR_USD", "units": "-10000", "price": "1.1010", "time": "2026-10-20T10:00:00.000000000Z", "tradesClosed": [{"tradeID": "1", "realizedPL": "10.0000"}]}
        ]})))
        .mount(&env.server)
        .await;
    Mock::given(method("GET"))
        .and(path(
            format!("/oanda-practice/v3/accounts/{ACCOUNT_ID}/transactions/idrange").as_str(),
        ))
        .and(query_param("from", "3"))
        .respond_with(json_body(json!({"transactions": []})))
        .mount(&env.server)
        .await;
    let h = env.online.oanda_history(&on(), Some(30)).await.unwrap();
    assert_eq!((h.transactions.len(), h.pages), (2, 2));
    assert_eq!(
        h.transactions[1]["tradesClosed"][0]["realizedPL"],
        "10.0000"
    );
    assert_no_secret(&h);
    assert_eq!(
        env.online
            .oanda_history(&on(), Some(0))
            .await
            .unwrap_err()
            .code,
        "invalid"
    );

    // A page on another host: refused before the token is sent anywhere.
    env.server.reset().await;
    Mock::given(method("GET"))
        .and(path_regex("/transactions$"))
        .respond_with(json_body(
            json!({"pages": ["https://attacker.example/steal"]}),
        ))
        .mount(&env.server)
        .await;
    let e = env.online.oanda_history(&on(), None).await.unwrap_err();
    assert_eq!(e.code, "blocked_host");
    assert_eq!(env.server.received_requests().await.unwrap().len(), 1);

    // A page that echoes the token is dropped.
    env.server.reset().await;
    Mock::given(method("GET"))
        .and(path_regex("/transactions$"))
        .respond_with(json_body(
            json!({"pages": [format!("{base}/transactions/idrange?from=1&to=1")]}),
        ))
        .mount(&env.server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex("/idrange$"))
        .respond_with(json_body(
            json!({"transactions": [{"id": "1", "note": CANARY_OANDA}]}),
        ))
        .mount(&env.server)
        .await;
    assert_eq!(
        env.online
            .oanda_history(&on(), None)
            .await
            .unwrap_err()
            .code,
        "bad_response"
    );

    let s = on();
    failure_matrix(
        &env,
        "GET",
        "/transactions$",
        CANARY_OANDA,
        || env.online.oanda_history(&s, None),
        2 * 1024 * 1024,
    )
    .await;
}

#[tokio::test]
async fn oanda_stream_reads_lines_and_stops_on_a_refused_token() {
    let env = env("dojix").await;
    let body = concat!(
        r#"{"type":"HEARTBEAT","time":"2026-10-26T12:30:00.000000000Z"}"#,
        "\n",
        r#"{"type":"PRICE","time":"2026-10-26T12:30:00.123456789Z","bids":[{"price":"1.08510"}],"asks":[{"price":"1.08522"}],"instrument":"EUR_USD"}"#,
        "\n",
        "not json\n",
    );
    Mock::given(method("GET"))
        .and(path(
            format!("/oanda-stream-practice/v3/accounts/{ACCOUNT_ID}/pricing/stream").as_str(),
        ))
        .and(query_param("instruments", "EUR_USD"))
        .and(header(
            "authorization",
            format!("Bearer {CANARY_OANDA}").as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_raw(body, "application/octet-stream"))
        .mount(&env.server)
        .await;
    let s = OnlineSettings {
        live_source: LiveSource::OandaStream,
        ..on()
    };
    env.online.quotes_start(&s, &["EUR/USD".into()]).unwrap();
    eventually(|| !env.sink.ticks.lock().unwrap().is_empty()).await;
    let first = env.sink.ticks.lock().unwrap()[0].clone();
    assert_eq!(
        (first.symbol.as_str(), first.timestamp_ms),
        ("EUR/USD", 1_793_017_800_123)
    );
    env.online.quotes_stop();

    env.server.reset().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&env.server)
        .await;
    env.online.quotes_start(&s, &["EUR/USD".into()]).unwrap();
    eventually(|| {
        matches!(
            env.online.quotes_status().status,
            StreamStatus::Error { .. }
        )
    })
    .await;
    let n = env.server.received_requests().await.unwrap().len();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        env.server.received_requests().await.unwrap().len(),
        n,
        "no retry on 401"
    );
}

// ---------------------------------------------------------------------------------------------
// Economic calendar
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn calendar_fetches_caches_and_marks_stale_copies() {
    let env = env("dojix").await;
    Mock::given(method("GET"))
        .and(path("/ff_calendar_thisweek.json"))
        .respond_with(json_body(json!([
            {"title": "Fictional CPI", "country": "USD", "date": "2026-10-26T08:30:00-04:00", "impact": "High", "forecast": "0.2%", "previous": "0.3%"}
        ])))
        .expect(1)
        .mount(&env.server)
        .await;
    let week = env.online.calendar_week(true, false).await.unwrap();
    assert_eq!(week.events.len(), 1);
    assert!(!week.stale);
    assert_eq!(week.source, "nfs.faireconomy.media");
    let again = env.online.calendar_week(true, true).await.unwrap();
    assert_eq!(again, week, "served from memory: no second request");
    assert_eq!(
        env.online
            .calendar_week(false, false)
            .await
            .unwrap_err()
            .code,
        "off"
    );
    env.server.verify().await;
}

#[tokio::test]
async fn calendar_checks_the_content_type_and_failure_matrix() {
    let env = env("dojix").await;
    let url = format!("{}/ff_calendar_thisweek.json", env.server.uri());
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_raw("[]", "text/html"))
        .mount(&env.server)
        .await;
    let http = super::http_client(TIMEOUTS.request, NetPolicy::LOOPBACK_FOR_TESTS).unwrap();
    let e = CalendarCache::default()
        .week(&http, &url, NetPolicy::LOOPBACK_FOR_TESTS, false)
        .await
        .unwrap_err();
    assert_eq!(e.code, "bad_response");
    // A fresh cache per case: the cache throttles refreshes to one per 2 minutes.
    failure_matrix(
        &env,
        "GET",
        "^/ff_calendar_thisweek.json$",
        "no-key",
        || {
            let http = http.clone();
            let url = url.clone();
            async move {
                CalendarCache::default()
                    .week(&http, &url, NetPolicy::LOOPBACK_FOR_TESTS, false)
                    .await
            }
        },
        3 * 1024 * 1024,
    )
    .await;
}

#[tokio::test]
async fn calendar_keeps_the_last_copy_when_offline() {
    let env = env("dojix").await;
    let http = super::http_client(TIMEOUTS.request, NetPolicy::LOOPBACK_FOR_TESTS).unwrap();
    let url = format!("{}/ff_calendar_thisweek.json", env.server.uri());
    Mock::given(method("GET"))
        .respond_with(json_body(json!([{"title": "Fictional GDP", "country": "EUR", "date": "2026-10-27T10:00:00Z", "impact": "Medium"}])))
        .mount(&env.server)
        .await;
    let cache = CalendarCache::default();
    let first = cache
        .week(&http, &url, NetPolicy::LOOPBACK_FOR_TESTS, false)
        .await
        .unwrap();
    // A refresh asked for within 2 minutes is not sent; the copy comes back.
    let again = cache
        .week(&http, &url, NetPolicy::LOOPBACK_FOR_TESTS, true)
        .await
        .unwrap();
    assert_eq!(again.events, first.events);
    assert_eq!(env.server.received_requests().await.unwrap().len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Finnhub
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn finnhub_quote_profile_search_with_a_shared_cache() {
    let env = env("greenwick").await;
    Mock::given(method("GET"))
        .and(path("/api/v1/quote"))
        .and(query_param("symbol", "FICT"))
        .and(header("x-finnhub-token", CANARY_FINNHUB))
        .respond_with(json_body(json!({"c": 12.5, "d": 0.5, "dp": 4.17, "h": 13, "l": 12, "o": 12.1, "pc": 12, "t": 1793017800})))
        .expect(1)
        .mount(&env.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/stock/profile2"))
        .respond_with(json_body(json!({"name": "Fictional Corp", "ticker": "FICT", "exchange": "FICTIONAL EXCHANGE", "finnhubIndustry": "Widgets"})))
        .mount(&env.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/search"))
        .and(query_param("q", "fict"))
        .respond_with(json_body(json!({"count": 1, "result": [{"description": "FICTIONAL CORP", "displaySymbol": "FICT", "symbol": "FICT", "type": "Common Stock"}]})))
        .mount(&env.server)
        .await;
    let s = on();
    let q = env.online.finnhub_quote(&s, "fict").await.unwrap();
    let cached = env.online.finnhub_quote(&s, "FICT").await.unwrap();
    assert_eq!(
        q, cached,
        "the second quote within 30 s comes from the cache"
    );
    assert_eq!(
        env.online.finnhub_profile(&s, "FICT").await.unwrap().name,
        "Fictional Corp"
    );
    assert_eq!(
        env.online.finnhub_search(&s, " fict ").await.unwrap().len(),
        1
    );
    assert!(env
        .online
        .finnhub_search(&s, "   ")
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        env.online.finnhub_quote(&s, "A&B").await.unwrap_err().code,
        "invalid"
    );
    let off = OnlineSettings::default();
    assert_eq!(
        env.online
            .finnhub_quote(&off, "FICT")
            .await
            .unwrap_err()
            .code,
        "off"
    );
    env.server.verify().await;

    // A provider echoing the key is refused.
    env.server.reset().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/stock/profile2"))
        .respond_with(json_body(json!({"name": format!("Echo {CANARY_FINNHUB}")})))
        .mount(&env.server)
        .await;
    assert_eq!(
        env.online
            .finnhub_profile(&s, "ECHO")
            .await
            .unwrap_err()
            .code,
        "bad_response"
    );
}

#[tokio::test]
async fn finnhub_failure_matrix() {
    let env = env("greenwick").await;
    let s = on();
    let big = 3 * 1024 * 1024;
    failure_matrix(
        &env,
        "GET",
        "^/api/v1/search$",
        CANARY_FINNHUB,
        || env.online.finnhub_search(&s, "fict"),
        big,
    )
    .await;
    failure_matrix(
        &env,
        "GET",
        "^/api/v1/stock/profile2$",
        CANARY_FINNHUB,
        || env.online.finnhub_profile(&s, "FICT"),
        big,
    )
    .await;
    failure_matrix(
        &env,
        "GET",
        "^/api/v1/quote$",
        CANARY_FINNHUB,
        || env.online.test_connection("finnhub", &s),
        big,
    )
    .await;
}

// ---------------------------------------------------------------------------------------------
// MT5 price file
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn mt5_file_source_and_test() {
    let env = env("dojix").await;
    assert_eq!(
        env.online
            .test_connection("mt5_file", &on())
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    std::fs::write(
        env.mt5_dir.join(super::mt5_prices::FILE_NAME),
        r#"{"ts":"2026.10.26 12:30:00","prices":[{"s":"EURUSD.pro","b":1.0851,"a":1.0852}]}"#,
    )
    .unwrap();
    assert!(
        env.online
            .test_connection("mt5_file", &on())
            .await
            .unwrap()
            .ok
    );
    let s = OnlineSettings {
        live_source: LiveSource::Mt5File,
        ..on()
    };
    env.online.quotes_start(&s, &["EUR/USD".into()]).unwrap();
    eventually(|| env.sink.tick_symbols() == ["EUR/USD"]).await;
    env.online.quotes_stop();
}

// ---------------------------------------------------------------------------------------------
// Brand and switch gates; no secret ever leaves
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn brand_and_switch_gates() {
    let fx = env("dojix").await;
    let st = env("greenwick").await;
    assert_eq!(
        fx.online
            .finnhub_quote(&on(), "FICT")
            .await
            .unwrap_err()
            .code,
        "unsupported"
    );
    assert_eq!(
        st.online.calendar_week(true, false).await.unwrap_err().code,
        "unsupported"
    );
    assert_eq!(
        st.online
            .test_connection("polygon", &on())
            .await
            .unwrap_err()
            .code,
        "unsupported"
    );
    assert_eq!(
        fx.online
            .test_connection("finnhub", &on())
            .await
            .unwrap_err()
            .code,
        "unsupported"
    );
    assert_eq!(
        fx.online
            .test_connection("nope", &on())
            .await
            .unwrap_err()
            .code,
        "invalid"
    );
    assert_eq!(
        fx.online
            .quotes_start(&on(), &["EUR/USD".into()])
            .unwrap_err()
            .code,
        "off",
        "no live source until one is chosen"
    );
    assert_eq!(
        st.online
            .quotes_start(&on(), &["EUR/USD".into()])
            .unwrap_err()
            .code,
        "unsupported"
    );
    assert!(fx.server.received_requests().await.unwrap().is_empty());
    assert!(st.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn missing_keys_are_reported_without_a_request() {
    let server = MockServer::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let online = Online::with(
        "dojix",
        Arc::new(MemoryVault::default()),
        tmp.path(),
        Arc::new(Collect::default()),
        Endpoints::local(&server.uri(), "ws://127.0.0.1:9"),
        NetPolicy::LOOPBACK_FOR_TESTS,
        TIMEOUTS,
        None,
    );
    let sha = online.ai_preview(&on(), &prompt()).unwrap().request_sha256;
    assert_eq!(
        online
            .ai_run(&on(), &prompt(), &sha)
            .await
            .unwrap_err()
            .code,
        "no_key"
    );
    assert_eq!(online.ai_models().await.unwrap_err().code, "no_key");
    for p in [
        "anthropic",
        "twelve_data",
        "polygon",
        "oanda_stream",
        "oanda_import",
    ] {
        assert_eq!(
            online.test_connection(p, &on()).await.unwrap_err().code,
            "no_key",
            "{p}"
        );
    }
    let s = OnlineSettings {
        live_source: LiveSource::PolygonWs,
        ..on()
    };
    assert_eq!(
        online
            .quotes_start(&s, &["EUR/USD".into()])
            .unwrap_err()
            .code,
        "no_key"
    );
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn production_endpoints_are_https_and_on_the_allow_lists() {
    let e = Endpoints::production();
    let strict = NetPolicy::STRICT;
    for (url, hosts) in [
        (&e.anthropic, anthropic::HOSTS),
        (&e.twelve_rest, super::twelvedata::HOSTS),
        (&e.twelve_ws, super::twelvedata::HOSTS),
        (&e.polygon_ws, super::polygon::HOSTS),
        (&e.polygon_rest, super::polygon::HOSTS),
        (&e.oanda_rest_practice, super::oanda::HOSTS),
        (&e.oanda_rest_live, super::oanda::HOSTS),
        (&e.oanda_stream_practice, super::oanda::HOSTS),
        (&e.oanda_stream_live, super::oanda::HOSTS),
        (&e.calendar, super::calendar::HOSTS),
        (&e.finnhub, super::finnhub::HOSTS),
    ] {
        assert!(super::checked_url(url, hosts, strict).is_ok(), "{url}");
        assert!(
            url.starts_with("https://") || url.starts_with("wss://"),
            "{url}"
        );
    }
    // The production service refuses the mock servers' plain-HTTP loopback addresses.
    let tmp = tempfile::tempdir().unwrap();
    let vault = Arc::new(MemoryVault::default());
    vault.write(ANTHROPIC, CANARY_ANTHROPIC.as_bytes()).unwrap();
    let strict_online = Online::with(
        "dojix",
        vault,
        tmp.path(),
        Arc::new(Collect::default()),
        Endpoints::local("http://127.0.0.1:9", "ws://127.0.0.1:9"),
        NetPolicy::STRICT,
        TIMEOUTS,
        None,
    );
    assert_eq!(
        strict_online.ai_models().await.unwrap_err().code,
        "blocked_host"
    );
}

/// The IPC commands never return a key: every command result type is listed here, and each
/// is produced above with canary keys stored and mocks echoing them. This test pins the list
/// to the command signatures so a new command (or a new result type) must be added.
#[test]
fn every_online_command_returns_only_checked_types() {
    let source = include_str!("commands.rs");
    let checked = [
        "Result<OnlineSettingsView, NetError>",
        "Result<(), NetError>",
        "Result<bool, NetError>",
        "Result<TestResult, NetError>",
        "Result<Vec<ModelInfo>, NetError>",
        "Result<AiPreview, NetError>",
        "Result<AiReport, NetError>",
        "Result<Vec<AiReport>, NetError>",
        "Result<QuotesStatus, NetError>",
        "Result<CalendarWeek, NetError>",
        "Result<StockQuote, NetError>",
        "Result<CompanyProfile, NetError>",
        "Result<Vec<SymbolSearchResult>, NetError>",
        "Result<OandaHistory, NetError>",
    ];
    let mut commands = 0;
    for chunk in source.split("#[tauri::command]").skip(1) {
        commands += 1;
        let norm = |t: &str| {
            t.chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .replace(",>", ">")
        };
        let signature = norm(chunk.split('{').next().unwrap());
        if let Some(ret) = signature.split("->").nth(1) {
            assert!(
                checked.iter().any(|c| norm(c) == ret),
                "unchecked command result type: {signature}"
            );
        }
    }
    assert_eq!(commands, super::commands::COMMANDS.len());
    assert!(
        !source.contains("secrets::read"),
        "commands never read a key"
    );
    assert!(
        !source.contains("secrets::require"),
        "commands never read a key"
    );
}

#[test]
fn command_lists_match_build_rs_capabilities_and_the_handler() {
    let build = include_str!("../../build.rs");
    let caps: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
    let perms: Vec<&str> = caps["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p.as_str())
        .collect();
    let lib = include_str!("../lib.rs");
    for name in super::commands::COMMANDS {
        assert_eq!(
            build.matches(&format!("\"{name}\"")).count(),
            2,
            "build.rs lists {name} twice"
        );
        let perm = format!("allow-{}", name.replace('_', "-"));
        assert!(perms.contains(&perm.as_str()), "capability {perm}");
        assert_eq!(
            lib.matches(&format!("net::commands::{name},")).count()
                + lib.matches(&format!("net::commands::{name}\n")).count(),
            2,
            "lib.rs registers {name} in both handler lists"
        );
    }
}

#[test]
fn the_web_view_cannot_reach_the_network() {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let csp = &conf["app"]["security"]["csp"];
    assert_eq!(csp["connect-src"], "ipc: http://ipc.localhost");
    assert_eq!(csp["default-src"], "'self'");
    for directive in ["script-src", "img-src", "font-src", "style-src"] {
        let v = csp[directive].as_str().unwrap();
        assert!(!v.contains("http") && !v.contains("ws"), "{directive}: {v}");
    }
    let caps = include_str!("../../capabilities/main.json");
    assert!(!caps.contains("http:"), "no http plugin permission");
    let manifest = include_str!("../../Cargo.toml");
    assert!(!manifest.contains("tauri-plugin-http"), "no http plugin");
    assert!(
        !manifest.contains("tauri-plugin-websocket"),
        "no websocket plugin"
    );
}

#[test]
fn keys_written_by_the_ui_round_trip_without_being_returned() {
    let tmp = tempfile::tempdir().unwrap();
    let vault = Arc::new(MemoryVault::default());
    let online = Online::with(
        "greenwick",
        vault.clone(),
        tmp.path(),
        Arc::new(Collect::default()),
        Endpoints::production(),
        NetPolicy::STRICT,
        TIMEOUTS,
        None,
    );
    online.set_secret(FINNHUB, CANARY_FINNHUB).unwrap();
    assert!(online.has_secret(FINNHUB).unwrap());
    let view = online.settings_view(&OnlineSettings::default(), true);
    assert_eq!(view.keys.get(FINNHUB), Some(&true));
    assert_eq!(view.ai_model, "claude-sonnet-5-5");
    assert!(!view.ai_enabled && !view.finnhub_enabled);
    assert_no_secret(&view);
    assert_eq!(
        online.set_secret(TWELVE_DATA, "x1234").unwrap_err().code,
        "invalid"
    );
    online.delete_secret(FINNHUB).unwrap();
    assert!(!online.has_secret(FINNHUB).unwrap());
    assert!(!vault.contains(FINNHUB));
}

#[test]
fn ai_reports_round_trip_in_the_journal_schema() {
    use super::commands::{insert_report, list_reports, AiReport};
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::journal::migrations().to_latest(&mut conn).unwrap();
    let report = AiReport {
        id: 0,
        created_at: super::journal_time(1_793_017_800_000),
        model: "claude-opus-5-5".into(),
        request_sha256: "ab".repeat(32),
        request_preview: "{\"model\":\"claude-opus-5-5\"}".into(),
        response_text: "1. Fictional advice".into(),
        input_tokens: Some(10),
        output_tokens: None,
    };
    let tx = conn.transaction().unwrap();
    let id = insert_report(&tx, &report).unwrap();
    insert_report(&tx, &report).unwrap();
    tx.commit().unwrap();
    let listed = list_reports(&conn, 10).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[1], AiReport { id, ..report });
    assert!(listed[0].id > listed[1].id, "newest first");
    assert_eq!(list_reports(&conn, 1).unwrap().len(), 1);
}
