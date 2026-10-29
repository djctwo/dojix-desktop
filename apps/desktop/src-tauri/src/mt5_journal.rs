//! The MT5 feature's journal side (Dojix only): its settings row, the `watched_files` ledger
//! and the commit of an auto-imported file (SPEC 5.1 step 9, 5.4). This writes only to the
//! journal; MT5's own folders are read-only and handled in `mt5/`.
//!
//! A commit takes the rows `packages/importers` produced in the web view, so it treats them as
//! untrusted: every row passes the same storage checks as a restore (`restore::check_trade`),
//! and only the three MT5 sources are accepted.

use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::brand::DOJIX;
use crate::journal::{Journal, StoreError};
use crate::mt5::watch::{LedgerEntry, PendingFile};
use crate::mt5::{Config, ImportSummary};
use crate::restore::{self, Row};

/// The settings key holding [`Config`].
pub const SETTINGS_KEY: &str = "mt5";

/// Formats an auto-import may produce.
pub const MT5_FORMATS: &[&str] = &["mt5_32col", "dojix_export", "mt5_report"];

/// Most trades one file may commit (a 50 MB file holds far fewer).
const MAX_TRADES: usize = 1_000_000;
/// Most row issues kept with a batch.
const MAX_ISSUES: usize = 500;

/// Reads the feature's settings (defaults when absent or unreadable).
pub fn read_config(conn: &Connection) -> rusqlite::Result<Config> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            [SETTINGS_KEY],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw
        .and_then(|text| serde_json::from_str::<Config>(&text).ok())
        .unwrap_or_default()
        .sanitized())
}

/// Saves the feature's settings (inside the caller's transaction).
pub fn write_config(tx: &rusqlite::Transaction<'_>, config: &Config) -> rusqlite::Result<()> {
    let text = serde_json::to_string(config)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    tx.execute(
        "INSERT INTO settings (key, value_json) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        params![SETTINGS_KEY, text],
    )?;
    Ok(())
}

/// The ledger of handled files.
pub fn read_ledger(conn: &Connection) -> rusqlite::Result<HashMap<PathBuf, LedgerEntry>> {
    let mut stmt =
        conn.prepare("SELECT path, size, mtime, sha256, last_result FROM watched_files")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (path, size, mtime, sha256, result) = row?;
        let (Ok(size), Ok(mtime_ns)) = (u64::try_from(size), mtime.parse::<u128>()) else {
            continue;
        };
        out.insert(
            PathBuf::from(path),
            LedgerEntry {
                size,
                mtime_ns,
                sha256,
                result,
            },
        );
    }
    Ok(out)
}

fn upsert_ledger(
    tx: &rusqlite::Transaction<'_>,
    file: &PendingFile,
    result: &str,
    now: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO watched_files (path, size, mtime, sha256, last_seen, last_result) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, \
         sha256 = excluded.sha256, last_seen = excluded.last_seen, \
         last_result = excluded.last_result",
        params![
            file.path.to_string_lossy().into_owned(),
            i64::try_from(file.size).unwrap_or(i64::MAX),
            file.mtime_ns.to_string(),
            file.sha256,
            now,
            result
        ],
    )?;
    Ok(())
}

/// One row as `packages/importers` returns it (`ImportedTrade`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeIn {
    pub ticket: String,
    pub source: String,
    pub external_id: Option<String>,
    pub is_sample: bool,
    pub symbol: String,
    pub direction: String,
    pub quantity: f64,
    pub open_time: String,
    pub close_time: String,
    pub time_basis: String,
    pub duration_min: i64,
    pub open_price: String,
    pub close_price: String,
    pub sl: String,
    pub tp: String,
    pub net_profit: String,
    pub commission: String,
    pub swap: String,
    pub mae: Option<f64>,
    pub mfe: Option<f64>,
    pub r_multiple: Option<f64>,
    pub session: String,
    pub day_of_week: String,
    pub hour: i64,
    pub time_to_mfe_min: Option<i64>,
    pub sl_dist: Option<f64>,
    pub slippage: Option<f64>,
    pub range_size: Option<f64>,
    pub hit_breakeven: Option<bool>,
    pub scaled_in: Option<bool>,
    pub sweep_depth: Option<f64>,
    pub used_fvg: Option<bool>,
    pub vol_regime: Option<String>,
    pub magic: Option<i64>,
    pub post_close_15m: Option<f64>,
    pub post_close_30m: Option<f64>,
    pub bias_at_entry: Option<String>,
    pub sector: Option<String>,
    pub industry: Option<String>,
    pub volume: Option<i64>,
    pub avg_volume: Option<i64>,
    pub comment: String,
    pub notes: String,
    pub tags: String,
    pub emotion: Option<String>,
    pub checklist: String,
    pub imported_at: String,
}

