//! The online service behind the IPC commands: holds the vault handle, the endpoints, the
//! caches and the running price source. Its methods take the journal's online settings as an
//! argument (the command layer reads them), so everything here is testable against mock
//! servers without a window or a journal.
//!
//! **No method returns a key.** Keys are read with [`secrets::require`] right before a request
//! and go into a header; results and errors are built from provider data that has been parsed
//! into fixed shapes, and provider text is redacted ([`super::provider_text`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::anthropic::{self, AiPreview, Answer, ModelInfo};
use super::calendar::{CalendarCache, CalendarWeek};
use super::finnhub::{self, CompanyProfile, FinnhubCache, StockQuote, SymbolSearchResult};
use super::oanda::{self, OandaHistory};
use super::quotes::{self, QuoteHub, QuotesStatus, StreamTiming, TickSink};
use super::secrets::{self, ANTHROPIC, FINNHUB, OANDA_ACCOUNT, OANDA_TOKEN, POLYGON, TWELVE_DATA};
use super::settings::{LiveSource, OnlineSettings};
use super::usage::DailyCounter;
use super::{mt5_prices, no_echo, polygon, twelvedata, NetError, NetPolicy};
use crate::vault::SecretStore;

/// Every provider address in one place. Production uses [`Endpoints::production`]; unit tests
/// point everything at local mock servers.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub anthropic: String,
    pub twelve_rest: String,
    pub twelve_ws: String,
    pub polygon_ws: String,
    pub polygon_rest: String,
    pub oanda_rest_practice: String,
    pub oanda_rest_live: String,
    pub oanda_stream_practice: String,
    pub oanda_stream_live: String,
    pub calendar: String,
    pub finnhub: String,
}

impl Endpoints {
    pub fn production() -> Self {
        Self {
            anthropic: anthropic::BASE.into(),
            twelve_rest: twelvedata::REST_BASE.into(),
            twelve_ws: twelvedata::WS_URL.into(),
            polygon_ws: polygon::WS_URL.into(),
            polygon_rest: polygon::REST_BASE.into(),
            oanda_rest_practice: oanda::REST_PRACTICE.into(),
            oanda_rest_live: oanda::REST_LIVE.into(),
            oanda_stream_practice: oanda::STREAM_PRACTICE.into(),
            oanda_stream_live: oanda::STREAM_LIVE.into(),
            calendar: super::calendar::URL.into(),
            finnhub: finnhub::BASE.into(),
        }
    }

    /// Everything on one HTTP mock server (paths don't overlap) and one WebSocket server.
    #[cfg(test)]
    pub fn local(http: &str, ws: &str) -> Self {
        Self {
            anthropic: http.into(),
            twelve_rest: format!("{http}/td"),
            twelve_ws: format!("{ws}/td"),
            polygon_ws: format!("{ws}/polygon"),
            polygon_rest: format!("{http}/pg"),
            oanda_rest_practice: format!("{http}/oanda-practice"),
            oanda_rest_live: format!("{http}/oanda-live"),
            oanda_stream_practice: format!("{http}/oanda-stream-practice"),
            oanda_stream_live: format!("{http}/oanda-stream-live"),
            calendar: format!("{http}/ff_calendar_thisweek.json"),
            finnhub: format!("{http}/api/v1"),
        }
    }
}

/// Request and stream timing (unit tests shorten all of it).
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub request: Duration,
    /// `None`: the brand's AI timeout (300 s Dojix, 180 s Greenwick).
    pub ai: Option<Duration>,
    pub stream: StreamTiming,
}

impl Timeouts {
    pub const APP: Self = Self {
        request: Duration::from_secs(30),
        ai: None,
        stream: StreamTiming::APP,
    };
}

/// What Settings shows. Holds no key: only whether each key is stored.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSettingsView {
    pub brand: &'static str,
    pub ai_enabled: bool,
    /// The model a run uses (the picker's choice or the brand default).
    pub ai_model: String,
    pub ai_default_model: &'static str,
    pub ai_consented: bool,
    pub live_source: LiveSource,
    pub oanda_live: bool,
    pub finnhub_enabled: bool,
    pub calendar_enabled: bool,
    pub calendar_source: &'static str,
    pub oanda_import_days: u32,
    /// Which of the brand's keys are stored (`account → stored`).
    pub keys: BTreeMap<String, bool>,
    /// False when keys can't be stored at all (Linux without a Secret Service).
    pub keyring_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
}

