//! Online settings kept in the encrypted journal (`settings` table, key `online`): the AI
//! switch and model, the live-data source, the Finnhub switch and the OANDA import window.
//! Everything is off by default (PARITY A2 item 17). The economic-calendar toggle lives in
//! `prefs.json` instead (SPEC 2.6: on by default, readable without the journal).

use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use super::NetError;

pub const KEY: &str = "online";
/// OANDA history import window (SPEC 8.4): 90 days unless the user changes it.
pub const OANDA_DEFAULT_DAYS: u32 = 90;
pub const OANDA_MAX_DAYS: u32 = 3650;

/// Where Pulse and the sidebar ticker get prices (Dojix). `Off` until the user picks one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveSource {
    #[default]
    Off,
    TwelveDataRest,
    TwelveDataWs,
    OandaStream,
    PolygonWs,
    Mt5File,
}

impl LiveSource {
    pub fn label(self) -> &'static str {
        match self {
            LiveSource::Off => "Off",
            LiveSource::TwelveDataRest => "Twelve Data (Polling)",
            LiveSource::TwelveDataWs => "Twelve Data (WebSocket)",
            LiveSource::OandaStream => "OANDA (Streaming)",
            LiveSource::PolygonWs => "Polygon.io (WebSocket)",
            LiveSource::Mt5File => "MT5 Direct (File)",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OnlineSettings {
    /// "Allow AI analysis" (off by default, both brands; SPEC 8.2).
    pub ai_enabled: bool,
    /// Advanced model picker; `None` = the brand's default.
    pub ai_model: Option<String>,
    /// When the user first agreed to send the summary (epoch ms). The first run asks.
    pub ai_consented_at: Option<i64>,
    pub live_source: LiveSource,
    /// OANDA host: practice (default) or live.
    pub oanda_live: bool,
    /// Greenwick Browse / Watchlist quotes (off by default).
    pub finnhub_enabled: bool,
    pub oanda_import_days: u32,
}

impl Default for OnlineSettings {
    fn default() -> Self {
        Self {
            ai_enabled: false,
            ai_model: None,
            ai_consented_at: None,
            live_source: LiveSource::Off,
            oanda_live: false,
            finnhub_enabled: false,
            oanda_import_days: OANDA_DEFAULT_DAYS,
        }
    }
}

/// A partial update from Settings. Absent fields keep their value; `aiModel: ""` resets the
/// model to the brand default.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct OnlineSettingsPatch {
    pub ai_enabled: Option<bool>,
    pub ai_model: Option<String>,
    pub live_source: Option<LiveSource>,
    pub oanda_live: Option<bool>,
    pub finnhub_enabled: Option<bool>,
    pub calendar_enabled: Option<bool>,
    pub oanda_import_days: Option<u32>,
}

/// Model ids look like `claude-opus-5-5`: lower-case letters, digits, dots and dashes.
pub fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
}

impl OnlineSettings {
    /// Repairs values a damaged or older row could hold.
    fn sanitized(mut self) -> Self {
        if self.ai_model.as_deref().is_some_and(|m| !valid_model_id(m)) {
            self.ai_model = None;
        }
        if !(1..=OANDA_MAX_DAYS).contains(&self.oanda_import_days) {
            self.oanda_import_days = OANDA_DEFAULT_DAYS;
        }
        self
    }

    /// Applies a patch (validated); the calendar toggle is handled by the caller.
    pub fn apply(&mut self, patch: &OnlineSettingsPatch, brand_id: &str) -> Result<(), NetError> {
        if let Some(model) = &patch.ai_model {
            let model = model.trim();
            if model.is_empty() {
                self.ai_model = None;
            } else if valid_model_id(model) {
                self.ai_model = Some(model.to_string());
            } else {
                return Err(NetError::invalid("That isn't a valid model id."));
            }
        }
        if let Some(days) = patch.oanda_import_days {
            if !(1..=OANDA_MAX_DAYS).contains(&days) {
                return Err(NetError::invalid("Choose between 1 and 3650 days."));
            }
            self.oanda_import_days = days;
        }
        let dojix = brand_id == "dojix";
        if let Some(source) = patch.live_source {
            if !dojix && source != LiveSource::Off {
                return Err(NetError::unsupported());
            }
            self.live_source = source;
        }
        if let Some(enabled) = patch.finnhub_enabled {
            if dojix && enabled {
                return Err(NetError::unsupported());
            }
            self.finnhub_enabled = enabled;
        }
        if let Some(live) = patch.oanda_live {
            self.oanda_live = live;
        }
        if let Some(on) = patch.ai_enabled {
            self.ai_enabled = on;
        }
        Ok(())
    }
}

