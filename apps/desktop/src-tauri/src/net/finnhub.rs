//! Finnhub quotes, company profiles and symbol search for Greenwick's Browse and Watchlist
//! (SPEC 8.3). Mac: `Services/StockData/StockDataService.swift`, `Models/StockQuote.swift`.
//!
//! - The key goes in `X-Finnhub-Token`, as on the Mac.
//! - Quotes are cached 30 s and shared by every screen; profiles for the session; search
//!   results are not cached. Nothing is written to disk.
//! - A local limit of 60 requests a minute (the free plan's) keeps a busy screen from being
//!   locked out by the provider.
//! - No certificate pinning (the Mac pins CA keys for this host; PARITY B2).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{checked_url, fetch_json, NetError, NetPolicy};

pub const PROVIDER: &str = "Finnhub";
pub const HOSTS: &[&str] = &["finnhub.io"];
pub const BASE: &str = "https://finnhub.io/api/v1";
const MAX_BODY: usize = 2 * 1024 * 1024;
pub const QUOTE_TTL: Duration = Duration::from_secs(30);
pub const PER_MINUTE: usize = 60;
const MAX_PROFILES: usize = 500;
const MAX_TEXT: usize = 200;

/// `StockQuote` (Finnhub `/quote`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockQuote {
    pub symbol: String,
    pub current_price: f64,
    pub change: f64,
    pub percent_change: f64,
    pub high: f64,
    pub low: f64,
    pub open: f64,
    pub previous_close: f64,
    pub timestamp: i64,
}

/// `CompanyProfile` (Finnhub `/stock/profile2`). The logo and web address are left out: the
/// web view loads no remote images or pages.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyProfile {
    pub name: String,
    pub ticker: String,
    pub exchange: String,
    pub industry: String,
    /// Millions, as Finnhub reports it.
    pub market_cap: f64,
    /// Millions.
    pub shares_outstanding: f64,
    pub ipo: String,
    pub country: String,
}

/// `SymbolSearchResult`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSearchResult {
    pub description: String,
    pub display_symbol: String,
    pub symbol: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// Upper-cased ticker: letters, digits and `. - ^ = :`, 1–20 characters.
pub fn ticker(raw: &str) -> Result<String, NetError> {
    let t = raw.trim().to_ascii_uppercase();
    let ok = !t.is_empty()
        && t.len() <= 20
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'^' | b'=' | b':'));
    if ok {
        Ok(t)
    } else {
        Err(NetError::invalid("That isn't a ticker symbol."))
    }
}

fn clean(v: Option<&Value>) -> String {
    v.and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TEXT)
        .collect()
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|x| x.is_finite())
}

/// Finnhub answers an unknown symbol with zeros and nulls; the Mac fails to decode that.
pub fn parse_quote(symbol: &str, json: &Value) -> Result<StockQuote, NetError> {
    let missing = || NetError::new("not_found", format!("No quote for {symbol}."));
    let q = StockQuote {
        symbol: symbol.to_string(),
        current_price: finite(json.get("c")).ok_or_else(missing)?,
        change: finite(json.get("d")).ok_or_else(missing)?,
        percent_change: finite(json.get("dp")).ok_or_else(missing)?,
        high: finite(json.get("h")).ok_or_else(missing)?,
        low: finite(json.get("l")).ok_or_else(missing)?,
        open: finite(json.get("o")).ok_or_else(missing)?,
        previous_close: finite(json.get("pc")).ok_or_else(missing)?,
        timestamp: json.get("t").and_then(Value::as_i64).ok_or_else(missing)?,
    };
    Ok(q)
}

pub fn parse_profile(symbol: &str, json: &Value) -> Result<CompanyProfile, NetError> {
    let name = clean(json.get("name"));
    if name.is_empty() {
        return Err(NetError::new(
            "not_found",
            format!("No company profile for {symbol}."),
        ));
    }
    let ticker = clean(json.get("ticker"));
    Ok(CompanyProfile {
        name,
        ticker: if ticker.is_empty() {
            symbol.to_string()
        } else {
            ticker
        },
        exchange: clean(json.get("exchange")),
        industry: clean(json.get("finnhubIndustry")),
        market_cap: finite(json.get("marketCapitalization")).unwrap_or(0.0),
        shares_outstanding: finite(json.get("shareOutstanding")).unwrap_or(0.0),
        ipo: clean(json.get("ipo")),
        country: clean(json.get("country")),
    })
}