/// A row issue (`RowIssue`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IssueIn {
    pub line: Option<u64>,
    pub code: String,
    pub reason: String,
}

/// What the web view made of a queued file.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Outcome {
    /// A trade file: the importer's rows and issues.
    Trades {
        format: String,
        trades: Vec<TradeIn>,
        parsed: u64,
        duplicates_in_file: u64,
        issues: Vec<IssueIn>,
    },
    /// A file in another format (or one that needs a column mapping): never imported.
    NotTradeFile { format: String },
    /// The importer refused the whole file (empty, no trade section, too large …).
    Error { code: String, message: String },
}

/// Columns a committed row fills, in order.
const COLUMNS: &[&str] = &[
    "ticket",
    "source",
    "external_id",
    "is_sample",
    "account_id",
    "import_batch_id",
    "symbol",
    "direction",
    "quantity",
    "open_time",
    "close_time",
    "time_basis",
    "duration_min",
    "open_price",
    "close_price",
    "sl",
    "tp",
    "net_profit",
    "commission",
    "swap",
    "mae",
    "mfe",
    "r_multiple",
    "session",
    "day_of_week",
    "hour",
    "time_to_mfe_min",
    "sl_dist",
    "slippage",
    "range_size",
    "hit_breakeven",
    "scaled_in",
    "sweep_depth",
    "used_fvg",
    "vol_regime",
    "magic",
    "post_close_15m",
    "post_close_30m",
    "bias_at_entry",
    "sector",
    "industry",
    "volume",
    "avg_volume",
    "comment",
    "notes",
    "tags",
    "emotion",
    "checklist",
    "imported_at",
    "updated_at",
];

fn text(s: &str) -> Value {
    Value::Text(s.to_string())
}

fn opt_text(s: &Option<String>) -> Value {
    s.as_ref().map_or(Value::Null, |t| Value::Text(t.clone()))
}

fn opt_real(v: Option<f64>) -> Value {
    v.map_or(Value::Null, Value::Real)
}

fn opt_int(v: Option<i64>) -> Value {
    v.map_or(Value::Null, Value::Integer)
}

fn opt_bool(v: Option<bool>) -> Value {
    v.map_or(Value::Null, |b| Value::Integer(i64::from(b)))
}

/// The journal row for `t`, or `None` when the ticket is not a positive 64-bit integer.
fn row_of(t: &TradeIn, now: &str) -> Option<Row> {
    let ticket = t.ticket.parse::<i64>().ok().filter(|v| *v > 0)?;
    let mut row = Row::new();
    let mut put = |k: &str, v: Value| {
        row.insert(k.to_string(), v);
    };
    put("ticket", Value::Integer(ticket));
    put("source", text(&t.source));
    put("external_id", opt_text(&t.external_id));
    put("is_sample", Value::Integer(i64::from(t.is_sample)));
    put("account_id", Value::Integer(1));
    put("symbol", text(&t.symbol));
    put("direction", text(&t.direction));
    put("quantity", Value::Real(t.quantity));
    put("open_time", text(&t.open_time));
    put("close_time", text(&t.close_time));
    put("time_basis", text(&t.time_basis));
    put("duration_min", Value::Integer(t.duration_min));
    put("open_price", text(&t.open_price));
    put("close_price", text(&t.close_price));
    put("sl", text(&t.sl));
    put("tp", text(&t.tp));
    put("net_profit", text(&t.net_profit));
    put("commission", text(&t.commission));
    put("swap", text(&t.swap));
    put("mae", opt_real(t.mae));
    put("mfe", opt_real(t.mfe));
    put("r_multiple", opt_real(t.r_multiple));
    put("session", text(&t.session));
    put("day_of_week", text(&t.day_of_week));
    put("hour", Value::Integer(t.hour));
    put("time_to_mfe_min", opt_int(t.time_to_mfe_min));
    put("sl_dist", opt_real(t.sl_dist));
    put("slippage", opt_real(t.slippage));
    put("range_size", opt_real(t.range_size));
    put("hit_breakeven", opt_bool(t.hit_breakeven));
    put("scaled_in", opt_bool(t.scaled_in));
    put("sweep_depth", opt_real(t.sweep_depth));
    put("used_fvg", opt_bool(t.used_fvg));
    put("vol_regime", opt_text(&t.vol_regime));
    put("magic", opt_int(t.magic));
    put("post_close_15m", opt_real(t.post_close_15m));
    put("post_close_30m", opt_real(t.post_close_30m));
    put("bias_at_entry", opt_text(&t.bias_at_entry));
    put("sector", opt_text(&t.sector));
    put("industry", opt_text(&t.industry));
    put("volume", opt_int(t.volume));
    put("avg_volume", opt_int(t.avg_volume));
    put("comment", text(&t.comment));
    put("notes", text(&t.notes));
    put("tags", text(&t.tags));
    put("emotion", opt_text(&t.emotion));
    put("checklist", text(&t.checklist));
    put("imported_at", text(&t.imported_at));
    put("updated_at", text(now));
    Some(row)
}

