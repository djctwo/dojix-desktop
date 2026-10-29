//! Live prices for Pulse and the sidebar ticker (Dojix, SPEC 8.3): one source at a time, chosen
//! in Settings, started for the watchlist's pairs. The desktop counterpart of the Mac's
//! `LiveDataManager` and `LivePriceProvider` (`Services/LiveData/*.swift`).
//!
//! Every source turns its feed into [`PriceTick`]s with symbols in one form (`EUR/USD`,
//! [`normalize_symbol`]) and reports a [`StreamStatus`]. Streams reconnect with exponential
//! backoff (2, 4, 8 … 60 s), at most 10 times in a row, as on the Mac. Prices are not logged.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use serde::Serialize;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use super::settings::LiveSource;
use super::{backoff_delay, NetError, NetPolicy, MAX_RECONNECTS};

/// The most symbols one stream follows (the watchlist holds at most 8; SPEC 2.4 lists 23).
pub const MAX_SYMBOLS: usize = 32;
/// The largest WebSocket message accepted.
pub const MAX_WS_MESSAGE: usize = 1024 * 1024;

/// One price update (`PriceUpdate` on the Mac).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceTick {
    pub symbol: String,
    pub bid: f64,
    pub ask: f64,
    pub mid: f64,
    pub spread: f64,
    pub timestamp_ms: i64,
    /// Daily change in percent (Twelve Data REST only; feeds currency strength).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_percent: Option<f64>,
}

impl PriceTick {
    /// `PriceUpdate.init`: mid = (bid + ask) / 2, spread = ask − bid. Non-finite prices are
    /// refused (`None`).
    pub fn new(symbol: &str, bid: f64, ask: f64, timestamp_ms: i64) -> Option<Self> {
        if !bid.is_finite() || !ask.is_finite() {
            return None;
        }
        let symbol = normalize_symbol(symbol)?;
        Some(Self {
            symbol,
            bid,
            ask,
            mid: (bid + ask) / 2.0,
            spread: ask - bid,
            timestamp_ms,
            change_percent: None,
        })
    }
}

/// `StreamingStatus` on the Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamStatus {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting { attempt: u32 },
    Error { message: String },
}

/// Where a running source sends its prices and status.
pub trait TickSink: Send + Sync {
    fn tick(&self, tick: PriceTick);
    fn status(&self, status: StreamStatus);
}

/// One symbol form for every source: `EUR/USD`.
///
/// Upper-cases, keeps letters and digits, and when the first six are letters splits them
/// `AAA/BBB` and drops a broker suffix (`EURUSD.r`, `eurusdm`, `EUR_USD`, `C:EURUSD` → `EUR/USD`).
/// Other names (indices like `US30`, `GER40`) are kept as upper-case letters and digits.
/// Returns `None` for an empty or overlong name.
pub fn normalize_symbol(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let raw = raw.strip_prefix("C:").or_else(|| raw.strip_prefix("C.")).unwrap_or(raw);
    let alnum: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if alnum.is_empty() || alnum.len() > 20 {
        return None;
    }
    let head = &alnum.as_bytes()[..alnum.len().min(6)];
    if head.len() == 6 && head.iter().all(u8::is_ascii_alphabetic) {
        return Some(format!("{}/{}", &alnum[..3], &alnum[3..6]));
    }
    Some(alnum)
}

/// Validates and normalises the requested symbols (duplicates removed, order kept).
pub fn requested_symbols(symbols: &[String]) -> Result<Vec<String>, NetError> {
    let mut out: Vec<String> = Vec::new();
    for s in symbols {
        let n = normalize_symbol(s).ok_or_else(|| NetError::invalid("A symbol is not valid."))?;
        if !out.contains(&n) {
            out.push(n);
        }
    }
    if out.is_empty() {
        return Err(NetError::invalid("Choose at least one pair."));
    }
    if out.len() > MAX_SYMBOLS {
        return Err(NetError::invalid(format!(
            "At most {MAX_SYMBOLS} pairs can be followed at once."
        )));
    }
    Ok(out)
}