/// `searchSymbols`: common stock and ETPs (and untyped rows), the first 10.
pub fn parse_search(json: &Value) -> Result<Vec<SymbolSearchResult>, NetError> {
    let rows = json
        .get("result")
        .and_then(Value::as_array)
        .ok_or_else(|| NetError::bad_response(PROVIDER))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let kind = clean(r.get("type"));
            let symbol = clean(r.get("symbol"));
            (matches!(kind.as_str(), "Common Stock" | "ETP" | "") && !symbol.is_empty()).then(
                || SymbolSearchResult {
                    description: clean(r.get("description")),
                    display_symbol: clean(r.get("displaySymbol")),
                    symbol,
                    kind,
                },
            )
        })
        .take(10)
        .collect())
}

/// Caches and the local rate limit, shared by every screen.
#[derive(Default)]
pub struct FinnhubCache {
    quotes: Mutex<HashMap<String, (StockQuote, Instant)>>,
    profiles: Mutex<HashMap<String, CompanyProfile>>,
    recent: Mutex<VecDeque<Instant>>,
}

impl FinnhubCache {
    fn take_slot(&self) -> Result<(), NetError> {
        let now = Instant::now();
        let mut recent = self.recent.lock().unwrap_or_else(|p| p.into_inner());
        while recent
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
        {
            recent.pop_front();
        }
        if recent.len() >= PER_MINUTE {
            return Err(NetError::new(
                "rate_limited",
                "Too many lookups in the last minute. Try again shortly.",
            ));
        }
        recent.push_back(now);
        Ok(())
    }

    pub fn clear(&self) {
        if let Ok(mut q) = self.quotes.lock() {
            q.clear();
        }
        if let Ok(mut p) = self.profiles.lock() {
            p.clear();
        }
    }
}

async fn get(
    http: &reqwest::Client,
    base: &str,
    policy: NetPolicy,
    key: &str,
    path: &str,
    query: &[(&str, &str)],
    cache: &FinnhubCache,
) -> Result<Value, NetError> {
    let mut url = checked_url(
        &format!("{}{path}", base.trim_end_matches('/')),
        HOSTS,
        policy,
    )?;
    {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in query {
            pairs.append_pair(k, v);
        }
    }
    cache.take_slot()?;
    fetch_json(
        PROVIDER,
        http.get(url).header("X-Finnhub-Token", key),
        MAX_BODY,
    )
    .await
}

pub async fn quote(
    http: &reqwest::Client,
    base: &str,
    policy: NetPolicy,
    key: &str,
    symbol: &str,
    cache: &FinnhubCache,
) -> Result<StockQuote, NetError> {
    let symbol = ticker(symbol)?;
    let cached = cache.quotes.lock().ok().and_then(|q| {
        q.get(&symbol)
            .filter(|(_, at)| at.elapsed() < QUOTE_TTL)
            .map(|(quote, _)| quote.clone())
    });
    if let Some(q) = cached {
        return Ok(q);
    }
    let json = get(
        http,
        base,
        policy,
        key,
        "/quote",
        &[("symbol", symbol.as_str())],
        cache,
    )
    .await?;
    let q = parse_quote(&symbol, &json)?;
    if let Ok(mut map) = cache.quotes.lock() {
        map.retain(|_, (_, at)| at.elapsed() < QUOTE_TTL);
        map.insert(symbol, (q.clone(), Instant::now()));
    }
    Ok(q)
}

pub async fn profile(
    http: &reqwest::Client,
    base: &str,
    policy: NetPolicy,
    key: &str,
    symbol: &str,
    cache: &FinnhubCache,
) -> Result<CompanyProfile, NetError> {
    let symbol = ticker(symbol)?;
    let cached = cache
        .profiles
        .lock()
        .ok()
        .and_then(|p| p.get(&symbol).cloned());
    if let Some(p) = cached {
        return Ok(p);
    }
    let json = get(
        http,
        base,
        policy,
        key,
        "/stock/profile2",
        &[("symbol", symbol.as_str())],
        cache,
    )
    .await?;
    let p = parse_profile(&symbol, &json)?;
    if let Ok(mut map) = cache.profiles.lock() {
        if map.len() >= MAX_PROFILES {
            map.clear();
        }
        map.insert(symbol, p.clone());
    }
    Ok(p)
}