pub fn load(conn: &Connection) -> rusqlite::Result<OnlineSettings> {
    let text: Option<String> = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            [KEY],
            |row| row.get(0),
        )
        .optional()?;
    Ok(text
        .and_then(|t| serde_json::from_str::<OnlineSettings>(&t).ok())
        .unwrap_or_default()
        .sanitized())
}

pub fn save(tx: &Transaction<'_>, settings: &OnlineSettings) -> rusqlite::Result<()> {
    let json = serde_json::to_string(settings)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    tx.execute(
        "INSERT INTO settings (key, value_json) VALUES (?1, ?2) \
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
        rusqlite::params![KEY, json],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        crate::journal::migrations().to_latest(&mut c).unwrap();
        c
    }

    #[test]
    fn everything_is_off_by_default() {
        let c = conn();
        let s = load(&c).unwrap();
        assert_eq!(s, OnlineSettings::default());
        assert!(!s.ai_enabled && !s.finnhub_enabled && s.ai_consented_at.is_none());
        assert_eq!(s.live_source, LiveSource::Off);
        assert_eq!(s.oanda_import_days, 90);
    }

    #[test]
    fn round_trip_through_the_settings_table() {
        let mut c = conn();
        let mut s = OnlineSettings::default();
        s.apply(
            &OnlineSettingsPatch {
                ai_enabled: Some(true),
                ai_model: Some("claude-sonnet-5-5".into()),
                live_source: Some(LiveSource::OandaStream),
                oanda_live: Some(true),
                oanda_import_days: Some(30),
                ..Default::default()
            },
            "dojix",
        )
        .unwrap();
        let tx = c.transaction().unwrap();
        save(&tx, &s).unwrap();
        save(&tx, &s).unwrap();
        tx.commit().unwrap();
        assert_eq!(load(&c).unwrap(), s);
        let mut reset = s.clone();
        reset
            .apply(
                &OnlineSettingsPatch {
                    ai_model: Some(" ".into()),
                    ..Default::default()
                },
                "dojix",
            )
            .unwrap();
        assert_eq!(reset.ai_model, None);
    }

    #[test]
    fn invalid_patches_are_refused() {
        let mut s = OnlineSettings::default();
        let bad_model = OnlineSettingsPatch {
            ai_model: Some("Claude Opus!".into()),
            ..Default::default()
        };
        assert_eq!(s.apply(&bad_model, "dojix").unwrap_err().code, "invalid");
        let bad_days = OnlineSettingsPatch {
            oanda_import_days: Some(0),
            ..Default::default()
        };
        assert_eq!(s.apply(&bad_days, "dojix").unwrap_err().code, "invalid");
        let fx_on_stocks = OnlineSettingsPatch {
            live_source: Some(LiveSource::PolygonWs),
            ..Default::default()
        };
        assert_eq!(
            s.apply(&fx_on_stocks, "greenwick").unwrap_err().code,
            "unsupported"
        );
        let finnhub_on_fx = OnlineSettingsPatch {
            finnhub_enabled: Some(true),
            ..Default::default()
        };
        assert_eq!(
            s.apply(&finnhub_on_fx, "dojix").unwrap_err().code,
            "unsupported"
        );
        assert_eq!(s, OnlineSettings::default());
        assert!(serde_json::from_str::<OnlineSettingsPatch>(r#"{"apiKey":"x"}"#).is_err());
    }

    #[test]
    fn a_damaged_row_falls_back_to_safe_values() {
        let c = conn();
        c.execute(
            "INSERT INTO settings (key, value_json) VALUES ('online', ?1)",
            [r#"{"aiEnabled":true,"aiModel":"BAD MODEL","oandaImportDays":99999}"#],
        )
        .unwrap();
        let s = load(&c).unwrap();
        assert!(s.ai_enabled);
        assert_eq!((s.ai_model, s.oanda_import_days), (None, 90));
        c.execute("UPDATE settings SET value_json = 'not json'", [])
            .unwrap();
        assert_eq!(load(&c).unwrap(), OnlineSettings::default());
        c.execute(
            "UPDATE settings SET value_json = '{\"liveSource\":\"carrier_pigeon\",\"aiEnabled\":true}'",
            [],
        )
        .unwrap();
        assert_eq!(load(&c).unwrap(), OnlineSettings::default());
    }

    #[test]
    fn model_ids() {
        for ok in ["claude-opus-5-5", "claude-sonnet-5-5", "a", "claude-3.5"] {
            assert!(valid_model_id(ok), "{ok}");
        }
        let long = "a".repeat(65);
        for bad in ["", "-x", "Claude", "a b", "a/b", long.as_str()] {
            assert!(!valid_model_id(bad), "{bad}");
        }
        assert_eq!(LiveSource::Mt5File.label(), "MT5 Direct (File)");
    }
}
