//! Validated restore (SPEC 4.3, 4.4, 6.8). A backup is a whole SQLite database chosen by the
//! user, so it is treated as hostile and never copied page for page:
//!
//! 1. It is opened read-only in a private in-memory connection.
//! 2. Its schema is identified: this app's (must equal a known migration level exactly), or a
//!    Mac Dojix / Mac Greenwick backup (migration history checked, no unknown tables or
//!    columns). Triggers, views and generated columns are refused.
//! 3. Every value is read with its SQLite type checked, every trade row passes the brand's
//!    storage limits (the reject form, `storageViolations`), and the restore is refused if any
//!    row fails, naming the table, the row and the fields.
//! 4. Only then are the validated values written into the journal's own tables, in one
//!    transaction (`Journal::replace_with`), and saved.
//!
//! Mac rows keep their tickets, so a later re-import of the same broker file dedupes.

use std::collections::{BTreeMap, HashSet};

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, MAIN_DB};
use serde::Serialize;

use crate::brand::Brand;
use crate::journal::{self, Journal, StoreError, SCHEMA_VERSION};
use crate::seal::SQLITE_MAGIC;

/// Most trades a backup may hold (the Mac limit).
pub const MAX_TRADES: i64 = 2_000_000;
/// Largest image accepted (the Mac limit).
pub const MAX_IMAGE_BYTES: usize = 512 * 1024 * 1024;

const SAMPLE_COMMENT: &str = "Sample (fictional)";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RestoreError {
    #[error("The selected file is not a valid backup.")]
    NotABackup,
    #[error("The backup file is damaged. Your journal was not changed.")]
    Damaged,
    #[error("The backup is larger than 512 MB or holds more than 2,000,000 trades, so it was not restored.")]
    TooLarge,
    #[error("This backup was made by a newer version. Update the app, then restore it.")]
    NewerVersion,
    #[error("This is a {0} backup. Restore it in {0}.")]
    OtherBrand(&'static str),
    #[error("The backup contains something a backup never has ({0}), so it was not restored.")]
    UnexpectedSchema(String),
    #[error("The backup was not restored: row {row} of {table} has values outside what the app accepts ({fields}).")]
    InvalidRow {
        table: String,
        row: usize,
        fields: String,
    },
    #[error("The restore could not be saved, so your journal was left as it was.")]
    Store,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Desktop,
    MacDojix,
    MacGreenwick,
}

/// Validated rows of one table, ready to insert.
#[derive(Debug, Clone)]
struct TableRows {
    table: &'static str,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

/// The validated content of a backup.
#[derive(Debug)]
pub struct Contents {
    pub source: Source,
    tables: Vec<TableRows>,
    pub trades: usize,
    pub checkpoints: usize,
    pub settings: usize,
    pub dropped_screenshot_names: usize,
}

/// What the user is told after a restore.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub source: Source,
    pub trades: usize,
    pub checkpoints: usize,
    pub settings: usize,
    pub notices: Vec<String>,
}

/// Desktop tables in insert order (parents first).
const DESKTOP_TABLES: &[&str] = &[
    "accounts",
    "import_batches",
    "trades",
    "trade_screenshots",
    "strategy_checkpoints",
    "checklist_rules",
    "watchlist",
    "mapping_presets",
    "watched_files",
    "ai_reports",
    "settings",
];

// ---------------------------------------------------------------------------------------------
// Opening and schema
// ---------------------------------------------------------------------------------------------

fn open_backup(image: &[u8]) -> Result<Connection, RestoreError> {
    if image.len() > MAX_IMAGE_BYTES {
        return Err(RestoreError::TooLarge);
    }
    if image.len() < 100 || &image[..SQLITE_MAGIC.len()] != SQLITE_MAGIC {
        return Err(RestoreError::NotABackup);
    }
    let mut conn = Connection::open_in_memory().map_err(|_| RestoreError::Damaged)?;
    conn.deserialize_read_exact(MAIN_DB, image, image.len(), true)
        .map_err(|_| RestoreError::NotABackup)?;
    // Defence in depth: no functions from the backup's schema run while it is read.
    let _ = conn.pragma_update(None, "trusted_schema", "OFF");
    let ok: Vec<String> = query_strings(&conn, "PRAGMA quick_check").map_err(|_| RestoreError::Damaged)?;
    if ok != ["ok"] {
        return Err(RestoreError::Damaged);
    }
    Ok(conn)
}

fn query_strings(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| match r.get_ref(0)? {
        ValueRef::Text(t) => Ok(String::from_utf8_lossy(t).into_owned()),
        other => Ok(format!("{other:?}")),
    })?;
    rows.collect()
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, RestoreError> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(|_| RestoreError::Damaged)
}