/// Timing for streams and polling (tests shrink these).
#[derive(Debug, Clone, Copy)]
pub struct StreamTiming {
    /// One "second" of backoff.
    pub backoff_unit: Duration,
    pub connect_timeout: Duration,
    /// A stream with no message for this long is reconnected.
    pub idle_timeout: Duration,
    pub heartbeat: Duration,
    /// Twelve Data REST: every 120 s (`TwelveDataRESTProvider.pollInterval`).
    pub poll_interval: Duration,
    /// MT5 price file: checked once a second.
    pub file_interval: Duration,
}

impl StreamTiming {
    pub const APP: Self = Self {
        backoff_unit: Duration::from_secs(1),
        connect_timeout: Duration::from_secs(30),
        idle_timeout: Duration::from_secs(90),
        heartbeat: Duration::from_secs(10),
        poll_interval: Duration::from_secs(120),
        file_interval: Duration::from_secs(1),
    };
}

/// How one WebSocket provider talks.
pub trait WsProtocol: Send + Sync {
    /// Sent first; the stream then waits for [`WsEvent::AuthOk`] (Polygon).
    fn auth(&self) -> Option<String>;
    fn subscribe(&self) -> String;
    /// Sent every [`StreamTiming::heartbeat`] while connected.
    fn heartbeat(&self) -> Option<String>;
    fn parse(&self, text: &str, now_ms: i64) -> WsEvent;
}

#[derive(Debug, PartialEq)]
pub enum WsEvent {
    Ticks(Vec<PriceTick>),
    AuthOk,
    /// The provider refused the key or the subscription: no reconnect.
    Refused(String),
    Ignore,
}

/// Why a connection ended.
#[derive(Debug, PartialEq)]
pub enum SessionEnd {
    /// The connection was lost; `was_connected` resets the retry count (as on the Mac).
    Dropped { was_connected: bool },
    /// Don't reconnect (bad key, refused subscription).
    Fatal(String),
}