pub async fn search(
    http: &reqwest::Client,
    base: &str,
    policy: NetPolicy,
    key: &str,
    query: &str,
    cache: &FinnhubCache,
) -> Result<Vec<SymbolSearchResult>, NetError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    if q.chars().count() > 50 || q.chars().any(char::is_control) {
        return Err(NetError::invalid("Search for a name or a ticker."));
    }
    let json = get(http, base, policy, key, "/search", &[("q", q)], cache).await?;
    parse_search(&json)
}

/// Settings → Test: a quote for AAPL, as on the Mac.
pub async fn test(
    http: &reqwest::Client,
    base: &str,
    policy: NetPolicy,
    key: &str,
    cache: &FinnhubCache,
) -> Result<String, NetError> {
    let json = get(
        http,
        base,
        policy,
        key,
        "/quote",
        &[("symbol", "AAPL")],
        cache,
    )
    .await?;
    let q = parse_quote("AAPL", &json)?;
    Ok(format!("Connected — AAPL {:.2}", q.current_price))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tickers_are_checked() {
        assert_eq!(ticker(" fict ").unwrap(), "FICT");
        assert_eq!(ticker("BRK.B").unwrap(), "BRK.B");
        let long = "X".repeat(21);
        for bad in ["", "A B", "A/B", "A&x=1", long.as_str()] {
            assert_eq!(ticker(bad).unwrap_err().code, "invalid", "{bad}");
        }
    }

    #[test]
    fn quotes_profiles_and_search_parse() {
        let q = parse_quote("FICT", &json!({"c": 12.5, "d": -0.5, "dp": -3.85, "h": 13, "l": 12, "o": 13, "pc": 13, "t": 1793017800})).unwrap();
        assert_eq!(q.current_price, 12.5);
        assert_eq!(q.timestamp, 1_793_017_800);
        let unknown =
            json!({"c": 0, "d": null, "dp": null, "h": 0, "l": 0, "o": 0, "pc": 0, "t": 0});
        assert_eq!(parse_quote("NOPE", &unknown).unwrap_err().code, "not_found");

        let p = parse_profile("FICT", &json!({"name": "Fictional Corp", "finnhubIndustry": "Widgets", "marketCapitalization": 1234.5, "logo": "https://example.invalid/logo.png"})).unwrap();
        assert_eq!(
            (p.ticker.as_str(), p.industry.as_str()),
            ("FICT", "Widgets")
        );
        assert_eq!(p.shares_outstanding, 0.0);
        assert!(!serde_json::to_string(&p).unwrap().contains("logo"));
        assert_eq!(
            parse_profile("FICT", &json!({})).unwrap_err().code,
            "not_found"
        );

        let rows: Vec<Value> = (0..15)
            .map(|i| json!({"description": format!("Fictional {i}"), "displaySymbol": format!("F{i}"), "symbol": format!("F{i}"), "type": if i == 0 { "Crypto" } else { "Common Stock" }}))
            .collect();
        let found = parse_search(&json!({"count": 15, "result": rows})).unwrap();
        assert_eq!(found.len(), 10);
        assert_eq!(found[0].symbol, "F1");
        let v = serde_json::to_value(&found[0]).unwrap();
        assert_eq!(v["type"], "Common Stock");
        assert_eq!(v["displaySymbol"], "F1");
        assert_eq!(
            parse_search(&json!({"count": 0})).unwrap_err().code,
            "bad_response"
        );
    }

    #[test]
    fn the_local_limit_allows_sixty_a_minute() {
        let c = FinnhubCache::default();
        for _ in 0..PER_MINUTE {
            c.take_slot().unwrap();
        }
        assert_eq!(c.take_slot().unwrap_err().code, "rate_limited");
        c.clear();
    }
}
