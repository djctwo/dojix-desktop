-- Schema v1 (SPEC 4.1): one schema for both brands, held in memory and sealed to disk.
-- Migrations are append-only: never edit a shipped file.
-- Times are UTC text 'YYYY-MM-DD HH:MM:SS.SSS'; money is canonical decimal text.

CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    broker TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD'
);

INSERT INTO accounts (id, name) VALUES (1, 'Default account');

CREATE TABLE import_batches (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('manual', 'scan', 'mt5_watch', 'oanda', 'mac_backup')),
    file_name TEXT,
    file_sha256 TEXT,
    started_at TEXT NOT NULL,
    parsed INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    issues_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE trades (
    id INTEGER PRIMARY KEY,
    ticket INTEGER NOT NULL UNIQUE,
    source TEXT NOT NULL,
    external_id TEXT,
    is_sample INTEGER NOT NULL DEFAULT 0,
    account_id INTEGER NOT NULL DEFAULT 1 REFERENCES accounts (id),
    import_batch_id INTEGER REFERENCES import_batches (id),
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL')),
    quantity REAL NOT NULL,
    open_time TEXT NOT NULL,
    close_time TEXT NOT NULL,
    time_basis TEXT NOT NULL DEFAULT 'utc' CHECK (time_basis IN ('utc', 'broker')),
    duration_min INTEGER NOT NULL,
    open_price TEXT NOT NULL,
    close_price TEXT NOT NULL,
    sl TEXT NOT NULL DEFAULT '0',
    tp TEXT NOT NULL DEFAULT '0',
    net_profit TEXT NOT NULL,
    commission TEXT NOT NULL DEFAULT '0',
    swap TEXT NOT NULL DEFAULT '0',
    mae REAL,
    mfe REAL,
    r_multiple REAL,
    session TEXT NOT NULL,
    day_of_week TEXT NOT NULL,
    hour INTEGER NOT NULL,
    time_to_mfe_min INTEGER,
    sl_dist REAL,
    slippage REAL,
    range_size REAL,
    hit_breakeven INTEGER,
    scaled_in INTEGER,
    -- forex only (NULL for stocks)
    sweep_depth REAL,
    used_fvg INTEGER,
    vol_regime TEXT,
    magic INTEGER,
    post_close_15m REAL,
    post_close_30m REAL,
    bias_at_entry TEXT,
    -- stocks only (NULL for forex)
    sector TEXT,
    industry TEXT,
    volume INTEGER,
    avg_volume INTEGER,
    -- annotations
    comment TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    emotion TEXT,
    checklist TEXT NOT NULL DEFAULT '{}',
    imported_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_trades_symbol ON trades (symbol);
CREATE INDEX idx_trades_session ON trades (session);
CREATE INDEX idx_trades_open_time ON trades (open_time);
CREATE INDEX idx_trades_close_time ON trades (close_time);
CREATE INDEX idx_trades_hour ON trades (hour);
CREATE INDEX idx_trades_direction ON trades (direction);
CREATE INDEX idx_trades_day_of_week ON trades (day_of_week);
CREATE INDEX idx_trades_symbol_close ON trades (symbol, close_time);
CREATE INDEX idx_trades_sector ON trades (sector);
CREATE INDEX idx_trades_account ON trades (account_id);
CREATE INDEX idx_trades_is_sample ON trades (is_sample);

CREATE TABLE trade_screenshots (
    id INTEGER PRIMARY KEY,
    trade_id INTEGER NOT NULL REFERENCES trades (id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_trade_screenshots_trade ON trade_screenshots (trade_id);

CREATE TABLE strategy_checkpoints (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE checklist_rules (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    position INTEGER NOT NULL
);

CREATE TABLE watchlist (
    symbol TEXT PRIMARY KEY,
    position INTEGER NOT NULL
);

CREATE TABLE mapping_presets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    header_signature TEXT NOT NULL,
    mapping_json TEXT NOT NULL
);

CREATE TABLE watched_files (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    last_result TEXT NOT NULL DEFAULT ''
);

CREATE TABLE ai_reports (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    model TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    request_preview TEXT NOT NULL,
    response_text TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);