/// Runs `session` until it ends fatally or fails [`MAX_RECONNECTS`] times in a row.
pub async fn reconnecting<F, Fut>(sink: &dyn TickSink, timing: StreamTiming, mut session: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = SessionEnd>,
{
    let mut attempt: u32 = 0;
    loop {
        sink.status(if attempt == 0 {
            StreamStatus::Connecting
        } else {
            StreamStatus::Reconnecting { attempt }
        });
        match session().await {
            SessionEnd::Fatal(message) => {
                sink.status(StreamStatus::Error { message });
                return;
            }
            SessionEnd::Dropped { was_connected } => {
                if was_connected {
                    attempt = 0;
                }
            }
        }
        attempt += 1;
        if attempt > MAX_RECONNECTS {
            sink.status(StreamStatus::Error {
                message: format!("Gave up after {MAX_RECONNECTS} reconnect attempts."),
            });
            return;
        }
        log::info!("price stream lost; reconnect attempt {attempt}");
        tokio::time::sleep(backoff_delay(attempt, timing.backoff_unit)).await;
    }
}

fn tls_connector() -> Option<tokio_tungstenite::Connector> {
    use rustls_platform_verifier::BuilderVerifierExt;
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .ok()?
        .with_platform_verifier()
        .ok()?
        .with_no_client_auth();
    Some(tokio_tungstenite::Connector::Rustls(Arc::new(config)))
}

fn ws_error_end(e: &tokio_tungstenite::tungstenite::Error, connected: bool) -> SessionEnd {
    use tokio_tungstenite::tungstenite::Error as E;
    match e {
        E::Http(response) if matches!(response.status().as_u16(), 401 | 403) => {
            SessionEnd::Fatal("The price feed did not accept the key. Check it in Settings.".into())
        }
        _ => SessionEnd::Dropped {
            was_connected: connected,
        },
    }
}

fn now_ms() -> i64 {
    crate::journal::now_ms()
}

/// One WebSocket connection: connect (TLS with the OS trust store), authenticate if needed,
/// subscribe, then read until the connection drops or goes silent.
pub async fn ws_session(
    proto: &dyn WsProtocol,
    url: &Url,
    policy: NetPolicy,
    allowed: &[&str],
    timing: StreamTiming,
    sink: &dyn TickSink,
) -> SessionEnd {
    if super::check_url(url, allowed, policy).is_err() {
        return SessionEnd::Fatal("The price feed address is not allowed.".into());
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE))
        .max_frame_size(Some(MAX_WS_MESSAGE));
    let connector = if url.scheme() == "wss" {
        match tls_connector() {
            Some(c) => Some(c),
            None => return SessionEnd::Fatal("Secure connections are not available.".into()),
        }
    } else {
        None
    };
    let connect = tokio_tungstenite::connect_async_tls_with_config(
        url.as_str(),
        Some(config),
        true,
        connector,
    );
    let mut ws = match tokio::time::timeout(timing.connect_timeout, connect).await {
        Ok(Ok((ws, _response))) => ws,
        Ok(Err(e)) => return ws_error_end(&e, false),
        Err(_) => return SessionEnd::Dropped { was_connected: false },
    };

    if let Some(auth) = proto.auth() {
        if ws.send(Message::text(auth)).await.is_err() {
            return SessionEnd::Dropped { was_connected: false };
        }
        let deadline = tokio::time::Instant::now() + timing.connect_timeout;
        loop {
            let next = tokio::time::timeout_at(deadline, ws.next()).await;
            let text = match next {
                Ok(Some(Ok(Message::Text(t)))) => t.as_str().to_string(),
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(e))) => return ws_error_end(&e, false),
                Ok(None) | Err(_) => return SessionEnd::Dropped { was_connected: false },
            };
            match proto.parse(&text, now_ms()) {
                WsEvent::AuthOk => break,
                WsEvent::Refused(m) => return SessionEnd::Fatal(m),
                _ => continue,
            }
        }
    }

    if ws.send(Message::text(proto.subscribe())).await.is_err() {
        return SessionEnd::Dropped { was_connected: false };
    }
    sink.status(StreamStatus::Connected);

    let mut heartbeat = tokio::time::interval(timing.heartbeat);
    heartbeat.tick().await;
    loop {
        tokio::select! {
            next = tokio::time::timeout(timing.idle_timeout, ws.next()) => {
                let text = match next {
                    Ok(Some(Ok(Message::Text(t)))) => t.as_str().to_string(),
                    Ok(Some(Ok(Message::Binary(b)))) => match std::str::from_utf8(&b) {
                        Ok(t) => t.to_string(),
                        Err(_) => continue,
                    },
                    Ok(Some(Ok(Message::Close(_)))) | Ok(None) => {
                        return SessionEnd::Dropped { was_connected: true }
                    }
                    Ok(Some(Ok(_))) => continue,
                    Ok(Some(Err(e))) => return ws_error_end(&e, true),
                    Err(_) => return SessionEnd::Dropped { was_connected: true },
                };
                match proto.parse(&text, now_ms()) {
                    WsEvent::Ticks(ticks) => ticks.into_iter().for_each(|t| sink.tick(t)),
                    WsEvent::Refused(m) => return SessionEnd::Fatal(m),
                    WsEvent::AuthOk | WsEvent::Ignore => {}
                }
            }
            _ = heartbeat.tick() => {
                if let Some(h) = proto.heartbeat() {
                    if ws.send(Message::text(h)).await.is_err() {
                        return SessionEnd::Dropped { was_connected: true };
                    }
                }
            }
        }
    }
}

/// The running source and the latest price per symbol.
#[derive(Default)]
struct HubState {
    /// Bumped on every start and stop; a recorder from an older run is ignored.
    generation: u64,
    task: Option<tokio::task::JoinHandle<()>>,
    source: LiveSource,
    symbols: Vec<String>,
    status: Option<StreamStatus>,
    latest: BTreeMap<String, PriceTick>,
}