pub struct Online {
    pub brand_id: &'static str,
    vault: Arc<dyn SecretStore>,
    endpoints: Endpoints,
    policy: NetPolicy,
    timeouts: Timeouts,
    http: Mutex<Option<reqwest::Client>>,
    budget: Arc<DailyCounter>,
    calendar: CalendarCache,
    finnhub: FinnhubCache,
    pub hub: QuoteHub,
    ai_busy: tokio::sync::Mutex<()>,
    mt5_dirs: Option<Vec<PathBuf>>,
}

impl Online {
    /// The app's service: production endpoints, strict URL policy.
    pub fn new(
        brand_id: &'static str,
        vault: Arc<dyn SecretStore>,
        data_root: &Path,
        sink: Arc<dyn TickSink>,
    ) -> Self {
        Self::with(
            brand_id,
            vault,
            data_root,
            sink,
            Endpoints::production(),
            NetPolicy::STRICT,
            Timeouts::APP,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with(
        brand_id: &'static str,
        vault: Arc<dyn SecretStore>,
        data_root: &Path,
        sink: Arc<dyn TickSink>,
        endpoints: Endpoints,
        policy: NetPolicy,
        timeouts: Timeouts,
        mt5_dirs: Option<Vec<PathBuf>>,
    ) -> Self {
        Self {
            brand_id,
            vault,
            endpoints,
            policy,
            timeouts,
            http: Mutex::new(None),
            budget: Arc::new(DailyCounter::new(data_root)),
            calendar: CalendarCache::default(),
            finnhub: FinnhubCache::default(),
            hub: QuoteHub::new(sink),
            ai_busy: tokio::sync::Mutex::new(()),
            mt5_dirs,
        }
    }

    fn dojix(&self) -> Result<(), NetError> {
        if self.brand_id == "dojix" {
            Ok(())
        } else {
            Err(NetError::unsupported())
        }
    }

    fn greenwick(&self) -> Result<(), NetError> {
        if self.brand_id == "greenwick" {
            Ok(())
        } else {
            Err(NetError::unsupported())
        }
    }

    /// The shared HTTPS client (created on first use).
    fn http(&self) -> Result<reqwest::Client, NetError> {
        let mut slot = self.http.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = slot.as_ref() {
            return Ok(c.clone());
        }
        let client = super::http_client(self.timeouts.request, self.policy)?;
        *slot = Some(client.clone());
        Ok(client)
    }

    fn key(&self, account: &str) -> Result<zeroize::Zeroizing<String>, NetError> {
        secrets::require(self.vault.as_ref(), account)
    }

    /// Forget everything held in memory (on lock).
    pub fn on_lock(&self) {
        self.hub.stop();
        self.calendar.clear();
        self.finnhub.clear();
    }

    // -----------------------------------------------------------------------------------------
    // Settings and keys
    // -----------------------------------------------------------------------------------------

    pub fn settings_view(&self, s: &OnlineSettings, calendar_enabled: bool) -> OnlineSettingsView {
        let brand = anthropic::ai_brand(self.brand_id);
        OnlineSettingsView {
            brand: if self.brand_id == "greenwick" { "greenwick" } else { "dojix" },
            ai_enabled: s.ai_enabled,
            ai_model: s
                .ai_model
                .clone()
                .unwrap_or_else(|| brand.default_model.to_string()),
            ai_default_model: brand.default_model,
            ai_consented: s.ai_consented_at.is_some(),
            live_source: s.live_source,
            oanda_live: s.oanda_live,
            finnhub_enabled: s.finnhub_enabled,
            calendar_enabled,
            calendar_source: super::calendar::SOURCE_LABEL,
            oanda_import_days: s.oanda_import_days,
            keys: secrets::status(self.vault.as_ref(), self.brand_id),
            keyring_available: !self.vault.lock_required() && self.vault.backend() != "unavailable",
        }
    }

    pub fn set_secret(&self, account: &str, value: &str) -> Result<(), NetError> {
        secrets::set(self.vault.as_ref(), self.brand_id, account, value)?;
        self.after_key_change(account);
        Ok(())
    }

    pub fn has_secret(&self, account: &str) -> Result<bool, NetError> {
        secrets::has(self.vault.as_ref(), self.brand_id, account)
    }

    pub fn delete_secret(&self, account: &str) -> Result<(), NetError> {
        secrets::delete(self.vault.as_ref(), self.brand_id, account)?;
        self.after_key_change(account);
        Ok(())
    }

    /// A running stream keeps the key it started with; a changed key restarts nothing
    /// silently: the stream is stopped and the UI starts it again.
    fn after_key_change(&self, account: &str) {
        if matches!(account, TWELVE_DATA | POLYGON | OANDA_TOKEN | OANDA_ACCOUNT) {
            self.hub.stop();
        }
        if account == FINNHUB {
            self.finnhub.clear();
        }
    }

    // -----------------------------------------------------------------------------------------
    // Settings → Test
    // -----------------------------------------------------------------------------------------

    /// Settings → Test for one provider. Sends only what the Mac's Test sends (a model list,
    /// one EUR/USD or AAPL quote, an account summary): never trading data.
    pub async fn test_connection(
        &self,
        provider: &str,
        s: &OnlineSettings,
    ) -> Result<TestResult, NetError> {
        let result = self.test_connection_inner(provider, s).await?;
        let keys = self.all_keys();
        let refs: Vec<&str> = keys.iter().map(|k| k.as_str()).collect();
        no_echo(result, "The provider", &refs)
    }

    /// Every stored key of this brand (for [`no_echo`]); never leaves this module. The OANDA
    /// account ID is not a secret (OANDA's own responses contain it).
    fn all_keys(&self) -> Vec<zeroize::Zeroizing<String>> {
        secrets::accounts_for(self.brand_id)
            .iter()
            .filter(|a| **a != OANDA_ACCOUNT)
            .filter_map(|a| secrets::read(self.vault.as_ref(), a).ok().flatten())
            .collect()
    }

    async fn test_connection_inner(
        &self,
        provider: &str,
        s: &OnlineSettings,
    ) -> Result<TestResult, NetError> {
        let ok = |message: String| TestResult { ok: true, message };
        let http = self.http()?;
        match provider {
            "anthropic" => {
                let key = self.key(ANTHROPIC)?;
                anthropic::list_models(&http, &self.endpoints.anthropic, self.policy, &key, 1, 1)
                    .await?;
                Ok(ok("Connected — the key works.".into()))
            }
            "twelve_data" => {
                self.dojix()?;
                let key = self.key(TWELVE_DATA)?;
                let quotes = twelvedata::get_quotes(
                    &http,
                    &self.endpoints.twelve_rest,
                    self.policy,
                    &key,
                    &["EUR/USD".to_string()],
                    &self.budget,
                )
                .await?;
                let q = quotes
                    .first()
                    .ok_or_else(|| NetError::new("empty", "Twelve Data returned no data."))?;
                Ok(ok(format!("Connected — EUR/USD: {:.5}", q.close)))
            }
            "polygon" => {
                self.dojix()?;
                let key = self.key(POLYGON)?;
                polygon::test(&http, &self.endpoints.polygon_rest, self.policy, &key)
                    .await
                    .map(ok)
            }
            "oanda_stream" | "oanda_import" => {
                self.dojix()?;
                let token = self.key(OANDA_TOKEN)?;
                let account = self.key(OANDA_ACCOUNT)?;
                let rest = self.oanda_rest(s.oanda_live);
                if provider == "oanda_stream" {
                    oanda::pricing_test(&http, rest, self.policy, &token, &account, s.oanda_live)
                        .await
                        .map(ok)
                } else {
                    oanda::account_summary(&http, rest, self.policy, &token, &account)
                        .await
                        .map(ok)
                }
            }
            "finnhub" => {
                self.greenwick()?;
                let key = self.key(FINNHUB)?;
                finnhub::test(&http, &self.endpoints.finnhub, self.policy, &key, &self.finnhub)
                    .await
                    .map(ok)
            }
            "mt5_file" => {
                self.dojix()?;
                let dirs = self.mt5_dirs();
                tokio::task::spawn_blocking(move || {
                    mt5_prices::test(&dirs, std::time::SystemTime::now())
                })
                .await
                .map_err(|_| NetError::new("io", "The check stopped unexpectedly."))?
                .map(ok)
            }
            _ => Err(NetError::invalid("Unknown provider.")),
        }
    }

    fn oanda_rest(&self, live: bool) -> &str {
        if live {
            &self.endpoints.oanda_rest_live
        } else {
            &self.endpoints.oanda_rest_practice
        }
    }

    fn mt5_dirs(&self) -> Vec<PathBuf> {
        self.mt5_dirs
            .clone()
            .unwrap_or_else(mt5_prices::common_files_dirs)
    }

    // -----------------------------------------------------------------------------------------
    // AI
    // -----------------------------------------------------------------------------------------

    pub fn ai_model(&self, s: &OnlineSettings) -> String {
        s.ai_model
            .clone()
            .unwrap_or_else(|| anthropic::ai_brand(self.brand_id).default_model.to_string())
    }

    /// "Show what will be sent": needs neither the switch nor a key (nothing is sent).
    pub fn ai_preview(&self, s: &OnlineSettings, prompt: &str) -> Result<AiPreview, NetError> {
        let brand = anthropic::ai_brand(self.brand_id);
        let request = anthropic::build_request(&brand, &self.ai_model(s), prompt)?;
        Ok(anthropic::preview(&self.endpoints.anthropic, &request))
    }

    /// The model picker: the provider's model list.
    pub async fn ai_models(&self) -> Result<Vec<ModelInfo>, NetError> {
        let key = self.key(ANTHROPIC)?;
        let models = anthropic::list_models(
            &self.http()?,
            &self.endpoints.anthropic,
            self.policy,
            &key,
            100,
            anthropic::MAX_MODEL_PAGES,
        )
        .await?;
        no_echo(models, anthropic::PROVIDER, &[key.as_str()])
    }

    /// Run Analysis. Gates (SPEC 8.2): the switch is on, a key is stored, and the request is
    /// byte-for-byte the one the preview showed (`expected_sha256`). One run at a time.
    pub async fn ai_run(
        &self,
        s: &OnlineSettings,
        prompt: &str,
        expected_sha256: &str,
    ) -> Result<(anthropic::Request, Answer), NetError> {
        if !s.ai_enabled {
            return Err(NetError::off("AI analysis"));
        }
        let brand = anthropic::ai_brand(self.brand_id);
        let request = anthropic::build_request(&brand, &self.ai_model(s), prompt)?;
        if request.sha256 != expected_sha256 {
            return Err(NetError::new(
                "preview_mismatch",
                "The summary changed since it was shown. Review it again before sending.",
            ));
        }
        let key = self.key(ANTHROPIC)?;
        let Ok(_guard) = self.ai_busy.try_lock() else {
            return Err(NetError::new("busy", "An analysis is already running."));
        };
        let timeout = self.timeouts.ai.unwrap_or(brand.timeout);
        let answer = anthropic::send(
            &self.http()?,
            &self.endpoints.anthropic,
            self.policy,
            &key,
            &request,
            timeout,
        )
        .await?;
        Ok((request, answer))
    }

    // -----------------------------------------------------------------------------------------
    // Live prices (Dojix)
    // -----------------------------------------------------------------------------------------

    pub fn credits_left_today(&self) -> u32 {
        self.budget.remaining(crate::journal::now_ms())
    }

    pub fn quotes_status(&self) -> QuotesStatus {
        self.hub.status(Some(self.credits_left_today()))
    }

    pub fn quotes_stop(&self) {
        self.hub.stop();
    }

    /// Starts the source chosen in Settings for `symbols`. Must run inside the async runtime.
    pub fn quotes_start(
        &self,
        s: &OnlineSettings,
        symbols: &[String],
    ) -> Result<QuotesStatus, NetError> {
        self.dojix()?;
        let symbols = quotes::requested_symbols(symbols)?;
        let timing = self.timeouts.stream;
        let policy = self.policy;
        match s.live_source {
            LiveSource::Off => return Err(NetError::off("Live prices")),
            LiveSource::TwelveDataRest => {
                let key = self.key(TWELVE_DATA)?;
                let (http, base, budget) = (
                    self.http()?,
                    self.endpoints.twelve_rest.clone(),
                    self.budget.clone(),
                );
                let syms = symbols.clone();
                self.hub.start(s.live_source, symbols, move |sink| {
                    twelvedata::poll(http, base, policy, key, syms, budget, timing, sink)
                });
            }
            LiveSource::TwelveDataWs => {
                let proto = twelvedata::Ws {
                    key: self.key(TWELVE_DATA)?,
                    symbols: symbols.clone(),
                };
                let url = super::checked_url(&self.endpoints.twelve_ws, twelvedata::HOSTS, policy)?;
                self.hub.start(s.live_source, symbols, move |sink| {
                    twelvedata::stream(url, policy, proto, timing, sink)
                });
            }
            LiveSource::PolygonWs => {
                let proto = polygon::Ws {
                    key: self.key(POLYGON)?,
                    symbols: symbols.clone(),
                };
                let url = super::checked_url(&self.endpoints.polygon_ws, polygon::HOSTS, policy)?;
                self.hub.start(s.live_source, symbols, move |sink| {
                    polygon::stream(url, policy, proto, timing, sink)
                });
            }
            LiveSource::OandaStream => {
                let token = self.key(OANDA_TOKEN)?;
                let account = self.key(OANDA_ACCOUNT)?.to_string();
                let base = if s.oanda_live {
                    self.endpoints.oanda_stream_live.clone()
                } else {
                    self.endpoints.oanda_stream_practice.clone()
                };
                let http = super::stream_client(oanda::STREAM_READ_TIMEOUT, policy)?;
                let syms = symbols.clone();
                self.hub.start(s.live_source, symbols, move |sink| {
                    oanda::stream(http, base, policy, token, account, syms, timing, sink)
                });
            }
            LiveSource::Mt5File => {
                let dirs = self.mt5_dirs();
                let syms = symbols.clone();
                self.hub.start(s.live_source, symbols, move |sink| {
                    mt5_prices::watch(dirs, syms, timing, sink)
                });
            }
        }
        Ok(self.quotes_status())
    }

    // -----------------------------------------------------------------------------------------
    // Economic calendar (Dojix)
    // -----------------------------------------------------------------------------------------

    pub async fn calendar_week(&self, enabled: bool, force: bool) -> Result<CalendarWeek, NetError> {
        self.dojix()?;
        if !enabled {
            return Err(NetError::off("The economic calendar"));
        }
        self.calendar
            .week(&self.http()?, &self.endpoints.calendar, self.policy, force)
            .await
    }

    pub fn calendar_clear(&self) {
        self.calendar.clear();
    }

    // -----------------------------------------------------------------------------------------
    // Finnhub (Greenwick)
    // -----------------------------------------------------------------------------------------

    fn finnhub_key(&self, s: &OnlineSettings) -> Result<zeroize::Zeroizing<String>, NetError> {
        self.greenwick()?;
        if !s.finnhub_enabled {
            return Err(NetError::off("Market data (Finnhub)"));
        }
        self.key(FINNHUB)
    }

    pub async fn finnhub_quote(&self, s: &OnlineSettings, symbol: &str) -> Result<StockQuote, NetError> {
        let key = self.finnhub_key(s)?;
        let q = finnhub::quote(&self.http()?, &self.endpoints.finnhub, self.policy, &key, symbol, &self.finnhub)
            .await?;
        no_echo(q, finnhub::PROVIDER, &[key.as_str()])
    }

    pub async fn finnhub_profile(
        &self,
        s: &OnlineSettings,
        symbol: &str,
    ) -> Result<CompanyProfile, NetError> {
        let key = self.finnhub_key(s)?;
        let p = finnhub::profile(&self.http()?, &self.endpoints.finnhub, self.policy, &key, symbol, &self.finnhub)
            .await?;
        no_echo(p, finnhub::PROVIDER, &[key.as_str()])
    }

    pub async fn finnhub_search(
        &self,
        s: &OnlineSettings,
        query: &str,
    ) -> Result<Vec<SymbolSearchResult>, NetError> {
        let key = self.finnhub_key(s)?;
        let found = finnhub::search(&self.http()?, &self.endpoints.finnhub, self.policy, &key, query, &self.finnhub)
            .await?;
        no_echo(found, finnhub::PROVIDER, &[key.as_str()])
    }

    // -----------------------------------------------------------------------------------------
    // OANDA history import (Dojix)
    // -----------------------------------------------------------------------------------------

    /// Fetches the last `days` (default: the setting) of `ORDER_FILL` transactions.
    pub async fn oanda_history(
        &self,
        s: &OnlineSettings,
        days: Option<u32>,
    ) -> Result<OandaHistory, NetError> {
        self.dojix()?;
        let days = days.unwrap_or(s.oanda_import_days);
        if !(1..=super::settings::OANDA_MAX_DAYS).contains(&days) {
            return Err(NetError::invalid("Choose between 1 and 3650 days."));
        }
        let token = self.key(OANDA_TOKEN)?;
        let account = self.key(OANDA_ACCOUNT)?;
        let history = oanda::fetch_history(
            &self.http()?,
            self.oanda_rest(s.oanda_live),
            self.policy,
            &token,
            &account,
            days,
            crate::journal::now_ms(),
        )
        .await?;
        no_echo(history, oanda::PROVIDER, &[token.as_str()])
    }
}