fn cap_text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// A checked outcome, ready to commit.
#[derive(Debug, Clone)]
pub enum Prepared {
    NotTradeFile {
        format: String,
    },
    Failed {
        message: String,
    },
    Trades {
        format: String,
        rows: Vec<Row>,
        parsed: u64,
        /// In-file duplicates (counted as duplicates, like the Mac).
        duplicates_in_file: u64,
        /// Rows the importer skipped plus rows refused here.
        skipped: u64,
        issues_json: String,
    },
}

/// Why an outcome was refused before anything was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

/// Checks what the web view made of a queued file. Nothing is written. Rows outside the
/// storage limits are refused one by one (and reported as issues); a wrong format or an
/// oversized payload refuses the whole outcome.
pub fn prepare(outcome: Outcome) -> Result<Prepared, Refused> {
    let now = restore::timestamp_now();
    match outcome {
        Outcome::NotTradeFile { format } => Ok(Prepared::NotTradeFile {
            format: cap_text(&format, 40),
        }),
        Outcome::Error { code, message } => Ok(Prepared::Failed {
            message: format!("{} ({})", cap_text(&message, 200), cap_text(&code, 40)),
        }),
        Outcome::Trades {
            format,
            trades,
            parsed,
            duplicates_in_file,
            mut issues,
        } => {
            if !MT5_FORMATS.contains(&format.as_str()) {
                return Err(Refused("An MT5 auto-import must be an MT5 trade file.".into()));
            }
            if trades.len() > MAX_TRADES {
                return Err(Refused("Too many trades in one file.".into()));
            }
            let mut rows: Vec<Row> = Vec::with_capacity(trades.len());
            let mut rejected = 0u64;
            for t in &trades {
                let bad = match row_of(t, &now) {
                    None => vec!["ticket".to_string()],
                    Some(mut row) => {
                        let mut bad = restore::check_trade(&DOJIX, &mut row);
                        if !MT5_FORMATS.contains(&t.source.as_str()) {
                            bad.push("source".into());
                        }
                        if bad.is_empty() {
                            rows.push(row);
                        }
                        bad
                    }
                };
                if !bad.is_empty() {
                    rejected += 1;
                    issues.push(IssueIn {
                        line: None,
                        code: "storage_rejected".into(),
                        reason: format!(
                            "Ticket {}: values outside what Dojix stores: {}",
                            cap_text(&t.ticket, 24),
                            bad.join(", ")
                        ),
                    });
                }
            }
            // Rows the importer skipped (the end-of-section marker is not a skipped row).
            let skipped_by_importer = issues
                .iter()
                .filter(|i| {
                    !matches!(
                        i.code.as_str(),
                        "section_end" | "duplicate_in_file" | "storage_rejected"
                    )
                })
                .count() as u64;
            issues.truncate(MAX_ISSUES);
            for i in &mut issues {
                i.code = cap_text(&i.code, 40);
                i.reason = cap_text(&i.reason, 300);
            }
            Ok(Prepared::Trades {
                format,
                rows,
                parsed,
                duplicates_in_file,
                skipped: skipped_by_importer + rejected,
                issues_json: serde_json::to_string(&issues).unwrap_or_else(|_| "[]".into()),
            })
        }
    }
}