/// What `quotes_status` returns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotesStatus {
    pub source: LiveSource,
    pub source_label: &'static str,
    pub symbols: Vec<String>,
    pub status: StreamStatus,
    /// Latest price per symbol.
    pub latest: Vec<PriceTick>,
    /// Twelve Data credits left today (Twelve Data sources only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits_left_today: Option<u32>,
}

/// Owns the one running price source. Cheap to share.
pub struct QuoteHub {
    state: Arc<Mutex<HubState>>,
    forward: Arc<dyn TickSink>,
}

/// Records ticks and status in the hub, then forwards them (to the window).
struct Recorder {
    state: Arc<Mutex<HubState>>,
    forward: Arc<dyn TickSink>,
    generation: u64,
}

impl Recorder {
    fn current(&self, state: &HubState) -> bool {
        // A stopped task may still deliver one last message; ignore it.
        state.generation == self.generation
    }
}

impl TickSink for Recorder {
    fn tick(&self, tick: PriceTick) {
        if let Ok(mut s) = self.state.lock() {
            // Only the requested symbols reach the window (a feed can't inject other text).
            if !self.current(&s) || !s.symbols.contains(&tick.symbol) {
                return;
            }
            s.latest.insert(tick.symbol.clone(), tick.clone());
            s.status = Some(StreamStatus::Connected);
        }
        self.forward.tick(tick);
    }

    fn status(&self, status: StreamStatus) {
        if let Ok(mut s) = self.state.lock() {
            if !self.current(&s) {
                return;
            }
            s.status = Some(status.clone());
        }
        self.forward.status(status);
    }
}

impl QuoteHub {
    pub fn new(forward: Arc<dyn TickSink>) -> Self {
        Self {
            state: Arc::new(Mutex::new(HubState::default())),
            forward,
        }
    }

    /// Stops the running source (if any) and clears the prices. Safe from any thread.
    pub fn stop(&self) {
        let task = match self.state.lock() {
            Ok(mut s) => {
                s.generation += 1;
                s.latest.clear();
                s.status = None;
                s.source = LiveSource::Off;
                s.symbols.clear();
                s.task.take()
            }
            Err(_) => None,
        };
        if let Some(task) = task {
            task.abort();
            self.forward.status(StreamStatus::Disconnected);
        }
    }