fn describe_value(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Null => "null".to_string(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(t) => format!("'{}'", String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => format!("blob({})", b.len()),
    }
}

/// One column of a table: name, declared type, NOT NULL, hidden (generated).
#[derive(Debug, Clone)]
struct Column {
    name: String,
    decl: String,
    not_null: bool,
    hidden: bool,
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<Column>, RestoreError> {
    let sql = format!("PRAGMA table_xinfo({})", quoted(table));
    let mut stmt = conn.prepare(&sql).map_err(|_| RestoreError::Damaged)?;
    let rows = stmt
        .query_map([], |r| {
            let text = |i: usize| -> rusqlite::Result<String> {
                Ok(match r.get_ref(i)? {
                    ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                    _ => String::new(),
                })
            };
            Ok(Column {
                name: text(1)?,
                decl: text(2)?.to_ascii_uppercase(),
                not_null: r.get::<_, i64>(3)? != 0,
                hidden: r.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|_| RestoreError::Damaged)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| RestoreError::Damaged)
}

/// "type name" → structure signature of every schema object (Greenwick's `BackupValidator`
/// approach): columns with type, NOT NULL, default, primary key and hidden flag; index
/// columns and uniqueness. Compared by structure, not SQL text.
fn schema_of(conn: &Connection) -> Result<BTreeMap<String, String>, RestoreError> {
    let damaged = |_| RestoreError::Damaged;
    let mut objects = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT type, name, tbl_name FROM sqlite_master")
            .map_err(damaged)?;
        let rows = stmt
            .query_map([], |r| {
                let t = |i: usize| -> rusqlite::Result<String> {
                    Ok(match r.get_ref(i)? {
                        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                        _ => "?".to_string(),
                    })
                };
                Ok((t(0)?, t(1)?, t(2)?))
            })
            .map_err(damaged)?;
        for row in rows {
            objects.push(row.map_err(damaged)?);
        }
    }
    let mut out = BTreeMap::new();
    for (kind, name, table) in objects {
        let signature = match kind.as_str() {
            "table" => pragma_rows(
                conn,
                &format!("PRAGMA table_xinfo({})", quoted(&name)),
                &[1, 2, 3, 4, 5, 6],
            )?,
            "index" => {
                let cols = pragma_rows(
                    conn,
                    &format!("PRAGMA index_xinfo({})", quoted(&name)),
                    &[0, 2, 3, 4, 5],
                )?;
                let list = pragma_rows(
                    conn,
                    &format!("PRAGMA index_list({})", quoted(&table)),
                    &[1, 2],
                )?;
                let unique = list
                    .split("; ")
                    .find_map(|entry| {
                        entry
                            .strip_prefix(&format!("'{name}' "))
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "?".to_string());
                format!("on {table} unique {unique}: {cols}")
            }
            other => other.to_string(),
        };
        out.insert(format!("{kind} {name}"), signature);
    }
    Ok(out)
}

fn pragma_rows(conn: &Connection, sql: &str, fields: &[usize]) -> Result<String, RestoreError> {
    let mut stmt = conn.prepare(sql).map_err(|_| RestoreError::Damaged)?;
    let mut rows = stmt.query([]).map_err(|_| RestoreError::Damaged)?;
    let mut parts = Vec::new();
    while let Some(row) = rows.next().map_err(|_| RestoreError::Damaged)? {
        let mut cells = Vec::new();
        for &i in fields {
            cells.push(describe_value(row.get_ref(i).map_err(|_| RestoreError::Damaged)?));
        }
        parts.push(cells.join(" "));
    }
    Ok(parts.join("; "))
}

/// The schema this build's migrations create, up to `version`.
fn reference_schema(version: usize) -> Result<BTreeMap<String, String>, RestoreError> {
    let mut conn = Connection::open_in_memory().map_err(|_| RestoreError::Damaged)?;
    journal::migrations()
        .to_version(&mut conn, version)
        .map_err(|_| RestoreError::Damaged)?;
    schema_of(&conn)
}

fn check_schema(
    actual: &BTreeMap<String, String>,
    reference: &BTreeMap<String, String>,
) -> Result<(), RestoreError> {
    for (object, signature) in actual {
        match reference.get(object) {
            None => return Err(RestoreError::UnexpectedSchema(object.clone())),
            Some(expected) if expected != signature => {
                return Err(RestoreError::UnexpectedSchema(format!("{object} definition")))
            }
            Some(_) => {}
        }
    }
    for object in reference.keys() {
        if !actual.contains_key(object) {
            return Err(RestoreError::UnexpectedSchema(format!("missing {object}")));
        }
    }
    Ok(())
}

fn refuse_triggers_and_views(conn: &Connection) -> Result<(), RestoreError> {
    let found = query_strings(
        conn,
        "SELECT type || ' ' || name FROM sqlite_master WHERE type IN ('trigger', 'view')",
    )
    .map_err(|_| RestoreError::Damaged)?;
    match found.into_iter().next() {
        Some(object) => Err(RestoreError::UnexpectedSchema(object)),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/// Reads one cell as an owned value; text must be valid UTF-8, and blobs are never accepted.
fn owned(v: ValueRef<'_>) -> Result<Value, &'static str> {
    Ok(match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Integer(i),
        ValueRef::Real(f) => Value::Real(f),
        ValueRef::Text(t) => Value::Text(
            std::str::from_utf8(t)
                .map_err(|_| "text")?
                .to_string(),
        ),
        ValueRef::Blob(_) => return Err("blob"),
    })
}

/// Checks a value against a desktop column's declared type and NOT NULL.
fn typed(value: Value, column: &Column) -> Result<Value, ()> {
    match (value, column.decl.as_str()) {
        (Value::Null, _) if !column.not_null => Ok(Value::Null),
        (Value::Integer(i), "INTEGER") => Ok(Value::Integer(i)),
        (Value::Real(f), "REAL") if f.is_finite() => Ok(Value::Real(f)),
        (Value::Integer(i), "REAL") => Ok(Value::Real(i as f64)),
        (Value::Text(t), "TEXT") => Ok(Value::Text(t)),
        _ => Err(()),
    }
}

fn is_disallowed_control(c: char, allow_line_breaks: bool) -> bool {
    if allow_line_breaks && (c == '\n' || c == '\t') {
        return false;
    }
    c.is_control() || c == '\u{2028}' || c == '\u{2029}'
}

fn has_controls(text: &str, allow_line_breaks: bool) -> bool {
    text.chars().any(|c| is_disallowed_control(c, allow_line_breaks))
}

fn strip_controls(text: &str, keep_line_breaks: bool) -> String {
    text.chars()
        .filter(|&c| !is_disallowed_control(c, keep_line_breaks))
        .collect()
}

/// `YYYY-MM-DD HH:MM:SS` with optional `.SSS`, between 1900-01-01 and 2200-01-01.
pub fn valid_datetime(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 19 && b.len() != 23 {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let num = |r: std::ops::Range<usize>| s[r].parse::<u32>().unwrap_or(99);
    let shape = digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b' '
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19)
        && (b.len() == 19 || (b[19] == b'.' && digits(20..23)));
    shape
        && (1..=12).contains(&num(5..7))
        && (1..=31).contains(&num(8..10))
        && num(11..13) <= 23
        && num(14..16) <= 59
        && num(17..19) <= 59
        && ("1900-01-01 00:00:00"..="2200-01-01 00:00:00").contains(&&s[..19])
}

fn valid_date_or_datetime(s: &str) -> bool {
    valid_datetime(s) || (s.len() == 10 && valid_datetime(&format!("{s} 00:00:00")))
}

/// Decimal text as Swift's `Decimal.description` writes it, |x| ≤ 1e12.
pub fn valid_money(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    let (int, frac) = body.split_once('.').unwrap_or((body, "0"));
    s.len() <= 64
        && !int.is_empty()
        && !frac.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.bytes().all(|b| b.is_ascii_digit())
        && s.parse::<f64>().is_ok_and(|v| v.is_finite() && v.abs() <= 1e12)
}

// ---------------------------------------------------------------------------------------------
// Trade rules (SPEC 4.3)
// ---------------------------------------------------------------------------------------------

/// One row as column → value.
type Row = BTreeMap<String, Value>;

const LABEL_MAX: usize = 200;
const TEXT_MAX: usize = 100_000;
const POINTS_MAX: f64 = 1e9;
const SOURCES: &[&str] = &[
    "mt5_32col",
    "dojix_export",
    "mt5_report",
    "mt4",
    "ctrader",
    "tradingview",
    "oanda_csv",
    "oanda_api",
    "ibkr",
    "tos",
    "ninjatrader",
    "webull",
    "robinhood",
    "schwab",
    "fidelity",
    "etrade",
    "tastytrade",
    "generic",
    "manual",
    "sample",
    "mac_backup",
];
const DAYS: &[&str] = &["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

fn text<'a>(row: &'a Row, col: &str) -> Option<&'a str> {
    match row.get(col) {
        Some(Value::Text(t)) => Some(t.as_str()),
        _ => None,
    }
}

fn int(row: &Row, col: &str) -> Option<i64> {
    match row.get(col) {
        Some(Value::Integer(i)) => Some(*i),
        _ => None,
    }
}

fn real(row: &Row, col: &str) -> Option<f64> {
    match row.get(col) {
        Some(Value::Real(f)) => Some(*f),
        Some(Value::Integer(i)) => Some(*i as f64),
        _ => None,
    }
}

fn is_null(row: &Row, col: &str) -> bool {
    matches!(row.get(col), None | Some(Value::Null))
}

/// Checks (and for Dojix, cleans) one trade. Returns the names of the fields outside the
/// brand's limits: Dojix `Trade+Sanitize` limits in reject form, Greenwick `TradeLimits`.
fn check_trade(brand: &Brand, row: &mut Row) -> Vec<String> {
    let dojix = brand.id == "dojix";
    let mut bad: Vec<String> = Vec::new();
    let mut flag = |name: &str| bad.push(name.to_string());

    if !int(row, "ticket").is_some_and(|t| t > 0) {
        flag("ticket");
    }
    if !text(row, "source").is_some_and(|s| SOURCES.contains(&s)) {
        flag("source");
    }
    match text(row, "symbol") {
        Some(s) if !s.is_empty() && s.chars().count() <= 32 && !has_controls(s, false) => {}
        _ => flag("symbol"),
    }
    if !matches!(text(row, "direction"), Some("BUY" | "SELL")) {
        flag("direction");
    }
    let qty = real(row, "quantity").unwrap_or(f64::NAN);
    let qty_ok = if dojix {
        qty.is_finite() && (qty == 0.0 || (1e-5..=1e6).contains(&qty))
    } else {
        qty.is_finite() && (1e-6..=1e9).contains(&qty)
    };
    if !qty_ok {
        flag("quantity");
    }
    for col in ["open_time", "close_time", "imported_at", "updated_at"] {
        if !text(row, col).is_some_and(valid_datetime) {
            flag(col);
        }
    }
    if !matches!(text(row, "time_basis"), Some("utc" | "broker")) {
        flag("time_basis");
    }
    let duration_max: i64 = if dojix { 10 * 366 * 24 * 60 } else { 20 * 366 * 24 * 60 };
    if !int(row, "duration_min").is_some_and(|d| (0..=duration_max).contains(&d)) {
        flag("duration_min");
    }
    if !(is_null(row, "time_to_mfe_min")
        || int(row, "time_to_mfe_min").is_some_and(|d| (0..=duration_max).contains(&d)))
    {
        flag("time_to_mfe_min");
    }
    for col in [
        "open_price",
        "close_price",
        "sl",
        "tp",
        "net_profit",
        "commission",
        "swap",
    ] {
        if !text(row, col).is_some_and(valid_money) {
            flag(col);
        }
    }
    for col in [
        "mae",
        "mfe",
        "r_multiple",
        "sl_dist",
        "slippage",
        "range_size",
        "sweep_depth",
        "post_close_15m",
        "post_close_30m",
    ] {
        if !(is_null(row, col) || real(row, col).is_some_and(|v| v.is_finite() && v.abs() <= POINTS_MAX)) {
            flag(col);
        }
    }
    if !int(row, "hour").is_some_and(|h| (0..=23).contains(&h)) {
        flag("hour");
    }
    match text(row, "day_of_week") {
        Some(d) if dojix && DAYS.contains(&d) => {}
        Some(d) if !dojix && d.chars().count() <= LABEL_MAX && !has_controls(d, false) => {}
        _ => flag("day_of_week"),
    }
    for col in ["is_sample", "hit_breakeven", "scaled_in", "used_fvg"] {
        let ok = if col == "is_sample" {
            int(row, col).is_some_and(|v| v == 0 || v == 1)
        } else {
            is_null(row, col) || int(row, col).is_some_and(|v| v == 0 || v == 1)
        };
        if !ok {
            flag(col);
        }
    }
    if !int(row, "account_id").is_some_and(|v| v >= 1) {
        flag("account_id");
    }
    for col in ["volume", "avg_volume"] {
        if !(is_null(row, col) || int(row, col).is_some_and(|v| (0..=1_000_000_000_000).contains(&v))) {
            flag(col);
        }
    }
    // Labels.
    for col in [
        "session",
        "vol_regime",
        "bias_at_entry",
        "sector",
        "industry",
        "emotion",
        "external_id",
    ] {
        if let Some(t) = text(row, col) {
            if t.chars().count() > LABEL_MAX || (!dojix && has_controls(t, false)) {
                flag(col);
            }
        } else if !is_null(row, col) {
            flag(col);
        }
    }
    // Free text: Dojix cleans it on restore (`sanitizedForRestore`); Greenwick refuses
    // control characters.
    let comment_max = if dojix { 256 } else { LABEL_MAX };
    match text(row, "comment") {
        Some(t) if dojix => {
            let cleaned: String = strip_controls(t, false)
                .trim()
                .chars()
                .take(comment_max)
                .collect();
            row.insert("comment".into(), Value::Text(cleaned));
        }
        Some(t) if t.chars().count() <= comment_max && !has_controls(t, false) => {}
        _ => bad.push("comment".to_string()),
    }
    match text(row, "notes") {
        Some(t) if t.chars().count() <= TEXT_MAX => {
            if dojix {
                let cleaned = strip_controls(t, true);
                row.insert("notes".into(), Value::Text(cleaned));
            } else if has_controls(t, true) {
                bad.push("notes".to_string());
            }
        }
        _ => bad.push("notes".to_string()),
    }
    match text(row, "tags").map(serde_json::from_str::<Vec<String>>) {
        Some(Ok(tags))
            if tags.len() <= 1_000
                && tags
                    .iter()
                    .all(|t| t.chars().count() <= LABEL_MAX && !has_controls(t, false)) => {}
        _ => bad.push("tags".to_string()),
    }
    match text(row, "checklist").map(serde_json::from_str::<serde_json::Value>) {
        Some(Ok(serde_json::Value::Object(_)))
            if text(row, "checklist").is_some_and(|t| t.len() <= TEXT_MAX) => {}
        _ => bad.push("checklist".to_string()),
    }
    bad.sort();
    bad.dedup();
    bad
}

/// Generic checks for the other desktop tables: text length and no NUL.
fn check_generic(row: &Row) -> Vec<String> {
    let mut bad = Vec::new();
    for (col, value) in row {
        if let Value::Text(t) = value {
            if t.chars().count() > TEXT_MAX || t.contains('\0') {
                bad.push(col.clone());
            }
        }
    }
    bad
}

fn invalid(table: &str, row: usize, fields: Vec<String>) -> RestoreError {
    RestoreError::InvalidRow {
        table: table.to_string(),
        row,
        fields: fields.join(", "),
    }
}

// ---------------------------------------------------------------------------------------------
// Desktop backups
// ---------------------------------------------------------------------------------------------

fn desktop_contents(conn: &Connection, brand: &Brand) -> Result<Contents, RestoreError> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| RestoreError::Damaged)?;
    let version = usize::try_from(version).map_err(|_| RestoreError::NotABackup)?;
    if version == 0 {
        return Err(RestoreError::NotABackup);
    }
    if version > SCHEMA_VERSION {
        return Err(RestoreError::NewerVersion);
    }
    check_schema(&schema_of(conn)?, &reference_schema(version)?)?;
    count_trades(conn)?;

    let current = {
        let mut conn = Connection::open_in_memory().map_err(|_| RestoreError::Damaged)?;
        journal::migrations()
            .to_latest(&mut conn)
            .map_err(|_| RestoreError::Damaged)?;
        conn
    };
    let mut tables = Vec::new();
    let (mut trades, mut checkpoints, mut settings) = (0, 0, 0);
    for &table in DESKTOP_TABLES {
        let target = columns(&current, table)?;
        let present: HashSet<String> = columns(conn, table)?.into_iter().map(|c| c.name).collect();
        let cols: Vec<Column> = target
            .into_iter()
            .filter(|c| present.contains(&c.name))
            .collect();
        let names: Vec<String> = cols.iter().map(|c| c.name.clone()).collect();
        let sql = format!(
            "SELECT {} FROM {} ORDER BY rowid",
            names.iter().map(|n| quoted(n)).collect::<Vec<_>>().join(", "),
            quoted(table)
        );
        let mut stmt = conn.prepare(&sql).map_err(|_| RestoreError::Damaged)?;
        let mut rows = stmt.query([]).map_err(|_| RestoreError::Damaged)?;
        let mut out = Vec::new();
        let mut index = 0usize;
        while let Some(r) = rows.next().map_err(|_| RestoreError::Damaged)? {
            index += 1;
            let mut row = Row::new();
            let mut bad = Vec::new();
            for (i, col) in cols.iter().enumerate() {
                let cell = r.get_ref(i).map_err(|_| RestoreError::Damaged)?;
                match owned(cell).ok().and_then(|v| typed(v, col).ok()) {
                    Some(v) => {
                        row.insert(col.name.clone(), v);
                    }
                    None => bad.push(col.name.clone()),
                }
            }
            if bad.is_empty() {
                bad = if table == "trades" {
                    check_trade(brand, &mut row)
                } else {
                    check_generic(&row)
                };
            }
            if !bad.is_empty() {
                return Err(invalid(table, index, bad));
            }
            out.push(names.iter().map(|n| row.remove(n).unwrap_or(Value::Null)).collect());
        }
        match table {
            "trades" => trades = out.len(),
            "strategy_checkpoints" => checkpoints = out.len(),
            "settings" => settings = out.len(),
            _ => {}
        }
        tables.push(TableRows {
            table,
            columns: names,
            rows: out,
        });
    }
    Ok(Contents {
        source: Source::Desktop,
        tables,
        trades,
        checkpoints,
        settings,
        dropped_screenshot_names: 0,
    })
}

fn count_trades(conn: &Connection) -> Result<(), RestoreError> {
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM trades", [], |r| r.get(0))
        .map_err(|_| RestoreError::Damaged)?;
    if n > MAX_TRADES {
        return Err(RestoreError::TooLarge);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Mac backups (SPEC 4.4)
// ---------------------------------------------------------------------------------------------

const MAC_DOJIX_MIGRATIONS: &[&str] = &[
    "v1_createTrades",
    "v2_addTradeNotes",
    "v3_addTradeTags",
    "v4_addEmotionCommissionScreenshotsChecklist",
    "v5_createStrategyCheckpoints",
    "v1_createSettings",
];
const MAC_GREENWICK_MIGRATIONS: &[&str] = &[
    "v1_createTrades",
    "v2_createStrategyCheckpoints",
    "v3_addPerformanceIndexes",
    "v4_createSettings",
    "v5_markSampleTrades",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Int,
    Real,
    Bool,
    Text,
    Date,
}

/// Mac Dojix `trades` columns → desktop column (None = dropped) and kind.
const MAC_DOJIX_TRADE: &[(&str, Option<&str>, Kind)] = &[
    ("id", Some("id"), Kind::Int),
    ("ticket", Some("ticket"), Kind::Int),
    ("symbol", Some("symbol"), Kind::Text),
    ("direction", Some("direction"), Kind::Text),
    ("lots", Some("quantity"), Kind::Real),
    ("openTime", Some("open_time"), Kind::Date),
    ("closeTime", Some("close_time"), Kind::Date),
    ("durationMin", Some("duration_min"), Kind::Int),
    ("openPrice", Some("open_price"), Kind::Text),
    ("closePrice", Some("close_price"), Kind::Text),
    ("sl", Some("sl"), Kind::Text),
    ("tp", Some("tp"), Kind::Text),
    ("netProfit", Some("net_profit"), Kind::Text),
    ("maePips", Some("mae"), Kind::Real),
    ("mfePips", Some("mfe"), Kind::Real),
    ("rMultiple", Some("r_multiple"), Kind::Real),
    ("session", Some("session"), Kind::Text),
    ("dayOfWeek", Some("day_of_week"), Kind::Text),
    ("hour", Some("hour"), Kind::Int),
    ("rangeSize", Some("range_size"), Kind::Real),
    ("sweepDepth", Some("sweep_depth"), Kind::Real),
    ("usedFVG", Some("used_fvg"), Kind::Bool),
    ("volRegime", Some("vol_regime"), Kind::Text),
    ("hitBreakeven", Some("hit_breakeven"), Kind::Bool),
    ("scaledIn", Some("scaled_in"), Kind::Bool),
    ("magic", Some("magic"), Kind::Int),
    ("comment", Some("comment"), Kind::Text),
    ("timeToMFEMin", Some("time_to_mfe_min"), Kind::Int),
    ("slDistPips", Some("sl_dist"), Kind::Real),
    ("slippagePips", Some("slippage"), Kind::Real),
    ("postClose15m", Some("post_close_15m"), Kind::Real),
    ("postClose30m", Some("post_close_30m"), Kind::Real),
    ("biasAtEntry", Some("bias_at_entry"), Kind::Text),
    ("importedAt", Some("imported_at"), Kind::Date),
    ("notes", Some("notes"), Kind::Text),
    ("tags", Some("tags"), Kind::Text),
    ("emotion", Some("emotion"), Kind::Text),
    ("commission", Some("commission"), Kind::Text),
    ("swap", Some("swap"), Kind::Text),
    ("screenshots", None, Kind::Text),
    ("checklistData", Some("checklist"), Kind::Text),
];

/// Mac Greenwick `trades` columns.
const MAC_GREENWICK_TRADE: &[(&str, Option<&str>, Kind)] = &[
    ("id", Some("id"), Kind::Int),
    ("ticket", Some("ticket"), Kind::Int),
    ("symbol", Some("symbol"), Kind::Text),
    ("direction", Some("direction"), Kind::Text),
    ("shares", Some("quantity"), Kind::Real),
    ("openTime", Some("open_time"), Kind::Date),
    ("closeTime", Some("close_time"), Kind::Date),
    ("durationMin", Some("duration_min"), Kind::Int),
    ("openPrice", Some("open_price"), Kind::Text),
    ("closePrice", Some("close_price"), Kind::Text),
    ("sl", Some("sl"), Kind::Text),
    ("tp", Some("tp"), Kind::Text),
    ("netProfit", Some("net_profit"), Kind::Text),
    ("maePoints", Some("mae"), Kind::Real),
    ("mfePoints", Some("mfe"), Kind::Real),
    ("rMultiple", Some("r_multiple"), Kind::Real),
    ("session", Some("session"), Kind::Text),
    ("dayOfWeek", Some("day_of_week"), Kind::Text),
    ("hour", Some("hour"), Kind::Int),
    ("rangeSize", Some("range_size"), Kind::Real),
    ("hitBreakeven", Some("hit_breakeven"), Kind::Bool),
    ("scaledIn", Some("scaled_in"), Kind::Bool),
    ("comment", Some("comment"), Kind::Text),
    ("timeToMFEMin", Some("time_to_mfe_min"), Kind::Int),
    ("slDistPoints", Some("sl_dist"), Kind::Real),
    ("slippagePoints", Some("slippage"), Kind::Real),
    ("sector", Some("sector"), Kind::Text),
    ("industry", Some("industry"), Kind::Text),
    ("volume", Some("volume"), Kind::Int),
    ("avgVolume", Some("avg_volume"), Kind::Int),
    ("notes", Some("notes"), Kind::Text),
    ("tags", Some("tags"), Kind::Text),
    ("emotion", Some("emotion"), Kind::Text),
    ("commission", Some("commission"), Kind::Text),
    ("swap", Some("swap"), Kind::Text),
    ("screenshots", None, Kind::Text),
    ("checklistData", Some("checklist"), Kind::Text),
    ("importedAt", Some("imported_at"), Kind::Date),
    ("isSample", Some("is_sample"), Kind::Bool),
];

const MAC_CHECKPOINT: &[(&str, Option<&str>, Kind)] = &[
    ("id", Some("id"), Kind::Int),
    ("date", Some("date"), Kind::Date),
    ("title", Some("title"), Kind::Text),
    ("description", Some("description"), Kind::Text),
    ("createdAt", Some("created_at"), Kind::Date),
];

/// Converts a Mac cell to the kind its column holds. Mac columns are all NOT NULL.
fn mac_value(v: ValueRef<'_>, kind: Kind) -> Option<Value> {
    match (owned(v).ok()?, kind) {
        (Value::Integer(i), Kind::Int) => Some(Value::Integer(i)),
        (Value::Integer(i), Kind::Bool) if i == 0 || i == 1 => Some(Value::Integer(i)),
        (Value::Real(f), Kind::Real) if f.is_finite() => Some(Value::Real(f)),
        (Value::Integer(i), Kind::Real) => Some(Value::Real(i as f64)),
        (Value::Text(t), Kind::Text) => Some(Value::Text(t)),
        (Value::Text(t), Kind::Date) => Some(Value::Text(t)),
        _ => None,
    }
}

fn check_mac_history(conn: &Connection, known: &[&str]) -> Result<(), RestoreError> {
    if !table_exists(conn, "grdb_migrations")? || !table_exists(conn, "trades")? {
        return Err(RestoreError::NotABackup);
    }
    let applied = query_strings(conn, "SELECT identifier FROM grdb_migrations")
        .map_err(|_| RestoreError::Damaged)?;
    if !applied.iter().any(|m| m == "v1_createTrades") {
        return Err(RestoreError::NotABackup);
    }
    if !applied.iter().all(|m| known.contains(&m.as_str())) {
        return Err(RestoreError::NewerVersion);
    }
    let unique: HashSet<&String> = applied.iter().collect();
    if unique.len() != applied.len() {
        return Err(RestoreError::UnexpectedSchema("migration history".into()));
    }
    Ok(())
}

/// Only the Mac app's own tables and columns, and no generated columns.
fn check_mac_structure(
    conn: &Connection,
    trade_map: &[(&str, Option<&str>, Kind)],
) -> Result<(), RestoreError> {
    let tables = query_strings(
        conn,
        "SELECT name FROM sqlite_master WHERE type = 'table'",
    )
    .map_err(|_| RestoreError::Damaged)?;
    for table in tables {
        let allowed: Option<Vec<&str>> = match table.as_str() {
            "trades" => Some(trade_map.iter().map(|(n, _, _)| *n).collect()),
            "strategy_checkpoints" => Some(MAC_CHECKPOINT.iter().map(|(n, _, _)| *n).collect()),
            "settings" => Some(vec!["key", "value"]),
            "grdb_migrations" => Some(vec!["identifier"]),
            "sqlite_sequence" => None,
            other => return Err(RestoreError::UnexpectedSchema(format!("table {other}"))),
        };
        let cols = columns(conn, &table)?;
        if cols.iter().any(|c| c.hidden) {
            return Err(RestoreError::UnexpectedSchema(format!(
                "a generated column in {table}"
            )));
        }
        if let Some(allowed) = allowed {
            if let Some(c) = cols.iter().find(|c| !allowed.contains(&c.name.as_str())) {
                return Err(RestoreError::UnexpectedSchema(format!(
                    "column {} in {table}",
                    c.name
                )));
            }
        }
    }
    Ok(())
}

/// Reads a Mac table through a column map. Missing columns (older Mac versions) are absent
/// from the returned rows; `dropped` counts non-empty values of dropped columns.
fn read_mac_table(
    conn: &Connection,
    table: &str,
    map: &[(&str, Option<&str>, Kind)],
) -> Result<(Vec<Row>, usize), RestoreError> {
    let present: HashSet<String> = columns(conn, table)?.into_iter().map(|c| c.name).collect();
    let cols: Vec<&(&str, Option<&str>, Kind)> =
        map.iter().filter(|(n, _, _)| present.contains(*n)).collect();
    let sql = format!(
        "SELECT {} FROM {} ORDER BY rowid",
        cols.iter().map(|(n, _, _)| quoted(n)).collect::<Vec<_>>().join(", "),
        quoted(table)
    );
    let mut stmt = conn.prepare(&sql).map_err(|_| RestoreError::Damaged)?;
    let mut rows = stmt.query([]).map_err(|_| RestoreError::Damaged)?;
    let mut out = Vec::new();
    let mut dropped = 0;
    let mut index = 0;
    while let Some(r) = rows.next().map_err(|_| RestoreError::Damaged)? {
        index += 1;
        let mut row = Row::new();
        let mut bad = Vec::new();
        for (i, (mac, desktop, kind)) in cols.iter().enumerate() {
            let cell = r.get_ref(i).map_err(|_| RestoreError::Damaged)?;
            match (mac_value(cell, *kind), desktop) {
                (Some(Value::Text(t)), None) => {
                    if !t.trim().is_empty() {
                        dropped += t.split(',').filter(|s| !s.trim().is_empty()).count();
                    }
                }
                (Some(_), None) => {}
                (Some(v), Some(name)) => {
                    row.insert((*name).to_string(), v);
                }
                (None, _) => bad.push((*mac).to_string()),
            }
        }
        if !bad.is_empty() {
            return Err(invalid(table, index, bad));
        }
        out.push(row);
    }
    Ok((out, dropped))
}

fn mac_contents(conn: &Connection, brand: &Brand, source: Source) -> Result<Contents, RestoreError> {
    let (known, trade_map) = match source {
        Source::MacDojix => (MAC_DOJIX_MIGRATIONS, MAC_DOJIX_TRADE),
        _ => (MAC_GREENWICK_MIGRATIONS, MAC_GREENWICK_TRADE),
    };
    check_mac_history(conn, known)?;
    check_mac_structure(conn, trade_map)?;
    count_trades(conn)?;

    let (mac_trades, dropped) = read_mac_table(conn, "trades", trade_map)?;
    let now = timestamp_now();
    let mut trades = Vec::with_capacity(mac_trades.len());
    for (i, mut row) in mac_trades.into_iter().enumerate() {
        map_mac_trade(&mut row, source, &now);
        let bad = check_trade(brand, &mut row);
        if !bad.is_empty() {
            return Err(invalid("trades", i + 1, bad));
        }
        trades.push(row);
    }

    let mut checkpoints = Vec::new();
    if table_exists(conn, "strategy_checkpoints")? {
        let (rows, _) = read_mac_table(conn, "strategy_checkpoints", MAC_CHECKPOINT)?;
        for (i, row) in rows.into_iter().enumerate() {
            let ok = text(&row, "title")
                .is_some_and(|t| t.chars().count() <= LABEL_MAX && !has_controls(t, false))
                && text(&row, "description")
                    .is_some_and(|t| t.chars().count() <= TEXT_MAX && !has_controls(t, true))
                && text(&row, "date").is_some_and(valid_date_or_datetime)
                && text(&row, "created_at").is_some_and(valid_datetime)
                && int(&row, "id").is_some_and(|id| id > 0);
            if !ok {
                return Err(invalid(
                    "strategy_checkpoints",
                    i + 1,
                    vec!["title/description/date".into()],
                ));
            }
            checkpoints.push(row);
        }
    }

    let mut settings = Vec::new();
    if table_exists(conn, "settings")? {
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|_| RestoreError::Damaged)?;
        let mut rows = stmt.query([]).map_err(|_| RestoreError::Damaged)?;
        let mut index = 0;
        while let Some(r) = rows.next().map_err(|_| RestoreError::Damaged)? {
            index += 1;
            let key = r.get_ref(0).ok().and_then(|v| owned(v).ok());
            let value = r.get_ref(1).ok().and_then(|v| owned(v).ok());
            match (key, value) {
                (Some(Value::Text(k)), Some(Value::Text(v)))
                    if k.chars().count() <= LABEL_MAX
                        && !has_controls(&k, false)
                        && v.chars().count() <= TEXT_MAX =>
                {
                    let json = serde_json::to_string(&v).map_err(|_| RestoreError::Damaged)?;
                    let mut row = Row::new();
                    row.insert("key".into(), Value::Text(k));
                    row.insert("value_json".into(), Value::Text(json));
                    settings.push(row);
                }
                _ => return Err(invalid("settings", index, vec!["key/value".into()])),
            }
        }
    }

    let to_table = |table: &'static str, cols: &[&str], rows: Vec<Row>| TableRows {
        table,
        columns: cols.iter().map(|c| (*c).to_string()).collect(),
        rows: rows
            .into_iter()
            .map(|mut r| {
                cols.iter()
                    .map(|c| r.remove(*c).unwrap_or(Value::Null))
                    .collect()
            })
            .collect(),
    };
    let (n_trades, n_checkpoints, n_settings) = (trades.len(), checkpoints.len(), settings.len());
    Ok(Contents {
        source,
        tables: vec![
            to_table("trades", TRADE_COLUMNS, trades),
            to_table(
                "strategy_checkpoints",
                &["id", "date", "title", "description", "created_at"],
                checkpoints,
            ),
            to_table("settings", &["key", "value_json"], settings),
        ],
        trades: n_trades,
        checkpoints: n_checkpoints,
        settings: n_settings,
        dropped_screenshot_names: dropped,
    })
}

/// Desktop trade columns a Mac row can fill.
const TRADE_COLUMNS: &[&str] = &[
    "id",
    "ticket",
    "source",
    "is_sample",
    "account_id",
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

fn timestamp_now() -> String {
    let ms = journal::now_ms().max(0) as u64;
    let iso = crate::logging::utc_timestamp(ms / 1000);
    // "YYYY-MM-DDTHH:MM:SSZ" → "YYYY-MM-DD HH:MM:SS.mmm"
    format!("{} {}.{:03}", &iso[..10], &iso[11..19], ms % 1000)
}

/// SPEC 4.4: renames done by the column map; here the derived values.
fn map_mac_trade(row: &mut Row, source: Source, now: &str) {
    let ticket = int(row, "ticket").unwrap_or(0);
    let comment = text(row, "comment").unwrap_or("").to_string();
    let sample = match source {
        Source::MacDojix => comment == SAMPLE_COMMENT && ticket >= 9_000_000_000_000,
        _ => match int(row, "is_sample") {
            Some(v) => v == 1,
            None => {
                (comment == "Demo" || comment == SAMPLE_COMMENT) && (900_000..=900_029).contains(&ticket)
            }
        },
    };
    row.insert("is_sample".into(), Value::Integer(i64::from(sample)));
    row.insert("source".into(), Value::Text("mac_backup".into()));
    row.insert("account_id".into(), Value::Integer(1));
    row.insert("time_basis".into(), Value::Text("utc".into()));
    let imported = text(row, "imported_at").unwrap_or(now).to_string();
    row.insert("updated_at".into(), Value::Text(imported));
    // Older Mac versions had no such column: the Mac default.
    for (col, default) in [
        ("notes", ""),
        ("comment", ""),
        ("commission", "0"),
        ("swap", "0"),
    ] {
        row.entry(col.to_string())
            .or_insert_with(|| Value::Text(default.into()));
    }
    // Tags: comma list → JSON array.
    let tags: Vec<String> = text(row, "tags")
        .unwrap_or("")
        .split(',')
        .map(|t| strip_controls(t, false).trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    row.insert(
        "tags".into(),
        Value::Text(serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into())),
    );
    // Checklist: the Mac ignores what isn't a JSON object, so does the desktop.
    let checklist = text(row, "checklist")
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .filter(serde_json::Value::is_object)
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{}".into());
    row.insert("checklist".into(), Value::Text(checklist));
    // Empty labels are "unknown" on the desktop.
    for col in ["emotion", "sector", "industry"] {
        if text(row, col).is_some_and(|t| t.trim().is_empty()) {
            row.insert(col.to_string(), Value::Null);
        }
    }
    if source == Source::MacGreenwick {
        for col in ["volume", "avg_volume"] {
            row.entry(col.to_string()).or_insert(Value::Integer(0));
        }
    }
    // A Greenwick restore refuses control characters in its labels, as on the Mac; strip
    // them from Mac Dojix rows the way the Mac's `sanitizedForRestore` does.
    if source == Source::MacDojix {
        for col in ["emotion", "vol_regime", "bias_at_entry", "session"] {
            if let Some(t) = text(row, col) {
                let cleaned = strip_controls(t, false);
                row.insert(col.to_string(), Value::Text(cleaned));
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/// Validates a decrypted backup image for `brand`. Nothing is written.
pub fn validate(image: &[u8], brand: &Brand) -> Result<Contents, RestoreError> {
    let conn = open_backup(image)?;
    refuse_triggers_and_views(&conn)?;
    if table_exists(&conn, "grdb_migrations")? {
        let trade_cols: HashSet<String> = columns(&conn, "trades")?.into_iter().map(|c| c.name).collect();
        let source = if trade_cols.contains("lots") {
            Source::MacDojix
        } else if trade_cols.contains("shares") {
            Source::MacGreenwick
        } else {
            return Err(RestoreError::NotABackup);
        };
        match (source, brand.id) {
            (Source::MacDojix, "greenwick") => return Err(RestoreError::OtherBrand("Dojix")),
            (Source::MacGreenwick, "dojix") => return Err(RestoreError::OtherBrand("Greenwick")),
            _ => {}
        }
        return mac_contents(&conn, brand, source);
    }
    desktop_contents(&conn, brand)
}

/// Writes validated contents into the journal in one transaction and saves. On any failure
/// the journal keeps its previous contents.
pub fn apply(
    journal: &mut Journal,
    contents: &Contents,
    file_name: Option<&str>,
) -> Result<RestoreSummary, RestoreError> {
    let result = journal.replace_with(|tx| {
        match contents.source {
            Source::Desktop => {
                for table in DESKTOP_TABLES.iter().rev() {
                    tx.execute(&format!("DELETE FROM {}", quoted(table)), [])?;
                }
            }
            Source::MacDojix | Source::MacGreenwick => {
                // The Mac backup replaces trades, checkpoints and its settings keys; the
                // desktop-only tables (watchlist, rules, presets, history) are kept.
                tx.execute("DELETE FROM trades", [])?;
                tx.execute("DELETE FROM strategy_checkpoints", [])?;
                tx.execute(
                    "INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Default account')",
                    [],
                )?;
            }
        }
        let batch_id = if contents.source == Source::Desktop {
            None
        } else {
            tx.execute(
                "INSERT INTO import_batches (source, origin, file_name, started_at, parsed, inserted) \
                 VALUES ('mac_backup', 'mac_backup', ?1, ?2, ?3, ?3)",
                rusqlite::params![
                    file_name.map(|n| n.chars().take(LABEL_MAX).collect::<String>()),
                    timestamp_now(),
                    contents.trades as i64
                ],
            )?;
            Some(tx.last_insert_rowid())
        };
        for table in &contents.tables {
            let mut columns = table.columns.clone();
            if table.table == "trades" && batch_id.is_some() {
                columns.push("import_batch_id".into());
            }
            let verb = if table.table == "settings" && contents.source != Source::Desktop {
                "INSERT OR REPLACE"
            } else {
                "INSERT"
            };
            let sql = format!(
                "{verb} INTO {} ({}) VALUES ({})",
                quoted(table.table),
                columns.iter().map(|c| quoted(c)).collect::<Vec<_>>().join(", "),
                vec!["?"; columns.len()].join(", ")
            );
            let mut stmt = tx.prepare(&sql)?;
            for row in &table.rows {
                let mut values: Vec<&Value> = row.iter().collect();
                let batch = batch_id.map(Value::Integer);
                if let Some(b) = batch.as_ref() {
                    if table.table == "trades" {
                        values.push(b);
                    }
                }
                stmt.execute(rusqlite::params_from_iter(values))?;
            }
        }
        let violations: i64 = tx.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_check",
            [],
            |r| r.get(0),
        )?;
        if violations > 0 {
            return Err(StoreError::Invalid("foreign keys".into()));
        }
        Ok(())
    });
    if let Err(e) = result {
        log::error!("restore not applied: {e}");
        return Err(RestoreError::Store);
    }
    let mut notices = Vec::new();
    if contents.source != Source::Desktop {
        notices.push(
            "Watchlist and checklist rules live in the Mac app's preferences, not in its \
             backups, so they were not restored."
                .to_string(),
        );
        notices.push(
            "Trades keep their tickets, so importing the same broker file again won't \
             duplicate them."
                .to_string(),
        );
    }
    if contents.dropped_screenshot_names > 0 {
        notices.push(format!(
            "{} screenshot name(s) were not restored: backups never contain the images.",
            contents.dropped_screenshot_names
        ));
    }
    Ok(RestoreSummary {
        source: contents.source,
        trades: contents.trades,
        checkpoints: contents.checkpoints,
        settings: contents.settings,
        notices,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::brand::{DOJIX, GREENWICK};
    use crate::seal::JournalKey;

    fn journal(tmp: &tempfile::TempDir, brand: &Brand) -> Journal {
        let key = JournalKey::generate().unwrap();
        Journal::create(&tmp.path().join("journal.sealed"), key, brand.journal_byte, None).unwrap()
    }

    fn image_of(conn: &Connection) -> Vec<u8> {
        conn.serialize(MAIN_DB).unwrap().to_vec()
    }

    /// A Mac Dojix backup at the latest Mac schema, built with the column layout GRDB
    /// creates (fictional rows).
    pub(crate) fn mac_dojix_backup(extra_sql: &str) -> Vec<u8> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY);
             INSERT INTO grdb_migrations VALUES ('v1_createTrades'), ('v2_addTradeNotes'),
               ('v3_addTradeTags'), ('v4_addEmotionCommissionScreenshotsChecklist'),
               ('v5_createStrategyCheckpoints'), ('v1_createSettings');
             CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket INTEGER NOT NULL UNIQUE,
               symbol TEXT NOT NULL, direction TEXT NOT NULL, lots DOUBLE NOT NULL,
               openTime DATETIME NOT NULL, closeTime DATETIME NOT NULL, durationMin INTEGER NOT NULL,
               openPrice TEXT NOT NULL, closePrice TEXT NOT NULL, sl TEXT NOT NULL, tp TEXT NOT NULL,
               netProfit TEXT NOT NULL, maePips DOUBLE NOT NULL, mfePips DOUBLE NOT NULL,
               rMultiple DOUBLE NOT NULL, session TEXT NOT NULL, dayOfWeek TEXT NOT NULL,
               hour INTEGER NOT NULL, rangeSize DOUBLE NOT NULL, sweepDepth DOUBLE NOT NULL,
               usedFVG BOOLEAN NOT NULL, volRegime TEXT NOT NULL, hitBreakeven BOOLEAN NOT NULL,
               scaledIn BOOLEAN NOT NULL, magic INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '',
               timeToMFEMin INTEGER NOT NULL DEFAULT 0, slDistPips DOUBLE NOT NULL DEFAULT 0,
               slippagePips DOUBLE NOT NULL DEFAULT 0, postClose15m DOUBLE NOT NULL DEFAULT 0,
               postClose30m DOUBLE NOT NULL DEFAULT 0, biasAtEntry TEXT NOT NULL DEFAULT 'NEUTRAL',
               importedAt DATETIME NOT NULL, notes TEXT NOT NULL DEFAULT '',
               tags TEXT NOT NULL DEFAULT '', emotion TEXT NOT NULL DEFAULT '',
               commission TEXT NOT NULL DEFAULT '0', swap TEXT NOT NULL DEFAULT '0',
               screenshots TEXT NOT NULL DEFAULT '', checklistData TEXT NOT NULL DEFAULT '');
             CREATE TABLE strategy_checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT,
               date DATE NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
               createdAt DATETIME NOT NULL);
             CREATE TABLE settings (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO trades (ticket, symbol, direction, lots, openTime, closeTime, durationMin,
               openPrice, closePrice, sl, tp, netProfit, maePips, mfePips, rMultiple, session,
               dayOfWeek, hour, rangeSize, sweepDepth, usedFVG, volRegime, hitBreakeven, scaledIn,
               magic, comment, importedAt, notes, tags, emotion, screenshots, checklistData)
             VALUES (1001, 'EURUSD', 'BUY', 0.5, '2026-01-05 09:00:00.000',
               '2026-01-05 10:30:00.000', 90, '1.1', '1.102', '1.098', '1.106', '100', 4.5, 22.0,
               1.25, 'London', 'Mon', 9, 12.0, 0, 1, 'NORMAL', 0, 0, 0, 'fictional',
               '2026-01-06 08:00:00.000', 'line one\nline two', 'breakout, a+ setup', 'Calm',
               '0123ABCD-0000-0000-0000-000000000000.jpg', '{\"Waited for close\":true}'),
               (9000000000000, 'GBPUSD', 'SELL', 1.0, '2026-01-06 13:00:00.000',
               '2026-01-06 13:30:00.000', 30, '1.25', '1.26', '1.27', '1.2', '-50.25', 0, 0,
               -0.5, 'NY Overlap', 'Tue', 13, 0, 0, 0, 'NORMAL', 0, 0, 0, 'Sample (fictional)',
               '2026-01-07 08:00:00.000', '', '', '', '', 'not json');
             INSERT INTO strategy_checkpoints (date, title, description, createdAt)
               VALUES ('2026-01-01 00:00:00.000', 'New stop rule', 'fictional', '2026-01-01 09:00:00.000');
             INSERT INTO settings VALUES ('propFirmAccountSize', '100000');",
        )
        .unwrap();
        if !extra_sql.is_empty() {
            conn.execute_batch(extra_sql).unwrap();
        }
        image_of(&conn)
    }

    #[test]
    fn datetimes_and_money_text() {
        assert!(valid_datetime("2026-01-05 09:00:00.000"));
        assert!(valid_datetime("2026-01-05 09:00:00"));
        for bad in [
            "2026-13-05 09:00:00",
            "2026-01-05T09:00:00",
            "1899-12-31 23:59:59",
            "2200-01-01 00:00:01",
            "2026-01-05 24:00:00",
            "",
        ] {
            assert!(!valid_datetime(bad), "{bad}");
        }
        assert!(valid_date_or_datetime("2026-01-05"));
        for good in ["0", "-12.5", "1000000000000", "0.00001"] {
            assert!(valid_money(good), "{good}");
        }
        for bad in ["NaN", "1e5", "1000000000001", "", "-", "1.", ".5", "1,5", " 1"] {
            assert!(!valid_money(bad), "{bad}");
        }
    }

    #[test]
    fn a_desktop_backup_round_trips_through_validation() {
        let tmp = tempfile::tempdir().unwrap();
        let mut source = journal(&tmp, &DOJIX);
        source.add_sample_trade().unwrap();
        source.add_sample_trade().unwrap();
        let image = source.image().unwrap();
        let contents = validate(&image, &DOJIX).unwrap();
        assert_eq!(contents.source, Source::Desktop);
        assert_eq!(contents.trades, 2);

        let tmp2 = tempfile::tempdir().unwrap();
        let mut target = journal(&tmp2, &DOJIX);
        target.add_sample_trade().unwrap();
        let generation = target.generation();
        let summary = apply(&mut target, &contents, Some("backup.dxbk")).unwrap();
        assert_eq!(summary.trades, 2);
        assert_eq!(target.trade_count().unwrap(), 2);
        assert_eq!(target.generation(), generation + 1, "one save");
    }

    #[test]
    fn hostile_desktop_backups_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let mut j = journal(&tmp, &GREENWICK);
        j.add_sample_trade().unwrap();
        let good = j.image().unwrap();
        let refuse = |sql: &str| -> RestoreError {
            let conn = journal::memory_connection_from(&good, false).unwrap();
            conn.execute_batch(sql).unwrap();
            validate(&image_of(&conn), &GREENWICK).unwrap_err()
        };
        assert!(matches!(
            refuse("CREATE TRIGGER t AFTER INSERT ON trades BEGIN SELECT 1; END;"),
            RestoreError::UnexpectedSchema(_)
        ));
        assert!(matches!(
            refuse("CREATE VIEW v AS SELECT 1;"),
            RestoreError::UnexpectedSchema(_)
        ));
        assert!(matches!(
            refuse("CREATE TABLE extra (x);"),
            RestoreError::UnexpectedSchema(_)
        ));
        assert!(matches!(
            refuse("CREATE INDEX extra_idx ON trades (notes);"),
            RestoreError::UnexpectedSchema(_)
        ));
        assert!(matches!(
            refuse("PRAGMA user_version = 99;"),
            RestoreError::NewerVersion
        ));
        // Row values: the error names the table, the row and the field.
        match refuse("UPDATE trades SET quantity = 0;") {
            RestoreError::InvalidRow { table, row, fields } => {
                assert_eq!((table.as_str(), row), ("trades", 1));
                assert!(fields.contains("quantity"), "{fields}");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            refuse("UPDATE trades SET net_profit = '1e99';"),
            RestoreError::InvalidRow { .. }
        ));
        assert!(matches!(
            refuse("UPDATE trades SET symbol = x'00';"),
            RestoreError::InvalidRow { .. }
        ));
        assert!(matches!(
            refuse("UPDATE trades SET notes = 'bell' || char(7);"),
            RestoreError::InvalidRow { .. }
        ));
        assert!(matches!(
            refuse("UPDATE trades SET open_time = 'yesterday';"),
            RestoreError::InvalidRow { .. }
        ));
        assert!(matches!(
            validate(b"not a database at all, just some fictional bytes ........................................", &DOJIX),
            Err(RestoreError::NotABackup)
        ));
    }

    #[test]
    fn a_failed_restore_leaves_the_journal_as_it_was() {
        let tmp = tempfile::tempdir().unwrap();
        let mut source = journal(&tmp, &DOJIX);
        source.add_sample_trade().unwrap();
        let contents = validate(&source.image().unwrap(), &DOJIX).unwrap();
        let tmp2 = tempfile::tempdir().unwrap();
        let mut target = journal(&tmp2, &DOJIX);
        target.add_sample_trade().unwrap();
        target.add_sample_trade().unwrap();
        let path = tmp2.path().join("journal.sealed");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert_eq!(
            apply(&mut target, &contents, None).unwrap_err(),
            RestoreError::Store
        );
        assert_eq!(target.trade_count().unwrap(), 2);
    }

    #[test]
    fn a_mac_dojix_backup_is_mapped() {
        let contents = validate(&mac_dojix_backup(""), &DOJIX).unwrap();
        assert_eq!(contents.source, Source::MacDojix);
        assert_eq!((contents.trades, contents.checkpoints, contents.settings), (2, 1, 1));
        assert_eq!(contents.dropped_screenshot_names, 1);

        let tmp = tempfile::tempdir().unwrap();
        let mut j = journal(&tmp, &DOJIX);
        let summary = apply(&mut j, &contents, Some("Dojix-backup.dojixbackup")).unwrap();
        assert_eq!(summary.trades, 2);
        assert!(summary.notices.iter().any(|n| n.contains("screenshot")));
        let conn = j.conn();
        let (source, tags, checklist, sample, notes, emotion): (String, String, String, i64, String, Option<String>) = conn
            .query_row(
                "SELECT source, tags, checklist, is_sample, notes, emotion FROM trades WHERE ticket = 1001",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!(source, "mac_backup");
        assert_eq!(tags, r#"["breakout","a+ setup"]"#);
        assert_eq!(checklist, r#"{"Waited for close":true}"#);
        assert_eq!(sample, 0);
        assert_eq!(notes, "line one\nline two");
        assert_eq!(emotion.as_deref(), Some("Calm"));
        let (sample, checklist, emotion): (i64, String, Option<String>) = conn
            .query_row(
                "SELECT is_sample, checklist, emotion FROM trades WHERE ticket = 9000000000000",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(sample, 1, "sample rows are marked");
        assert_eq!(checklist, "{}");
        assert_eq!(emotion, None);
        let value: String = conn
            .query_row(
                "SELECT value_json FROM settings WHERE key = 'propFirmAccountSize'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "\"100000\"");
        let batches: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM trades t JOIN import_batches b ON b.id = t.import_batch_id \
                 WHERE b.origin = 'mac_backup'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(batches, 2);
    }

    #[test]
    fn mac_backups_go_to_their_own_brand_and_hostile_ones_are_refused() {
        assert_eq!(
            validate(&mac_dojix_backup(""), &GREENWICK).unwrap_err(),
            RestoreError::OtherBrand("Dojix")
        );
        assert!(matches!(
            validate(&mac_dojix_backup("INSERT INTO grdb_migrations VALUES ('v9_future');"), &DOJIX),
            Err(RestoreError::NewerVersion)
        ));
        assert!(matches!(
            validate(&mac_dojix_backup("CREATE TABLE extra (x);"), &DOJIX),
            Err(RestoreError::UnexpectedSchema(_))
        ));
        assert!(matches!(
            validate(&mac_dojix_backup("ALTER TABLE trades ADD COLUMN evil TEXT;"), &DOJIX),
            Err(RestoreError::UnexpectedSchema(_))
        ));
        assert!(matches!(
            validate(&mac_dojix_backup("UPDATE trades SET lots = -1 WHERE ticket = 1001;"), &DOJIX),
            Err(RestoreError::InvalidRow { .. })
        ));
        assert!(matches!(
            validate(&mac_dojix_backup("UPDATE trades SET hour = 99 WHERE ticket = 1001;"), &DOJIX),
            Err(RestoreError::InvalidRow { .. })
        ));
        assert!(matches!(
            validate(&mac_dojix_backup("UPDATE trades SET netProfit = 'NaN' WHERE ticket = 1001;"), &DOJIX),
            Err(RestoreError::InvalidRow { .. })
        ));
        assert!(matches!(
            validate(
                &mac_dojix_backup("CREATE VIEW v AS SELECT * FROM trades;"),
                &DOJIX
            ),
            Err(RestoreError::UnexpectedSchema(_))
        ));
    }

    #[test]
    fn a_mac_greenwick_backup_is_mapped() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY);
             INSERT INTO grdb_migrations VALUES ('v1_createTrades'), ('v2_createStrategyCheckpoints'),
               ('v3_addPerformanceIndexes'), ('v4_createSettings');
             CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket INTEGER NOT NULL UNIQUE,
               symbol TEXT NOT NULL, direction TEXT NOT NULL, shares DOUBLE NOT NULL,
               openTime DATETIME NOT NULL, closeTime DATETIME NOT NULL, durationMin INTEGER NOT NULL,
               openPrice TEXT NOT NULL, closePrice TEXT NOT NULL, sl TEXT NOT NULL, tp TEXT NOT NULL,
               netProfit TEXT NOT NULL, maePoints DOUBLE NOT NULL, mfePoints DOUBLE NOT NULL,
               rMultiple DOUBLE NOT NULL, session TEXT NOT NULL, dayOfWeek TEXT NOT NULL,
               hour INTEGER NOT NULL, rangeSize DOUBLE NOT NULL, hitBreakeven BOOLEAN NOT NULL,
               scaledIn BOOLEAN NOT NULL, comment TEXT NOT NULL DEFAULT '',
               timeToMFEMin INTEGER NOT NULL DEFAULT 0, slDistPoints DOUBLE NOT NULL DEFAULT 0,
               slippagePoints DOUBLE NOT NULL DEFAULT 0, sector TEXT NOT NULL DEFAULT '',
               industry TEXT NOT NULL DEFAULT '', volume INTEGER NOT NULL DEFAULT 0,
               avgVolume INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
               tags TEXT NOT NULL DEFAULT '', emotion TEXT NOT NULL DEFAULT '',
               commission TEXT NOT NULL DEFAULT '0', swap TEXT NOT NULL DEFAULT '0',
               screenshots TEXT NOT NULL DEFAULT '', checklistData TEXT NOT NULL DEFAULT '',
               importedAt DATETIME NOT NULL);
             CREATE TABLE strategy_checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT,
               date DATE NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
               createdAt DATETIME NOT NULL);
             CREATE TABLE settings (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO trades (ticket, symbol, direction, shares, openTime, closeTime, durationMin,
               openPrice, closePrice, sl, tp, netProfit, maePoints, mfePoints, rMultiple, session,
               dayOfWeek, hour, rangeSize, hitBreakeven, scaledIn, comment, sector, volume, importedAt)
             VALUES (900003, 'FICT', 'BUY', 100, '2026-01-05 14:35:00.000', '2026-01-05 15:10:00.000',
               35, '10', '10.5', '9.8', '11', '49', 0.2, 0.6, 2.5, 'Regular', 'Monday', 9, 0.8, 0, 0,
               'Sample (fictional)', 'Technology', 120000, '2026-01-06 08:00:00.000');",
        )
        .unwrap();
        let image = image_of(&conn);
        assert_eq!(
            validate(&image, &DOJIX).unwrap_err(),
            RestoreError::OtherBrand("Greenwick")
        );
        let contents = validate(&image, &GREENWICK).unwrap();
        assert_eq!(contents.source, Source::MacGreenwick);
        let tmp = tempfile::tempdir().unwrap();
        let mut j = journal(&tmp, &GREENWICK);
        apply(&mut j, &contents, None).unwrap();
        let (qty, sample, sector, industry): (f64, i64, Option<String>, Option<String>) = j
            .conn()
            .query_row(
                "SELECT quantity, is_sample, sector, industry FROM trades WHERE ticket = 900003",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(qty, 100.0);
        assert_eq!(sample, 1, "legacy sample rule (no isSample column)");
        assert_eq!(sector.as_deref(), Some("Technology"));
        assert_eq!(industry, None);
    }
}