/// Commits a prepared outcome in one transaction and one save: the trades (existing tickets
/// skipped), the `import_batches` row (origin `mt5_watch`) and the file's ledger row. A file
/// that isn't a trade file, or that the importer refused, records only its ledger row, so it
/// isn't read again until it changes.
pub fn apply(
    journal: &mut Journal,
    file: &PendingFile,
    prepared: Prepared,
    now_ms: i64,
) -> Result<ImportSummary, StoreError> {
    let now = restore::timestamp_now();
    let mut summary = ImportSummary {
        file_name: file.file_name.clone(),
        folder_id: file.folder_id.clone(),
        format: None,
        result: String::new(),
        message: None,
        parsed: 0,
        inserted: 0,
        duplicates: 0,
        skipped: 0,
        at_ms: now_ms,
    };
    match prepared {
        Prepared::NotTradeFile { format } => {
            journal.write(|tx| upsert_ledger(tx, file, "not_trade_file", &now))?;
            summary.format = Some(format);
            summary.result = "not_trade_file".into();
            summary.message = Some("Not a trade file; nothing was imported.".into());
        }
        Prepared::Failed { message } => {
            journal.write(|tx| upsert_ledger(tx, file, "failed", &now))?;
            summary.result = "failed".into();
            summary.message = Some(message);
        }
        Prepared::Trades {
            format,
            rows,
            parsed,
            duplicates_in_file,
            skipped,
            issues_json,
        } => {
            let file_name = cap_text(&file.file_name, 200);
            let (inserted, existing) = journal.write(|tx| {
                tx.execute(
                    "INSERT INTO import_batches (source, origin, file_name, file_sha256, \
                     started_at, parsed) VALUES (?1, 'mt5_watch', ?2, ?3, ?4, ?5)",
                    params![
                        format,
                        file_name,
                        file.sha256,
                        now,
                        i64::try_from(parsed).unwrap_or(i64::MAX)
                    ],
                )?;
                let batch = tx.last_insert_rowid();
                let sql = format!(
                    "INSERT INTO trades ({}) VALUES ({}) ON CONFLICT(ticket) DO NOTHING",
                    COLUMNS.join(", "),
                    std::iter::repeat_n("?", COLUMNS.len())
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                let mut stmt = tx.prepare(&sql)?;
                let (mut inserted, mut existing) = (0u64, 0u64);
                for row in &rows {
                    let values: Vec<Value> = COLUMNS
                        .iter()
                        .map(|c| {
                            if *c == "import_batch_id" {
                                Value::Integer(batch)
                            } else {
                                row.get(*c).cloned().unwrap_or(Value::Null)
                            }
                        })
                        .collect();
                    if stmt.execute(rusqlite::params_from_iter(values))? == 1 {
                        inserted += 1;
                    } else {
                        existing += 1;
                    }
                }
                tx.execute(
                    "UPDATE import_batches SET inserted = ?1, duplicates = ?2, skipped = ?3, \
                     issues_json = ?4 WHERE id = ?5",
                    params![
                        i64::try_from(inserted).unwrap_or(i64::MAX),
                        i64::try_from(existing + duplicates_in_file).unwrap_or(i64::MAX),
                        i64::try_from(skipped).unwrap_or(i64::MAX),
                        issues_json,
                        batch
                    ],
                )?;
                upsert_ledger(tx, file, "imported", &now)?;
                Ok((inserted, existing))
            })?;
            summary.format = Some(format);
            summary.result = "imported".into();
            summary.parsed = parsed;
            summary.inserted = inserted;
            summary.duplicates = existing + duplicates_in_file;
            summary.skipped = skipped;
        }
    }
    Ok(summary)
}

/// [`prepare`] then [`apply`].
pub fn commit(
    journal: &mut Journal,
    file: &PendingFile,
    outcome: Outcome,
    now_ms: i64,
) -> Result<ImportSummary, StoreError> {
    let prepared = prepare(outcome).map_err(|r| StoreError::Invalid(r.0))?;
    apply(journal, file, prepared, now_ms)
}