    /// Starts `run` as the one running source (stopping the previous one). `run` receives the
    /// sink to report to. Must be called inside the async runtime.
    pub fn start<F, Fut>(&self, source: LiveSource, symbols: Vec<String>, run: F)
    where
        F: FnOnce(Arc<dyn TickSink>) -> Fut,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        self.stop();
        let generation = match self.state.lock() {
            Ok(mut s) => {
                s.generation += 1;
                s.generation
            }
            Err(_) => return,
        };
        let recorder: Arc<dyn TickSink> = Arc::new(Recorder {
            state: self.state.clone(),
            forward: self.forward.clone(),
            generation,
        });
        let future = run(recorder);
        if let Ok(mut s) = self.state.lock() {
            s.source = source;
            s.symbols = symbols;
            s.status = Some(StreamStatus::Connecting);
            s.task = Some(tokio::spawn(future));
        }
    }

    pub fn status(&self, credits_left_today: Option<u32>) -> QuotesStatus {
        let s = match self.state.lock() {
            Ok(s) => s,
            Err(p) => p.into_inner(),
        };
        let finished = s.task.as_ref().is_some_and(|t| t.is_finished());
        let status = match (&s.status, &s.task) {
            (Some(st), Some(_)) => st.clone(),
            (Some(st @ StreamStatus::Error { .. }), _) => st.clone(),
            _ => StreamStatus::Disconnected,
        };
        let status = if finished && !matches!(status, StreamStatus::Error { .. }) {
            StreamStatus::Disconnected
        } else {
            status
        };
        let twelve = matches!(s.source, LiveSource::TwelveDataRest | LiveSource::TwelveDataWs);
        QuotesStatus {
            source: s.source,
            source_label: s.source.label(),
            symbols: s.symbols.clone(),
            status,
            latest: s.latest.values().cloned().collect(),
            credits_left_today: credits_left_today.filter(|_| twelve),
        }
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;

    /// Collects everything a source reports.
    #[derive(Default)]
    pub struct Collect {
        pub ticks: Mutex<Vec<PriceTick>>,
        pub statuses: Mutex<Vec<StreamStatus>>,
    }

    impl TickSink for Collect {
        fn tick(&self, tick: PriceTick) {
            self.ticks.lock().unwrap().push(tick);
        }
        fn status(&self, status: StreamStatus) {
            self.statuses.lock().unwrap().push(status);
        }
    }

    impl Collect {
        pub fn tick_symbols(&self) -> Vec<String> {
            self.ticks.lock().unwrap().iter().map(|t| t.symbol.clone()).collect()
        }
        pub fn last_status(&self) -> Option<StreamStatus> {
            self.statuses.lock().unwrap().last().cloned()
        }
    }

    pub const FAST: StreamTiming = StreamTiming {
        backoff_unit: Duration::from_millis(1),
        connect_timeout: Duration::from_secs(5),
        idle_timeout: Duration::from_secs(5),
        heartbeat: Duration::from_millis(200),
        poll_interval: Duration::from_millis(50),
        file_interval: Duration::from_millis(20),
    };

    /// Waits (up to 10 s) until `done` is true.
    pub async fn eventually(mut done: impl FnMut() -> bool) {
        for _ in 0..1000 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached in time");
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn symbols_normalise_to_one_form() {
        for (raw, want) in [
            ("EUR/USD", "EUR/USD"),
            ("eurusd", "EUR/USD"),
            ("EUR_USD", "EUR/USD"),
            ("EURUSD.r", "EUR/USD"),
            ("EURUSDm", "EUR/USD"),
            ("C:EURUSD", "EUR/USD"),
            ("C.EUR/USD", "EUR/USD"),
            (" xauusd ", "XAU/USD"),
            ("US30", "US30"),
            ("GER40.cash", "GER40CASH"),
        ] {
            assert_eq!(normalize_symbol(raw).as_deref(), Some(want), "{raw}");
        }
        assert_eq!(normalize_symbol(""), None);
        assert_eq!(normalize_symbol("/_."), None);
        assert_eq!(normalize_symbol(&"A1".repeat(11)), None);
    }

    #[test]
    fn requested_symbols_are_checked_and_deduplicated() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            requested_symbols(&s(&["EURUSD", "EUR/USD", "gbp_usd"])).unwrap(),
            ["EUR/USD", "GBP/USD"]
        );
        assert_eq!(requested_symbols(&[]).unwrap_err().code, "invalid");
        assert_eq!(requested_symbols(&s(&["", "EURUSD"])).unwrap_err().code, "invalid");
        let many: Vec<String> = (0..40).map(|i| format!("X{i:02}")).collect();
        assert_eq!(requested_symbols(&many).unwrap_err().code, "invalid");
    }

    #[test]
    fn ticks_refuse_non_finite_prices() {
        let t = PriceTick::new("EURUSD", 1.1, 1.1002, 5).unwrap();
        assert_eq!(t.symbol, "EUR/USD");
        assert!((t.mid - 1.1001).abs() < 1e-12);
        assert!((t.spread - 0.0002).abs() < 1e-12);
        assert!(PriceTick::new("EURUSD", f64::NAN, 1.0, 0).is_none());
        assert!(PriceTick::new("EURUSD", 1.0, f64::INFINITY, 0).is_none());
        assert!(PriceTick::new("", 1.0, 1.0, 0).is_none());
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["timestampMs"], 5);
        assert!(json.get("changePercent").is_none());
    }

    #[test]
    fn status_serialises_with_a_state_tag() {
        let v = serde_json::to_value(StreamStatus::Reconnecting { attempt: 3 }).unwrap();
        assert_eq!(v, serde_json::json!({"state": "reconnecting", "attempt": 3}));
        let v = serde_json::to_value(StreamStatus::Disconnected).unwrap();
        assert_eq!(v, serde_json::json!({"state": "disconnected"}));
    }

    #[tokio::test]
    async fn reconnecting_gives_up_after_ten_failures_and_resets_after_a_connection() {
        let sink = Collect::default();
        let mut calls = 0;
        reconnecting(&sink, FAST, || {
            calls += 1;
            async { SessionEnd::Dropped { was_connected: false } }
        })
        .await;
        assert_eq!(calls, 11, "the first try plus 10 reconnects");
        let statuses = sink.statuses.lock().unwrap().clone();
        assert_eq!(statuses[0], StreamStatus::Connecting);
        assert_eq!(statuses[10], StreamStatus::Reconnecting { attempt: 10 });
        assert!(matches!(statuses[11], StreamStatus::Error { .. }));

        // A session that connected resets the count; a fatal end stops at once.
        let sink = Collect::default();
        let mut n = 0;
        reconnecting(&sink, FAST, || {
            n += 1;
            let end = match n {
                1..=15 => SessionEnd::Dropped { was_connected: true },
                _ => SessionEnd::Fatal("refused".into()),
            };
            async move { end }
        })
        .await;
        assert_eq!(n, 16);
        assert_eq!(
            sink.last_status(),
            Some(StreamStatus::Error { message: "refused".into() })
        );
    }

    struct Forward(Arc<Collect>);
    impl TickSink for Forward {
        fn tick(&self, tick: PriceTick) {
            self.0.tick(tick)
        }
        fn status(&self, status: StreamStatus) {
            self.0.status(status)
        }
    }

    #[tokio::test]
    async fn the_hub_records_latest_prices_and_stops_cleanly() {
        let seen = Arc::new(Collect::default());
        let hub = QuoteHub::new(Arc::new(Forward(seen.clone())));
        assert_eq!(hub.status(Some(5)).status, StreamStatus::Disconnected);
        hub.start(
            LiveSource::TwelveDataWs,
            vec!["EUR/USD".into()],
            |sink| async move {
                sink.status(StreamStatus::Connected);
                sink.tick(PriceTick::new("EURUSD", 1.0, 1.1, 1).unwrap());
                sink.tick(PriceTick::new("EURUSD", 1.2, 1.3, 2).unwrap());
                sink.tick(PriceTick::new("GBPUSD", 1.2, 1.3, 3).unwrap());
                std::future::pending::<()>().await;
            },
        );
        eventually(|| seen.ticks.lock().unwrap().len() == 2).await;
        let st = hub.status(Some(700));
        assert_eq!(st.status, StreamStatus::Connected);
        assert_eq!(st.latest.len(), 1);
        assert_eq!(st.latest[0].timestamp_ms, 2);
        assert_eq!(st.credits_left_today, Some(700));
        assert_eq!(st.source_label, "Twelve Data (WebSocket)");
        hub.stop();
        let st = hub.status(Some(700));
        assert_eq!(st.status, StreamStatus::Disconnected);
        assert!(st.latest.is_empty() && st.credits_left_today.is_none());
        assert_eq!(seen.last_status(), Some(StreamStatus::Disconnected));
        hub.stop();
    }

    #[tokio::test]
    async fn a_finished_source_reports_its_final_state() {
        let hub = QuoteHub::new(Arc::new(Collect::default()));
        hub.start(LiveSource::PolygonWs, vec!["EUR/USD".into()], |sink| async move {
            sink.status(StreamStatus::Error { message: "bad key".into() });
        });
        eventually(|| matches!(hub.status(None).status, StreamStatus::Error { .. })).await;
        hub.start(LiveSource::Mt5File, vec!["EUR/USD".into()], |_sink| async move {});
        eventually(|| hub.status(None).status == StreamStatus::Disconnected).await;
        assert_eq!(hub.status(None).credits_left_today, None);
    }
}
