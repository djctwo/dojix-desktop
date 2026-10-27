# Dojix + Greenwick for Windows and Linux: design spec

**Status:** refreshed 2026-10-27. This revision replaces the first draft of 2026-10-26.
**Companion documents:**
- [DECISIONS.md](DECISIONS.md): the seven project decisions.
- [PARITY.md](PARITY.md): what must match the Mac apps exactly, and every intentional
  difference.

**Sources:** the public Mac apps, read as source code (nothing was run):
- **djctwo/dojix** at `614bd6a` (Dojix 1.0.0 plus CI fixes): 69 component files; 374 unit
  tests and 18 UI tests.
- **djctwo/greenwick** at `64495e2` (Greenwick 1.0.1): 76 component files; 202 unit tests and
  26 UI tests.

## 0. Summary

**One codebase builds two installable desktop apps** for Windows 10/11 (the main target,
because MetaTrader is a Windows program) and Linux:
- **Dojix**, for forex traders;
- **Greenwick**, for stock and day traders.

They have the same screens, features and **numbers** as today's Mac apps. They are free and
open source (GPL-3.0). There is no billing code and no telemetry. Online extras work only with
keys the user enters.

**What changed since the first draft.** The Mac apps were hardened and fixed for their
open-source release, and this spec now follows them:

- **Storage design follows the Mac.** The journal lives **in memory** and is sealed with
  AES-256-GCM after every commit. App Lock wraps the key. The design adds rollback (older-copy)
  protection, crash-safe key rotation, an idle auto-lock, a fail-closed throttle, a
  single-instance lock, sealed screenshots, password-protected backups and validated restores.
  The earlier SQLCipher plan is dropped (§6).
- **Greenwick's numbers are net of commissions and fees on the Mac too**, and its trades are
  bucketed by **US-Eastern trading day** (`Market` / `TradingCalendar`). That is now a parity
  requirement, not a planned difference.
- **Re-importing is idempotent on the Mac too** (content-derived tickets). The desktop app
  computes tickets **exactly** the way each Mac app does. That way, a Mac backup restored on
  Windows plus a re-import of the same broker file never creates duplicates.
- **Several items listed as Mac bugs in the first draft are already fixed** on the Mac:
  - the MT5 folder;
  - streaming prices not shown;
  - "Forgot password" removing the lock;
  - encrypted backups that couldn't be restored;
  - Greenwick's gross P&L and FIFO commission double count;
  - Greenwick shorts recorded as BUY;
  - the GapAnalysis sort;
  - the onboarding loop;
  - the hard-coded export path;
  - the CSV export of negative numbers;
  - ticketless duplicates.

  They are parity items now. The remaining differences, each with a reason and a test, are in
  PARITY.md.
- **Phase plan.** A new "Security core" phase (1S) runs alongside the engine phase. The
  estimate moves from about 5–7 weeks to **about 6–8 weeks** (§12).

**The stack is unchanged:** Tauri 2, React + TypeScript for screens and math, a small Rust
shell for storage, crypto, vault, network and MT5, and a pnpm workspace (§7).

## 1. Scope

**In scope (v1):**
- Every feature of both Mac apps as of the pinned commits, except the items dropped in §2.8.
- The Windows and Linux additions in §2.9.

**Out of scope (v1):**
- A macOS build of this codebase (the native Mac apps stay).
- Cloud sync, accounts, mobile.
- A tray or menu-bar widget.
- Options trading.
- Exporting a backup the Mac apps can restore (see PARITY.md, "Open questions").

**Platforms:**
- Windows 10 22H2+ and 11, x64 (ARM64 nice-to-have).
- Linux x64: Ubuntu 22.04+, Debian 12+, Fedora 39+ (tier-2).

## 2. Feature inventory (current Mac behaviour → desktop)

**Tags:**
- **PORT:** same behaviour.
- **ADAPT:** ported with a stated change.
- **DROP:** not carried over.
- **NEW:** new for both platforms.
- **DESK:** Windows/Linux-specific.

**Scope:** **S** = both brands; **FX** = Dojix; **ST** = Greenwick.

### 2.1 Shell and navigation

| Feature | Scope | Tag | Notes |
|---|---|---|---|
| Launch gate: already open → older copy → lock screen → onboarding → main window (min 900×600, default 1200×800) | S | PORT | Order and screens as on the Mac (§6) |
| Sidebar: Journal, Dashboard, Analytics, Edge Report, Import, Settings | S | PORT | |
| Sidebar: Pulse | FX | PORT | |
| Sidebar: Browse, Watchlist | ST | PORT | |
| Sidebar live ticker (first 5 watchlist quotes, freshness dot) | FX | PORT | Fed by the active live source; streaming sources included, as on the Mac today |
| Session clock: FX UTC sessions with time left; ST ET pre-market / regular / after-hours with countdown | S | ADAPT | ST: the countdown skips weekends and NYSE full-day holidays and shows "Closed (holiday)". The Mac counts Friday evening down to Saturday 04:00. Display only: analytics still ignore holidays (parity) |
| Onboarding. FX: 8 steps (Welcome with experience level, Import, Journal, Dashboard, Edge Report, Pulse, Setup, Ready with Load Sample Trades); "Expert" sees Welcome/Setup/Ready. ST: one welcome screen with Get Started / Load Sample Trades | S | ADAPT | Shown once; Settings → Help → "Show welcome tour" brings it back (as on the Mac). The FX Setup step offers the opt-in MT5 watcher (§5.4) instead of a path field |
| Lock screen, older-copy screen, "already open" screen, database-issue banner, database-failed screen ("Quit & relaunch") | S | PORT | §6 |
| About (version, licences, credits, "not financial advice") | S | ADAPT | Reachable from Help → About. On both Macs the About window exists but no menu item opens it |
| Toasts (3.5 s) + Undo (5 s) on Delete All Trades | S | PORT | |
| Keyboard shortcuts. FX: Ctrl+1 Journal … Ctrl+6 Import, Ctrl+, Settings, Ctrl+E Export PDF, Ctrl+Shift+E Essential/All, Ctrl+? / F1 Help. ST: Ctrl+1 … Ctrl+5 Import, Ctrl+N New Trade, Ctrl+I Import, Alt+1–6 analytics tabs, Ctrl+Enter confirm mapping | S | ADAPT | Ctrl replaces Cmd, Alt replaces Option, F1 added. Both brands get Ctrl+N (Add Trade) and Alt+1–6. The Help page lists every shortcut (the Mac page omits three) |
| Theme: dark; FX warm gold, ST teal; DM Sans + JetBrains Mono (OFL); Lucide icons; numbers in mono | S | PORT | |
| Sample trades: 30 fictional trades; load from onboarding or Settings → Data; "Remove Sample Trades" removes only those | S | ADAPT | Marked with `is_sample`, with the brand's Mac ticket range and comment "Sample (fictional)". Generated from a fixed seed plus "now" (the Mac randomises some fields) |
| Single-instance lock | S | PORT | §6.9 |

### 2.2 Journal and trade detail

| Feature | Scope | Tag | Notes |
|---|---|---|---|
| Journal table: Close Time, Pair/Symbol, Dir, Lots/Shares, P&L, Cum P&L, R, Grade, Session, Hour; sortable; column layout saved | S | PORT | Virtualised (100k rows). Refreshes live on `trades_changed` |
| Filters: search, symbol, session, direction, date range (All / Today / This Week / This Month / 30d / 90d); active-filter badge + clear all; performance strip with "?" definitions; row menu (View, Copy summary, Copy P&L) | S | PORT | "Today / week / month" use the brand calendar (§3.1) |
| Trade detail: info, prices, performance (R, MAE, MFE, time-to-MFE, slippage), editable costs, emotion chips, checklist toggles, screenshots (max 10), tags with suggestions, notes (autosave), metadata | S | PORT | FX "Advanced" block (bias, volatility, range, sweep, FVG, BE, scaled-in, post-close 15/30m). ST block (sector, industry, volume). Cost edits follow each brand's rule: ST moves net P&L by the change in costs; FX keeps P&L and shows "net after costs" |
| Add Trade (manual entry with live P&L/R preview and validation) | ST→S | ADAPT | ST as on the Mac (net = gross − commission; fixed on the Mac). FX gains it, in lots/pips, through the same validation |
| Trade Replay (equity stepping, play/pause, 0.5–5×, running stats) | S | PORT | |
| Export: PDF (Journal summary + last 50), CSV | S | ADAPT | §2.7 |

### 2.3 Dashboard, Analytics, Edge Report

| Feature | Scope | Tag | Notes |
|---|---|---|---|
| Dashboard: Essential/All toggle, First Look banner after the first import of 10 or more trades, DailyBrief, metrics grid, equity curve, collapsible sections, symbol + period filters, export menu | S | PORT | |
| Prop-firm tracker + status badge (defaults 100,000 / 8% / 5% / 10%; caution ≥75%, danger ≥90%, breached) | S | PORT | Parameters in the journal `settings` table (both Macs) |
| Analytics sub-tabs: Timing / Sessions / Pairs or Symbols / Risk / Behavioral / Advanced | S | PORT | Placement per brand from the registry (§7.3) |
| Every analytics component in both apps (Appendix A); Dojix-only (7) and Greenwick-only (14) components by brand | S | PORT | Formula catalogue in Appendix A; intentional fixes in PARITY.md |
| QuickInsight, TrendIndicator | S | DROP | In the code of both apps but shown nowhere |
| Edge Report (30 trades or more): header metrics; "Where you make / lose money" by session, hour, pair/ticker, day; AI card; tag analytics; PDF | S | PORT | |
| Edge Report extras: bias alignment, volatility regime, post-close analysis | FX | PORT | |
| KillZone / WhatToCut CSV export through a Save dialog | S | PORT | Fixed on the Mac |

### 2.4 Brand screens

| Feature | Scope | Tag | Notes |
|---|---|---|---|
| **Pulse:** session hero, danger zone (±15 min of high-impact events), edge-match signal, session cards, 24h timeline, "your session edge", economic calendar (week by day, "your history" on big events), live prices + currency strength, watchlist editor (23 pairs, max 8) | FX | ADAPT | Fix: the edge signal recomputes when the hour or session changes and after the calendar loads (the Mac computes it once, on appear) |
| **Browse:** ticker search (debounced 300 ms), quote card, company profile, personal history overlay, last 10 trades, Watch toggle | ST | PORT | User's Finnhub key |
| **Watchlist:** symbols with stats from the user's own trades, sorts, quotes | ST | ADAPT | Symbols validated (1–10 characters, `[A-Z0-9.]`); stored in the encrypted journal |

### 2.5 Import (details in §5)

| Feature | Scope | Tag | Notes |
|---|---|---|---|
| Drop zone, Choose File (multi-select), Scan Folder, confirmation "~N trades in <format>", column-mapping sheet (preview, auto-assign, date format), error banner | S | ADAPT | Scan Folder queues every file and shows one combined summary. On the Mac only the last file's prompt survives. Unknown files are listed as "skipped" |
| Import history | S | ADAPT | Saved in the journal (`import_batches`); the Mac keeps it for the session only |
| Skipped-row report (row number + reason) | S | NEW | The Mac drops bad rows silently |
| Column-mapping presets | S | NEW | |
| OANDA API import | FX | PORT | §8.4 |
| MT5 auto-import watcher | FX | ADAPT | Opt-in and read-only (§5.4). On the Mac it is always on |
| MT5 History Report (`ReportHistory-*.html` / `.xlsx`) importer; DojixExport CSV | FX | DESK | §5.2, §5.3 |
| Mac backup import | S | NEW | Through Restore (§6.8) |

### 2.6 Settings

| Setting | Scope | Tag | Stored in |
|---|---|---|---|
| App Lock: enable / change password / disable (current password required); "Lock when idle" Off/1/5/15/30/60 (default 15) | S | PORT | Vault + `prefs.json` (idle minutes) |
| AI: Anthropic key + Test; **Allow AI analysis** switch (off by default); advanced model picker | S | ADAPT | Vault / journal. FX gains the switch Greenwick has |
| Live data source (FX: Twelve Data REST / WS, OANDA stream, Polygon WS, MT5 file) + per-source key + Test | FX | PORT | Vault + journal |
| Finnhub key + Test | ST | PORT | Vault |
| OANDA import: token, account ID, practice/live, Test | FX | PORT | Vault |
| MT5: auto-import on/off (off by default), found locations, added folders, file patterns, last result | FX | DESK | Journal |
| Broker server time zone for 32-column MT5 files (default "Treat as UTC", the Mac behaviour) | FX | NEW | Journal; §3.1 |
| Display time zone (default: the computer's) and week start (FX) | FX | NEW | `prefs.json`. Greenwick always uses exchange time, as on the Mac |
| Economic calendar on/off (default on) | FX | NEW | `prefs.json` |
| Data: trade count, journal size, open data folder, Export Backup (password; on by default with App Lock), Restore Backup, Load/Remove Sample Trades, Delete All (undo), Erase all local data | S | PORT | |
| Updates: check automatically (default on), check now, release notes | S | DESK | `prefs.json` |
| Diagnostics: export redacted log bundle | S | NEW | |
| Help: show welcome tour; About; "Report an issue" (the project's GitHub Issues) | S | PORT | |

### 2.7 Export, backup and security features

| Feature | Scope | Tag | Notes |
|---|---|---|---|
| CSV export of trades | S | ADAPT | The first columns are exactly the Mac's (FX: the 27 Mac columns, UTC times). Notes, tags, emotion, commission, swap and comment are **appended** after them. Formula guard identical to the Mac (§11) |
| PDF reports: Journal, Dashboard, Edge Report | S | PORT | Generated in-app (pdfmake); sections match the Mac text |
| Shareable summary + copy (clipboard cleared afterwards) | S | PORT | Footer links to the project page |
| Journal encrypted at rest (in memory, sealed after every commit) | S | PORT | §6.3 |
| App Lock key wrapping, crash-safe key rotation | S | ADAPT | Argon2id instead of PBKDF2 (§6.4) |
| Idle auto-lock + OS lock triggers | S | ADAPT | Windows/Linux equivalents (§6.7) |
| Wrong-password throttle (persisted, fail-closed, shared) | S | PORT | §6.6 |
| Rollback / older-copy protection | S | PORT | §6.5 |
| Password-protected backups; validated restore from rows | S | ADAPT | Desktop `DXBK` format plus readers for every Mac format (§6.8) |
| Automatic snapshots (pre-migration + daily, keep 7) | S | NEW | §6.8 |
| Sealed screenshots | S | PORT | Greenwick's construction for both (§6.10) |
| Forgot password = erase all local data (no recovery) | S | PORT | Matches the unsigned Mac release builds (§6.6) |
| Save-before-quit and held journal when a save fails | S | ADAPT | Greenwick's behaviour for both brands |

### 2.8 Dropped

- **Never shipped in the open-source Mac apps:** billing, licences, tiers, trials and their
  gates; the Mac-only updater; the beta gate; the URL scheme; the machine ID.
- **Dead code in both apps:** QuickInsight, TrendIndicator; the unused daily-summary prompt and
  the second model id; the Finnhub earnings calendar (no callers; a later input for
  EarningsImpact).
- **Greenwick's password recovery copy:** it needs a signed macOS build with a biometric-gated
  Keychain item, so the shipped Mac builds don't have it either.
- **Certificate pinning** (§8.1).

### 2.9 Windows and Linux additions

1. **MT5 auto-import:** opt-in, read-only, finds terminals through `origin.txt` (§5.4).
2. **Native MT5 price-file source:** no Wine path guessing on Windows.
3. **`DojixExport.mq5`:** a free, open-source script that exports every closed position, any
   symbol, any account, to MT5's Common Files folder (§5.3).
4. **MT5 History Report importer** (HTML first, XLSX second).
5. **Notifications:** "12 new trades imported from MT5" (opt-in).
6. **Installers:** per-user NSIS, MSI, winget; AppImage, `.deb`, `.rpm`; signed in-app updates
   (§9).
7. **Credential storage:** Windows Credential Manager or Linux Secret Service; the data folder
   in `%LOCALAPPDATA%` / XDG data (§6).

## 3. Semantics and formulas

### 3.1 What the Swift code actually does (reproduced first)

The Swift code wins where it disagrees with comments or docs.

**Money:**
- Prices, SL, TP, P&L, commission and swap are stored as **decimal text** (Swift
  `Decimal.description`: `.` separator, trailing zeros dropped).
- Analytics convert to **Double** before doing any math. The exception is DailyBrief, which sums
  in Decimal.
- The desktop stores decimal text and computes in IEEE-754 doubles, which is the same
  arithmetic.

**P&L is net of costs in both apps:**
- **Dojix.** 32-column MT5 and MT4 profit already includes commission and swap. Cost fields
  edited in the detail view are informational, and "net after costs" = total − costs.
- **Greenwick.** Every path stores net: generic rows `profit − |commission| − swap`; FIFO
  `(sell − buy)·matched − prorated costs`; manual entry `(close − open)·shares·dir −
  commission`. Editing costs moves net P&L by the change. Gross = net + costs.

**Win / loss / breakeven:**
- win = P&L > 0, loss = < 0.
- A breakeven trade is neither, but it is still in the win-rate denominator.
- Win rate is a percent in most components. It is a **0–1 fraction** in RiskOfRuin,
  EmotionalAnalytics, CalendarCorrelation, EventImpactProfiler, EdgeDecay, the Consistency
  windows and the Behavioral revenge rate.

**Time storage:** UTC text `YYYY-MM-DD HH:MM:SS.SSS` (GRDB format), compared as strings.

**Dojix time rules:**
- 32-column MT5 times are **broker server time** but are stored as if they were UTC. The file's
  Session / Day / Hour columns are trusted verbatim. The file's own buckets: Asian 0–7, London 8–11,
  NY_Overlap 12–16, NY 17–21, Late 22–23.
- Generic and OANDA imports derive sessions from real UTC. App buckets: Asian 0–6, London 7–11,
  NY Overlap 12–15, NY 16–20, Late 21–23. All generic dates are parsed as UTC.
- Calendar bucketing (day, week, month, trading-day counts, date filters, news heuristics) uses
  **the computer's time zone and locale week** (`Calendar.current`, 24 files). The desktop
  equivalent is the "display time zone" setting, which defaults to the computer's zone.

**Greenwick time rules:**
- Everything is in **exchange time** through `Market.us` / `TradingCalendar`:
  - America/New_York with the exchange's DST;
  - Gregorian calendar, POSIX locale, Monday-start weeks, `minimumDaysInFirstWeek = 4`.
- Stored session, hour and day come from the **open** time in ET:
  - pre-market [04:00, 09:30), regular [09:30, 16:00), after-hours [16:00, 20:00);
  - everything else, weekends included, is "Extended".
- A trade's **trading day** is the ET date of its **close**. A Friday 18:50 ET close is a
  Friday trade for a user anywhere.
- 21 components and the journal and dashboard filters use it.
- Still on the computer's calendar: PeriodComparison cut-offs, GrowthProjection, the
  EventImpactProfiler day span, and the TradeCalendar grid's first weekday (display only).
- There is **no holiday calendar** in the analytics.

**"Now" dependence:** PerformanceSummary, TradeCalendar, PeriodComparison, prop-firm daily,
DailyBrief, Pulse, EventImpactProfiler, the date filters, and sample-trade dates.

**Randomness:** MonteCarloSimulation (unseeded shuffle) and sample-trade generation.

**Order:**
- Repositories return trades by close time descending.
- MetricsCalculator sums in that order and re-sorts ascending for drawdown and streaks.
- Swift sorts are stable. Dictionary and Set order is random per process, so ties in unsorted
  outputs are non-deterministic. The desktop breaks ties by input order, then label.

**Integer and rounding rules:**
- Swift `Int /` truncates toward zero.
- Average duration is a Double mean truncated toward zero (the same as integer division for
  non-negative values).
- `String(format:"%.2f")` rounds the exact binary value half-to-even.
- `.rounded()` rounds half away from zero (PositionSizer).
- `Int(saturating:)` sends NaN → 0 and ±∞ → Int.max/min (both apps; used in labels,
  Behavioral, Consistency, Emotional, ImprovementTracker, and Dojix's Monte Carlo indexes).

**Sentinels:**
- Profit factor with no losses: +∞ (shown as "99.99") in Metrics, allEdgeConditions and
  SessionIntelligence; 99 in EventImpactProfiler; 10 in Consistency; 5 (capped) in
  ImprovementTracker and EdgeDecay.
- Calmar with no drawdown: 10 if profitable, else 0.
- Sharpe is 0 when σ = 0.

**Clamps:** Greenwick Behavioral scores 0–100 (+∞ → 100, NaN → 0); Consistency 0–100; EdgeDecay
chart Sharpe ±3; exit efficiency 0–100; prop-firm progress 0–1.

### 3.2 Engine context

Every computation takes an explicit context, so no hidden dependency remains:

```
EngineContext {
  brand: 'dojix' | 'greenwick',
  calendar: { tz: IANA zone, weekStart: 1..7, minDaysInFirstWeek: 1..7 },
      // dojix: the display zone + locale week
      // greenwick: fixed America/New_York, Monday, 4
  localCalendar: same shape,  // greenwick only: the few components still on the computer's calendar (§3.1)
  now: epoch ms,
  rng: seeded PRNG,           // seed shown in the UI where randomness is visible
  brokerOffset: 'utc' | IANA zone,  // dojix 32-column MT5 files; default 'utc'
  compat: 'swift' | 'fixed'   // 'swift' exists only while Phase 2 proves parity
}
```

- The UI supplies the user's settings. Tests supply fixed values; parity runs use `TZ=UTC` and
  `en_US_POSIX`, the same as the Swift harness.
- **Broker time.** Choosing a real broker zone instead of "Treat as UTC" converts times on
  import and stores `time_basis = 'broker'` with the original values. This is a logged,
  opt-in difference. The default keeps the Mac numbers.

### 3.3 Headline formulas (Swift, both apps unless noted)

`p_i` = a trade's P&L as a double, in input order (close time descending) unless stated.

| Metric | Definition |
|---|---|
| totalTrades | n (breakevens included) |
| wins / losses | count p>0 / count p<0 |
| winRate | wins / n × 100 |
| totalProfit | Σp in input order |
| grossProfit / grossLoss | Σ(p>0) / \|Σ(p<0)\| |
| profitFactor | grossLoss>0 ? gp/gl : (gp>0 ? +∞ : 0) |
| averageWin / averageLoss | gp/wins, gl/losses (positive; 0 if none) |
| expectancy | (WR/100)·avgWin − (1 − WR/100)·avgLoss (breakevens weigh on the loss side) |
| maxDrawdown | ascending by close time; cum = 0, peak = 0; peak = max(peak, cum); maxDD = max(maxDD, peak − cum). Dollars, starting from 0 |
| streaks | ascending; a win extends the win run and resets the loss run, and vice versa; **a breakeven changes nothing**; current = +W, −L, or 0 if the last trade is a breakeven |
| averageDuration | mean of durationMin truncated toward zero (saturating) |
| sharpeRatio | mean / σ_pop of per-trade p; 0 if σ = 0; not annualised |
| calmarRatio | maxDD>0 ? total/maxDD : (total>0 ? 10 : 0) |
| averageR / averageMAE / averageMFE | arithmetic means over all n (unknown = 0 on the Mac; see PARITY D-18) |
| best / worst | max p / min p |
| totalCommissions, totalSwap, totalCosts | sums |
| netProfitAfterCosts | **Dojix:** total − totalCosts · **Greenwick:** total (already net) |
| edgeBy{Hour, Session, Day, Pair, Bias, VolRegime, Sector} | group → (label, Σp, count, WR%); sorted by Σp descending. Labels: hour "9:00", session display name, day "Mon"…, symbol, enum, sector or "Unknown" |
| confidence(n) | n<10 insufficient · n<30 low · otherwise significant; actionable n≥30 |
| allEdgeConditions | per dimension (FX: Hour, Day, Session, Pair, Volatility, Bias; ST: Hour (ET), Day, Session, Symbol, Sector) and group: profit, WR, avgWin, avgLoss, expectancy, PF, monthlyImpact = profit × 21 / tradingDays (ST: ET close days) |
| FX sessions (app, UTC hour) | primary 0–6 Asian, 7–11 London, 12–15 NY Overlap, 16–20 NY, else Late; active windows Asian 0–9, London 7–16, NY 12–21, Late 21–24 |
| ST sessions | §3.1 (ET minutes from the open time) |
| FX generic derived values | slDist pips = \|open − SL\| × (JPY ? 100 : 10000); R = profit / (slDist × lots × (JPY ? 100 : 10)) when SL ≠ 0 (D-06) |
| ST generic derived values | slDist = \|open − SL\|; R = netProfit / (slDist × shares) when SL ≠ 0 |
| TradeGrader | four sub-scores of 0–25 (R, execution, timing, management); ≥80 A, ≥65 B, ≥50 C, ≥35 D, else F (Appendix A) |

## 4. Data model and migrations

### 4.1 Schema (one schema for both brands; SQLite in memory, §6)

Migrations are owned by Rust (`rusqlite_migration`). They are versioned and append-only, a
snapshot is taken before each one, and the migrator **never** erases a database.

```sql
CREATE TABLE trades (
  id INTEGER PRIMARY KEY,
  ticket INTEGER NOT NULL UNIQUE,        -- derived EXACTLY as the brand's Mac app does (§5.1)
  source TEXT NOT NULL,                  -- mt5_32col | dojix_export | mt5_report | mt4 | ctrader | tradingview
                                         -- | oanda_csv | oanda_api | ibkr | tos | ninjatrader | webull | robinhood
                                         -- | schwab | fidelity | etrade | tastytrade | generic | manual | sample | mac_backup
  external_id TEXT,                      -- broker's own id, display only
  is_sample INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER NOT NULL DEFAULT 1 REFERENCES accounts(id),
  import_batch_id INTEGER REFERENCES import_batches(id),
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('BUY','SELL')),
  quantity REAL NOT NULL,                -- lots (Dojix) / shares (Greenwick)
  open_time TEXT NOT NULL, close_time TEXT NOT NULL,      -- UTC, GRDB-identical text
  time_basis TEXT NOT NULL DEFAULT 'utc',                 -- utc | broker
  duration_min INTEGER NOT NULL,
  open_price TEXT NOT NULL, close_price TEXT NOT NULL,
  sl TEXT NOT NULL DEFAULT '0', tp TEXT NOT NULL DEFAULT '0',
  net_profit TEXT NOT NULL,              -- decimal text, net of costs (§3.1)
  commission TEXT NOT NULL DEFAULT '0', swap TEXT NOT NULL DEFAULT '0',
  mae REAL, mfe REAL, r_multiple REAL,   -- pips (FX) / points (ST); NULL = unknown
  session TEXT NOT NULL, day_of_week TEXT NOT NULL, hour INTEGER NOT NULL,
  time_to_mfe_min INTEGER, sl_dist REAL, slippage REAL, range_size REAL,
  hit_breakeven INTEGER, scaled_in INTEGER,
  -- forex only (NULL for stocks)
  sweep_depth REAL, used_fvg INTEGER, vol_regime TEXT, magic INTEGER,
  post_close_15m REAL, post_close_30m REAL, bias_at_entry TEXT,
  -- stocks only (NULL for forex)
  sector TEXT, industry TEXT, volume INTEGER, avg_volume INTEGER,
  -- annotations
  comment TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',       -- JSON array (the Mac stores a comma list)
  emotion TEXT, checklist TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- indexes: symbol, session, open_time, close_time, hour, direction, day_of_week,
--          (symbol, close_time), sector, account_id, is_sample
```

**Other tables:**
- `accounts(id, name, broker, currency)`: one default row in v1.
- `trade_screenshots(id, trade_id, file_name, created_at)`.
- `strategy_checkpoints(id, date, title, description, created_at)`.
- `checklist_rules(id, text, position)`.
- `watchlist(symbol, position)`.
- `import_batches(id, source, origin manual|scan|mt5_watch|oanda|mac_backup, file_name, file_sha256, started_at, parsed, inserted, duplicates, skipped, issues_json)`.
- `mapping_presets(id, name, header_signature, mapping_json)`.
- `watched_files(path, size, mtime, sha256, last_seen, last_result)`.
- `ai_reports(id, created_at, model, request_sha256, request_preview, response_text, input_tokens, output_tokens)`.
- `settings(key PRIMARY KEY, value_json)`: prop-firm parameters, live source, MT5 config,
  broker zone, AI switch, model.

### 4.2 The engine's view of a trade

`packages/core` reads a `Trade` with the Mac field names (`netProfit`, `lots|shares`,
`maePips|maePoints`, …).
- In `compat: 'swift'` mode, NULL unknowns are read as 0, the Mac storage.
- In `fixed` mode they follow D-18.

### 4.3 Storage validation (shared by import, manual entry and restore)

**Per brand, identical to the Mac:**
- **Dojix (`Trade+Sanitize`) clamps on import:**
  - money ±1e12; pip, R, slippage and post-close metrics ±1e9;
  - lots |x| in [1e-5, 1e6] (0 kept; smaller non-zero values raised to 1e-5);
  - durations 0–5,270,400 min; NaN/∞ → 0;
  - close before open → close = open;
  - symbol ≤ 32 characters, comment ≤ 256, control characters stripped;
  - an invalid hour or weekday is recomputed (UTC).
- **Greenwick (`TradeLimits`) rejects the row:**
  - shares 1e-6–1e9; amounts ≤ 1e12; duration ≤ 20×366 days; points ≤ 1e9; volume ≤ 1e12;
  - text ≤ 100,000; labels ≤ 200; symbol ≤ 32; screenshots ≤ 10;
  - dates 1900-01-01 – 2200-01-01; hour 0–23; ticket > 0;
  - C0/C1 controls and U+2028/2029 stripped (notes keep `\n` and `\t`).
- **Restore (both brands)** uses the reject form (`storageViolations`) for every row. A
  rejected row is named in the error; the restore is refused, never partly applied.

### 4.4 Mac backup mapping

**Mac Dojix** (`trades`, `strategy_checkpoints`, `settings`):
- one-to-one renames (`lots → quantity`, `maePips → mae`, …);
- `ticket` kept, `source = 'mac_backup'`;
- tags: comma list → JSON array;
- `checklistData` → `checklist`;
- prop-firm settings keys copied;
- sample rows (comment "Sample (fictional)" and ticket ≥ 9e12) get `is_sample = 1`;
- screenshot names dropped with a notice (images are never in backups).

**Mac Greenwick:** the same, with `shares → quantity`, `maePoints → mae`,
`isSample → is_sample`, and sector/industry/volume kept.

**Watchlist and checklist rules** live in the Mac's preferences file, not in backups, so they
don't transfer. The restore summary says so.

## 5. Import pipeline

### 5.1 Pipeline

1. **Bytes in (Rust):** file dialog, drag-drop, folder scan, MT5 watcher, OANDA API.
   - Cap 50 MB.
   - Read-only open with full share mode, so MT5 is never locked out.
   - SHA-256 of the file.
2. **Decode (TS):**
   - BOM sniff: UTF-8, UTF-16LE, UTF-16BE.
   - Otherwise strict UTF-8, otherwise Windows-1252.
   - Normalise line endings.
   - Comma, semicolon and tab delimiters are detected; decimal comma when the delimiter is a
     semicolon.
   - The Macs: Dojix decodes UTF-8 → CP1252 → UTF-16LE (the last never triggers); Greenwick
     UTF-8 → CP1252; both are comma-only. The desktop accepts a superset; every file the Macs
     parse still parses the same way.
3. **Detect:**
   - **32-column MT5 CSV:** by its `Ticket,Symbol,Direction` header line anywhere in the file,
     or a header containing both `ticket` and `rmultiple`. The Mac also routes by file-name
     prefix; the desktop doesn't need the name.
   - **Other formats:** the Mac header signatures, tried on line 1 and then line 2.
   - **Unknown:** the column-mapping sheet, which can save a preset.
4. **Parse:** `ParsedTrade[]` + `RowIssue[]` (row, reason). Nothing is dropped silently.
5. **Derive** (brand rules): session, hour, day, duration, slDist, R (§3.3).
6. **Ticket** (identical to the Mac, so re-imports and Mac-backup rows dedupe):
   - **Dojix:**
     - Use the broker ticket when the format has one: 32-column MT5, MT4, cTrader position ID,
       OANDA, IBKR trade ID.
     - Otherwise (TradingView, thinkorswim and NinjaTrader always, since "Trade #" restarts at
       1; or ticket 0) use the **content ticket**:
       SHA-256 of `symbol|direction|lots(%.8f)|openEpoch|closeEpoch|openPrice|closePrice|netProfit#<occurrence>`.
       The first 8 bytes are read as a big-endian UInt64, giving
       `8_000_000_000_000_000_000 + (v mod 10^18)`.
   - **Greenwick:**
     - Every row gets FNV-1a 64 over `"<key>#<occurrence>"`, masked to 63 bits (0 → 1).
     - Matched-row key = `<platform>|<all fields joined by |>`. FIFO key = `platform | symbol |
       buy date/price/shares | sell date/price/shares | matched shares`.
     - Broker order or ticket columns are ignored, as on the Mac.
     - Manual tickets: microsecond timestamp + random 16 bits.
   - `occurrence` counts identical rows within one file, so genuine twins are both kept.
   - The parity suite checks that tickets equal the Swift values for every F5 fixture.
7. **Validate:** §4.3.
8. **Preview / confirm:** "N trades, M already in the journal, K skipped (why)". Auto-import
   skips the dialog but records the batch.
9. **Commit (Rust):**
   - one transaction: insert, skipping existing tickets (UNIQUE as backstop);
   - the `import_batches` row;
   - **one** journal save (§6.3);
   - the `trades_changed` event.

### 5.2 Formats

| Format | Scope | Tag | Notes |
|---|---|---|---|
| **32-column MT5 CSV** (the trade-detail section of an analysis export the user already has; multi-section; 26–32 columns, short rows padded: column 31 `NEUTRAL`, the rest `0`) | FX | ADAPT | **Fix:** unquoted commas inside the Comment field (more than 32 fields) are joined back into Comment. On the Mac the columns shift. Times: §3.1 |
| MT4 CSV (`ticket,type,item,profit`; `yyyy.MM.dd HH:mm:ss`; profit includes costs) | FX | PORT | |
| cTrader CSV | FX | ADAPT | Volume in **units ÷ 100,000 = lots** (D-15) |
| OANDA CSV | FX | ADAPT | Same units fix (D-15). The OANDA API path already divides on the Mac |
| OANDA v20 API | FX | PORT | §8.4 |
| TradingView strategy export | S | ADAPT | Entry and exit rows paired by Trade # into one round trip (D-16). On the Mac each row is a trade, with direction read as "contains LONG/SHORT" |
| Interactive Brokers | S | PORT | Brand-specific mappings kept. ST falls back to `proceeds` when there is no realized P/L column (Mac behaviour; noted in Help) |
| thinkorswim | S | PORT | |
| NinjaTrader | S | PORT | Content tickets (Trade # ignored), as on the Mac |
| Webull | ST | PORT | |
| Robinhood, Schwab, Fidelity, E\*Trade, Tastytrade (transactions → FIFO round trips) | ST | ADAPT | **Same as the Mac:** costs prorated by each side's own size; shorts when the sell comes first; ET dates; FNV tickets. **Fixes** (each a DIVERGENCE): <br>• option rows skipped with a count (Mac: imported as shares without ×100); <br>• Schwab footer detected, not always dropping the last line (Mac: a file without a footer loses its last trade; a header on line 0 gives 0 trades); <br>• Fidelity's price column never falls back to column 0; <br>• unmatched buys and sells reported as skipped (Mac: logged or dropped silently); <br>• same-date sell-then-buy on date-only exports uses the file order to detect shorts (Mac: recorded as BUY); <br>• Robinhood fees read when present |
| Generic CSV + manual mapping | S | PORT | + presets |
| **MT5 Account History report** (`ReportHistory-<login>.html`, UTF-16LE; `.xlsx`) | FX | DESK | The export most MT5 users already have. Positions section; times are server time (`time_basis = 'broker'` if a broker zone is set) |
| **DojixExport CSV** (§5.3) | FX | DESK | Native UTC times |
| Mac backups | S | NEW | Restore path (§6.8) |
| Scan folder | S | ADAPT | Every supported file is imported in one queue; unsupported files are listed as skipped |

### 5.3 `DojixExport.mq5` (free, open source, GPL)

- An MT5 script (Expert Advisor) that writes `DojixExport_<login>_<YYYYMMDD>.csv` to `Common\Files`
  (`FILE_COMMON`, UTF-8, comma, CRLF).
- **Columns:** the 32-column layout above, plus `Account, Commission, Swap, TimeBasis,
  ServerUTCOffset`.
- **Content:**
  - every closed position (`HistorySelect`), any symbol;
  - MAE/MFE from M1 bars; SL distance, R, duration and slippage computed;
  - strategy-specific fields (range, sweep, FVG, bias) left empty → NULL;
  - times written in UTC.
- **Account mapping:** each MT5 account maps to an `accounts` row through `Account`.
- **Build check:** CI compiles it with MetaEditor in a nightly job (silent MT5 install on
  windows-latest). If that proves flaky, golden-output tests of a reference CSV are the gate.

### 5.4 MT5 watcher (Dojix; Windows, plus Wine on Linux)

**Where MT5 writes:**
- Per-terminal data: `%APPDATA%\MetaQuotes\Terminal\<32-hex id>\`, with `origin.txt` (UTF-16LE
  install path) and `MQL5\Files`.
- Shared: `%APPDATA%\MetaQuotes\Terminal\Common\Files\`.
- Portable installs keep `MQL5\Files` inside the install folder.

**The Mac today** watches the Wine Common Files folder **and** the default terminal's
`MQL5\Files` (or the user's custom folder instead). It scans at start, reacts to folder events,
and polls every 60 s for in-place rewrites (size + mtime). It is always on.

**Desktop design:**
- **Off by default.** Settings → MT5 → "Find MetaTrader 5" lists:
  - `Common\Files` ("all terminals");
  - each terminal's `MQL5\Files`, labelled from `origin.txt`;
  - "Add folder…" for portable installs;
  - on Linux, Wine prefixes (`~/.wine`, `~/.mt5`): the MetaQuotes `Terminal\Common\Files`
    folder under the Wine user's `AppData\Roaming`.

  Matching files are previewed before the watcher is enabled.
- **Patterns:** the 32-column export's file pattern (prefix editable, default as on the Mac)
  and `DojixExport_*.csv`. Other CSVs are listed once as "not a trade file".
- **Mechanism:**
  - `notify` (ReadDirectoryChangesW / inotify) plus a start-up scan;
  - a 60 s poll (in-place rewrites, network drives, Wine);
  - a 2 s debounce;
  - a "stable file" check (size and mtime unchanged across two reads 1 s apart). A partly
    written last line waits for the next pass.
- **Idempotent:** the `watched_files` ledger (path, size, mtime, sha256) plus tickets.
- **Strictly read-only:**
  - all watched-path I/O goes through `mt5::ro` (`list`, `stat`, `read` only);
  - a CI grep gate forbids write, rename or remove APIs in `src-tauri/src/mt5/`;
  - an e2e test runs on a deny-write ACL folder.
- **Feedback:** a toast plus an optional OS notification. The batch appears in Import history
  as `mt5_watch`.
- **Multiple accounts:** the 32-column export writes one file name per day for every account,
  so two terminals overwrite each other (the UI says so). `DojixExport` files carry the
  account.


## 6. Storage, encryption and App Lock

The Mac apps were hardened heavily for their open-source release. The desktop app keeps the
same **security properties**. Where the mechanism has to change, because there is no macOS
Keychain, no `F_FULLFSYNC` and no AppKit, the change and the reason are given in the text and
listed in PARITY.md. The earlier plan (page-level database encryption with SQLCipher) is
**dropped**: the Mac design is simpler to audit and never writes plaintext pages, a WAL file
or temp files to disk.

### 6.1 Properties that must hold (same as the Mac apps)

1. **No plaintext journal ever touches the disk.** The database lives in memory only. After
   every committed write transaction, its whole image is sealed (AES-256-GCM) and written
   atomically. No WAL, no rollback journal, no temp file and no "copy before restore" is ever
   written in plaintext.
2. **A save is durable before it counts.** The sealed file is flushed to stable storage and
   renamed into place, and the folder is flushed, *before* the save generation is recorded
   and before the UI is told the write succeeded.
3. **App Lock protects the data, not just the screen.** With App Lock on, the journal key is
   stored only wrapped with a key derived from the password. Someone who copies the data
   folder *and* reads the credential vault still needs the password.
4. **Rollback (older-copy) protection.** Every save is numbered inside the sealed file's
   authenticated header and in the credential vault. An older copy put back on disk is never
   opened silently.
5. **Crash-safe key rotation.** Turning App Lock on and changing the password both rotate to
   a new key in three crash-safe steps. The old key is deleted only after the journal, every
   stray copy and every screenshot open with the new key.
6. **Fail closed on unreadable secrets.** An item that exists but can't be read is never
   treated as "absent". That holds for the lock state, the key, and the wrong-password count
   and its wait. A key is never generated over an unreadable one.
7. **Idle auto-lock.** Off / 1 / 5 / 15 / 30 / 60 minutes, **default 15**, plus the OS
   moments when a computer is left alone (see 6.7).
8. **Wrong-password throttle, persisted, fail closed.** One counter is shared by the lock
   screen, the older-copy screen and Settings.
9. **One running copy per data folder.**
10. **Restores are rebuilt from validated rows.** A backup file is never copied over the
    journal.
11. **Screenshots are sealed with the journal key** and decrypted into memory only. Nothing
    is decrypted or written while the app is locked.
12. **No password recovery.** A forgotten App Lock password means "Erase all local data", then
    restore a backup.

### 6.2 Data folder

Data folder = Tauri `app_local_data_dir()`. It is never the roaming profile, because a file
that roams with the profile can be replaced by an older synced copy.

| OS | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\io.github.djctwo.dojix\` (or `…greenwick\`) |
| Linux | `$XDG_DATA_HOME/io.github.djctwo.dojix/` (default `~/.local/share/…`) |

The identifiers differ on purpose from the Mac bundle IDs (`com.dojix.app`,
`com.greenwick.app`). A future macOS build of this codebase could then never open, or lock,
the native apps' data.

Contents:

| Name | What |
|---|---|
| `journal.sealed` | The sealed journal (6.3) |
| `journal.lock` | Empty file holding the single-instance OS lock (6.9) |
| `screenshots/<trade_id>/<uuid>.sealed` | Sealed screenshots (6.10) |
| `snapshots/` | Automatic sealed snapshots: before a migration, plus daily, keep 7 (6.8) |
| `set-aside/` | Files that failed to decrypt or are not a database. They are moved here, never deleted |
| `logs/` | Rotating, redacted logs (no trade data, keys, prices or paths) |
| `prefs.json` | Settings that must be readable while locked (6.11). Holds no trading data |
| `key.wrapped` | Linux without a Secret Service only: the wrapped key (6.4) |
| `local-records/` | Linux without a Secret Service only: the rollback record and the throttle (6.4) |

**The web view's own files are never in the data folder.** WebView2 and WebKitGTK keep
caches, cookies and IndexedDB as plain SQLite databases, so the main window gets its own
folder, `<cache dir>/<identifier>.webview` (`%LOCALAPPDATA%` on Windows, `~/.cache` on
Linux; a sibling `<data-dir>.webview` with `--data-dir`), and runs in private (incognito)
mode so most of that never reaches a disk. The e2e suite checks both the scratch and the
default data folder for the SQLite magic. (Phase 6: the uninstaller's "Remove my journal
data" must remove that folder too.)

`--data-dir <path>` (or `DOJIX_DATA_DIR` / `GREENWICK_DATA_DIR`) and `--vault-service <name>`
override the folder and the vault namespace **in debug and `e2e` builds only**. Release
builds ignore them, the same rule as the Mac apps. All tests and agents run with a scratch
folder and a scratch vault namespace.

**File permissions.**
- Linux: files are created `0600` and folders `0700`.
- Windows: the data folder gets an explicit DACL (owner + SYSTEM, inheritance off), set at
  creation and checked at launch. `%LOCALAPPDATA%` is already per-user, but an explicit DACL
  doesn't depend on how the profile was set up.

### 6.3 Journal file format and save path

```
"DXJN" | version u8 (=1) | brand u8 (1 dojix, 2 greenwick) | epoch [16] | generation u64 BE
       | saved_at i64 BE (Unix ms) | AES-256-GCM box: nonce [12] | ciphertext | tag [16]
```

- The 39-byte header is the AES-GCM associated data, so changing any header byte breaks
  decryption.
- This is the same construction as the Mac's `DJXJ` / `GWJN`. The magic is new because the
  payload is the desktop schema, not the Mac's.
- The plaintext is a SQLite database image (`sqlite3_serialize`, via rusqlite's `serialize`
  feature).
- The key is 32 random bytes from the OS CSPRNG. Key material is held in `zeroize` buffers and
  wiped on lock.

**Open.**
1. Read the file and parse the header.
2. Check the rollback verdict (6.5) **before** decrypting into the app.
3. Decrypt, check the SQLite magic, `sqlite3_deserialize` into an in-memory connection, then
   run migrations.
4. If the file opens only with the *previous* key (a rotation is pending), re-seal it with the
   new key.
- Only a file that fails to decrypt, or isn't a database, is moved to `set-aside/`. Any I/O or
  permission error leaves it in place and shows a message, never a fresh empty journal.

**Connection settings.** `journal_mode=MEMORY`, `temp_store=MEMORY`, `foreign_keys=ON`. No
attached or on-disk databases.

**Empty image.** Before the first serialize, the in-memory database is forced to contain page
1 (`CREATE TABLE x(y); DROP TABLE x; VACUUM`). Some SQLite versions serialize a never-written
database as 0 bytes; the Mac apps hit this on macOS 14/15 and fixed it the same way. There is a
unit test for it.

**Save** (Rust, on the single writer thread, after every successful write transaction):
1. Serialize, then seal with generation = last + 1 and the current epoch.
2. Write it with the secure writer:
   - a random temp name in the same folder;
   - create-new (`O_CREAT|O_EXCL|O_NOFOLLOW`, `0600` on Linux; `CREATE_NEW` + the owner-only
     DACL on Windows);
   - write the bytes;
   - flush the handle (`fsync` on Linux, `FlushFileBuffers` on Windows);
   - rename over `journal.sealed` (`rename(2)` on Linux; `MoveFileExW` with
     `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` on Windows);
   - flush the folder (Linux `fsync` on the directory fd; on Windows, write-through on the
     rename).
   The file is never reopened or `chmod`ed by path.
3. Record the new stamp + SHA-256 of the sealed bytes in the vault (6.5). A failed vault
   write is logged and never fatal, as on the Mac.
4. Only then resolve the IPC call that made the change.

A save that fails (for example, a full disk) leaves the journal open in memory and raises the
"Database issue" banner. The failure is never silent. If a lock happens while a save is
failing, the decrypted journal is **held** in memory behind the lock screen and saved again at
the next unlock. Quitting with unsaved changes asks first (*Try again / Quit anyway*). This is
Greenwick's behaviour, adopted for both brands.

**Cost.** Each commit rewrites the whole sealed image, as on the Mac. Imports are one
transaction, so they make one save. Budget: seal + durable write of a 20 MB image (about 50k
trades) in under 250 ms on the CI runners, measured with fixture F9.

### 6.4 Keys and the credential vault

The vault is the Rust `keyring` crate.
- **Windows:** Credential Manager, generic credentials (DPAPI, per user).
- **Linux:** Secret Service (GNOME Keyring / KWallet).

Service = the brand identifier. Items:

| Account | Content |
|---|---|
| `database_encryption_key` | The bare key (App Lock **off** only) |
| `database_key_wrapped` | App Lock **on**: `"DXKW" \| version \| kdf id \| kdf params \| salt [16] \| AES-GCM box of [current key, previous key?]`, header as associated data |
| `journal_save_generation` | Rollback record, `v1:<epoch hex>:<generation>:<saved_at ms>:<sha256 hex>` |
| `lock_failed_attempts`, `lock_lockout_until` | Throttle (6.6) |
| `anthropic_api_key`, `twelve_data_api_key`, `polygon_api_key`, `oanda_api_token`, `oanda_account_id`, `finnhub_api_key` | User API keys (brand-dependent) |

**Lookup has three outcomes.** `lookup()` returns `Found(v)`, `Absent` (only the backend's
"not found") or `Failed(code)`. Every decision about lock state, key creation, throttling and
erasing is made on `lookup`, and `Failed` is fail-closed (6.1 item 6).

**Writes.** Writes replace in place (never delete, then add). Every key transition writes the
new form, reads it back, checks that it unwraps to the same key, and only then deletes the old
form.

**KDF.** Argon2id with m = 64 MiB, t = 3, p = 1, a 16-byte salt and a 32-byte output. Parameters
are read from the header and refused outside a sane range (m 8–1024 MiB, t 1–20, p 1–8). This
guards against a tampered item asking for no work, or for hours of it, just as the Mac refuses
iteration counts outside 1,000–10,000,000.
- **This differs from the Mac,** which uses PBKDF2-SHA256 with 600,000 iterations. App Lock
  items never leave the machine, so there is no compatibility constraint, and a memory-hard KDF
  costs an offline attacker more for the same unlock delay.
- PBKDF2-SHA256 is still implemented, to read Mac backups (6.8).

**The keys never enter the web view.** There is no IPC command that returns a key or a secret:
only `set_secret`, `has_secret`, `delete_secret` and `test_connection`.

**Platform differences** (stated in SECURITY.md):
- **Windows.** Credential Manager has no per-application access control. Any process running
  as the same Windows user can read a generic credential. The macOS Keychain can attach an ACL
  to an item, but the unsigned Mac builds get little from that. In practice it's the same
  boundary the Mac SECURITY.md already states: with App Lock **off**, anyone, or any malware,
  running as the user can open the journal. With App Lock **on**, the vault holds only the
  wrapped key, and the password is still needed.
- **Linux with no Secret Service** (headless, minimal window managers):
  - **When this mode is chosen:** a data folder that already uses it (`key.wrapped` exists)
    keeps it. Otherwise, a *new* data folder (no `journal.sealed`) uses it when the Secret
    Service can't be reached or doesn't answer a lookup. A folder that already holds a journal
    never switches: an unusable vault then fails closed, as everywhere else.
  - App Lock becomes **mandatory**. The first launch asks for a password before any key or
    journal exists. The wrapped key is stored in `key.wrapped` in the data folder, because
    there is no vault to hold it; App Lock can't be turned off. This store refuses a bare
    journal key and API keys.
  - Rollback protection and the throttle counter can't be kept outside the data folder. The
    app says so in Settings → Security and in SECURITY.md.
  - Nothing is ever stored as an unencrypted journal.

### 6.5 Rollback (older-copy) protection

Same rules as the Mac (`SaveGenerationStore` / `JournalLedger`).

**On load**, the file's stamp is compared with the vault record. The file is refused (an
`OlderJournal` error, nothing decrypted into the app, file untouched) when it has:
- a lower generation;
- a different epoch;
- or the same generation but a different SHA-256.

A file newer than the record in the same epoch opens. That can happen when the last vault
write failed.

**When it is checked:** at launch, before the lock screen, and again at every unlock (the
file may have been replaced while the app was locked).

**Older-copy screen.** It explains what happened. The file opens only after:
- the App Lock password (lock on, through the shared throttle);
- or an explicit confirmation (lock off).

A confirmed open starts a **new epoch** at generation max(record, file) + 1. The count never
goes down.

**Record failures.**
- A record that can't be read or is damaged means any file is accepted. This is logged; it is
  the Mac behaviour.
- A failed record write is logged, never fatal.
- "Erase all local data" deletes the record.

### 6.6 App Lock

**Password rule.** 8–128 characters (Unicode scalar count) and must be confirmed. The same rule
applies to backup passwords. This is Dojix's `PasswordRules`; Greenwick's Mac app has the
8-character minimum but no maximum.

**Operations.** Enable, Change password, Disable (needs the current password), Unlock, and
Erase. They run through **one gate**:
- one key operation at a time; another request gets a `busy` error;
- the lock screen disables its buttons while one runs;
- a second unlock (for example from a second window) is refused while one runs;
- after every async step, the code re-checks that it is still unlocked and that the same
  journal is open.

**Lock deferral.** A lock requested while Enable or an Unlock is running happens as soon as
that operation ends. Disable changes the vault only if no lock happened during its password
check.

**State in memory.** Whether App Lock is on is kept in memory, set by these operations. It is
never re-read from the vault to decide whether to lock.

**An unlock that finds no wrapped key and no legacy item** opens the journal as a lock-off
launch would. This way a failed Enable never leaves behind a lock screen that rejects every
password. The exception: while a journal is *held* (6.3), it stays locked and says the vault
is unreadable.

**Throttle** (identical schedule to both Mac apps):
- attempts 1–4: no wait (the message shows "n/5");
- 5th: 30 s · 6th: 60 s · 7th: 5 min · 8th: 15 min · 9th and later: 30 min.

The count and the wait end are stored in the vault and survive a relaunch. While either exists
but can't be read, **no password is checked** and nothing is written, so the count is never
restarted. The throttle is shared by the lock screen, the older-copy screen and Settings
(Change password, Disable). A right password resets it.

**Locking.** It saves the journal, then:
- drops the in-memory database and the key (zeroized);
- clears the screenshot key;
- closes dialogs and sheets;
- tells the web view to drop every cached query and navigate to the lock route.

The web view's JavaScript heap can't be zeroed on demand. The UI therefore keeps journal rows
only in TanStack Query caches, which are cleared on lock, and the lock route is rendered in a
fresh document (`location.replace`). This differs from the Mac: SwiftUI views are gone once the
lock cover is up.

**Forgot password?** Offers **Erase all local data** only. There is no recovery copy: this
matches the shipped, unsigned Mac builds, where both apps end up at "erase".
- On Windows, the erase first asks for Windows Hello or the account password
  (`UserConsentVerifier`), where available. This matches Greenwick's device-owner check.
- On Linux, the erase needs the user to type the app name.
- Erase is refused while any key item reads `Failed`. It waits for running key operations.
  It deletes `journal.sealed` by path and checks it is gone **before** removing any key, then
  removes snapshots, set-aside files, screenshots, the rollback record and the throttle items.

### 6.7 Auto-lock triggers

| Trigger | Windows | Linux |
|---|---|---|
| Idle time without keyboard/mouse input **in the app** (setting; default 15 min) | Web view input events + window focus events → Rust idle timer (injectable clock, checked every 5 s) | same |
| OS session locked | `WTSRegisterSessionNotification` → `WTS_SESSION_LOCK` | logind `Lock` signal / `org.freedesktop.ScreenSaver.ActiveChanged` (best effort) |
| Sleep / suspend | `WM_POWERBROADCAST` `PBT_APMSUSPEND` | logind `PrepareForSleep(true)` |
| User switch | `WTS_CONSOLE_DISCONNECT` / `WTS_SESSION_LOGOFF` | logind session `Active=false` |
| Window minimized | Tauri window event | same |

Linux triggers depend on the desktop environment, and the Linux docs say so. The idle timer
and minimize always work.

### 6.8 Backups, restores and snapshots

**Export Backup**, with a password (recommended; on by default when App Lock is on) or
without one:

```
"DXBK" | version u8 (=1) | kdf id u8 (1 = Argon2id) | m KiB u32 | t u32 | p u8 | salt [16]
       | AES-256-GCM box of the SQLite image (header = associated data)
```

- A backup without a password is the plain SQLite image. The UI says it is unencrypted.
- The image is a snapshot of the in-memory journal (`serialize`), never a file copy.
- Backups don't include screenshots, only their file names. This matches the Mac.

**Restore accepts:**

| File | Read as |
|---|---|
| `DXBK` (this app), plain SQLite with the desktop schema | native |
| Dojix `DJXB` (PBKDF2-SHA256, iterations from the header, accepted 1,000–10,000,000; 25-byte header as associated data) | Mac Dojix backup → mapping (§4.4) |
| Dojix 1.x `DOJX` (16-byte salt, PBKDF2 100,000, no associated data) | same |
| Greenwick `GWBK` v2 (`"GWBK" \| 0x02 \| rounds u32 \| salt length u8 (=16) \| salt`, 26-byte header as associated data; PBKDF2-SHA256, rounds 1–10,000,000) | Mac Greenwick backup → mapping |
| Greenwick legacy `SJNL` (16-byte salt, PBKDF2 100,000, no associated data) | same |
| Plain SQLite with a Mac Dojix or Greenwick schema | the matching Mac mapping |

**Restore pipeline** (never copies a file over the journal):
1. Decrypt in memory and open it as a read-only in-memory database.
2. Identify the schema: desktop, Mac Dojix or Mac Greenwick. Desktop backups must have a known
   migration list no newer than this build.
3. Check every row with the same storage validation as an import (`storageViolations`, §4.3),
   and reject the file if any row fails. The error names the row and the field.
4. Replace all rows in **one** transaction. Save. If the swap or the save fails, the previous
   contents go back into memory.
5. Rows from a Mac backup keep their tickets, so a later re-import of the same broker file
   dedupes against them.

**Automatic snapshots** (desktop addition):
- Taken before each migration, and daily while the app is open; the last 7 are kept.
- They are sealed with the journal key, so a key rotation re-seals them (as stray copies on
  the Mac).
- They are restored only through the validated restore pipeline, never by renaming them into
  place.
- A restore first keeps a `pre-restore-…` snapshot of the journal as it was.

**Restoring a Mac backup** replaces the trades and strategy checkpoints and upserts the Mac
settings keys; the desktop-only tables (watchlist, checklist rules, mapping presets, import
history, AI reports) are kept. The restore is recorded as one `import_batches` row with origin
`mac_backup`. Unknown MAE/MFE stays 0 for these rows (the Mac stored 0, so "unknown" can't be
told apart).

### 6.9 Single instance

- `journal.lock` is held with an exclusive OS lock for the life of the process: `LockFileEx` on
  Windows, `flock` on Linux (`fd-lock` crate).
- A second process for the same data folder shows "Dojix is already open" and opens nothing.
  `tauri-plugin-single-instance` also focuses the first window.
- Where the folder doesn't support locks (some network or FUSE mounts), the app opens anyway
  and the docs say so. This is the Mac behaviour.
- "Quit & relaunch" (on the database-failed screen) releases the lock first.

### 6.10 Screenshots

- **Input:** PNG or JPEG, by drag-drop or file dialog. At most 10 per trade; each input file is
  limited to 25 MB and 100 megapixels.
- **Processing:** decoded in Rust (`image` crate, bounded allocations) and re-encoded as JPEG
  (quality 85). Re-encoding strips metadata and blocks polyglot files. Each file is named
  `<uuid>.sealed`; the user's path is never stored.
- **Format:**
  `"DXSC" | version u8 | AES-256-GCM box`, with the header **and the file name** as associated
  data. This is Greenwick's `GWSC` construction, which is stronger than Dojix's `DJXS` (that
  one has no associated data). Both brands use it.
- **Phase split:** 1S ships the format, storage, read-back, lock gating and the re-seal on
  key rotation (`screenshots.rs`). The ingest (decode, re-encode, size limits) and the
  `screenshot_*` IPC commands arrive with the trade-detail screen in phase 3.
- **Behaviour:**
  - Every write goes through the secure writer and is read back.
  - Images are decrypted into memory only and served to the web view as `blob:` URLs, which
    are revoked on lock.
  - While locked there is no key: nothing is decrypted or written.
  - Writes and key switches share one file lock. A rotation re-seals every file, and a file
    that still needs the old key keeps that key stored (6.1 item 5).

### 6.11 What lives where

| Data | Where | Why |
|---|---|---|
| Trades, notes, tags, emotions, checklists, checkpoints, prop-firm parameters, **watchlist, checklist rules**, AI reports, import history, column-mapping presets | Encrypted journal (`settings` table and dedicated tables) | They describe the user's trading |
| Idle-lock minutes, window size, collapsed sections, last tab, Essential mode, update-check toggle, display time zone | `prefs.json` (plain) | Needed while locked, or harmless |
| Keys, rollback record, throttle | Vault | 6.4 |

On the Mac, the watchlist and checklist rules sit in the plain preferences file (both
SECURITY.md files say so). Moving them into the journal is an intentional improvement and is
listed in PARITY.md.

## 7. Architecture

### 7.1 Stack

**Tauri 2 + React 18 + TypeScript, with a Rust shell and a pnpm workspace.** This choice is
unchanged from the first draft.
- **Small installers.** About 10 MB.
- **The browser engine is patched by the OS.** Windows ships WebView2 and updates it; Linux
  uses WebKitGTK.
- **Signed updates are built in.**
- **The real app can be tested on GitHub's Windows and Linux runners** with official WebDriver
  tooling.
- **The math and the screens are TypeScript.** The Rust side stays small: storage and crypto,
  the vault, the network, file I/O and the MT5 watcher.

**Escape hatch.** `packages/core`, `packages/importers` and the React UI don't depend on Tauri.
Only `apps/desktop/src/ipc.ts` and `src-tauri/` do, so moving to another shell would mean
replacing those two pieces.

**Accepted trade-offs:**
- WebKitGTK on Linux is a tier-2 target (Ubuntu 22.04+, Debian 12+, Fedora 39+).
- Rust adds CI build time; it is cached.

### 7.2 Repository layout

```
dojix-desktop/
├─ LICENSE (GPL-3.0) · NOTICE · README.md · CONTRIBUTING.md · SECURITY.md · CODE_SIGNING_POLICY.md
├─ CLAUDE.md                          # contributor/agent rules (public)
├─ docs/{SPEC,DECISIONS,PARITY}.md
├─ packages/
│  ├─ core/        # PURE TS: model types, swiftcompat (idiv, printfFixed, stable sorts, max-by-last),
│  │               # calendars (fx-local, us-equities-et), sessions, every formula, analytics registry models
│  ├─ importers/   # PURE TS: encoding sniff, CSV tokenizer, detectors, per-format parsers, FIFO engine,
│  │               # content tickets, storage validation (shared with restore)
│  ├─ ai-prompts/  # PURE TS: prompt builders per brand, "what is sent" preview
│  └─ ui/          # React components: cards, charts (ECharts), tables (TanStack Table/Virtual), brand tokens
├─ apps/desktop/
│  ├─ src/                    # app shell, routes, TanStack Query over IPC, Web Worker for analytics
│  │  ├─ ipc.ts               # the ONLY file importing @tauri-apps/api
│  │  └─ help/<brand>/*.md
│  ├─ src-tauri/
│  │  ├─ src/{main, commands/*, journal/{store,seal,ledger,migrate,restore,snapshot}, vault, lock/{gate,throttle,idle,triggers},
│  │  │        screenshots, net/*, mt5/{discover,ro,watch}, backup, updater, logging, selftest}.rs
│  │  ├─ migrations/*.sql
│  │  ├─ tauri.conf.json · tauri.dojix.conf.json · tauri.greenwick.conf.json
│  │  └─ capabilities/main.json
│  ├─ e2e/          # WebdriverIO + tauri-driver (real binary)
│  └─ playwright/   # fast UI specs, mocked IPC
├─ brands/{dojix,greenwick}/   # brand.ts, icons, tokens, demo templates, prompt pack, help bundle
├─ golden/{fixtures,reference,swift-tests,divergences.yaml,README.md}
├─ tools/{fixture-gen,swift-ref,parity-check,release}/
├─ mql5/{DojixExport.mq5,DojixPriceFeed.mq5}
└─ .github/workflows/{ci,e2e,installers,parity-reference,nightly-hunt,release,codeql}.yml
```

Parallel teams work in git worktrees under `../dojix-desktop-wt/<team>`, one branch each.
`main` is protected, and a pull request merges only when CI is green.

### 7.3 Brands

**A build-time brand.** `BRAND=dojix|greenwick` sets:
- the Vite define, so the other brand's modules are tree-shaken out;
- the Cargo feature `brand-dojix` / `brand-greenwick` (the MT5 code compiles only into Dojix);
- the Tauri config overlay.

**One installer per brand.**

**`BrandConfig` fields:**
- `id`, `productName`, and `identifier` (`io.github.djctwo.dojix` / `io.github.djctwo.greenwick`);
- `tokens`: Dojix gold `#E8B44C` on `#0E0D0B`; Greenwick teal `#00D4AA` on `#0C0D0E`;
- `instrument`: {qtyLabel Lots/Shares, moveUnit pips/points, symbolNoun Pair/Ticker};
- `calendar`: `fx-local` (the user's zone; see §3.1) or `us-equities-et` (fixed America/New_York);
- `sessionModel`, `importers[]`, `analyticsRegistry`, `sidebar`, `liveProviders[]`,
  `promptPack`, `helpBundle`, `demoTemplates`.

**Analytics registry entries.** Each is `{id, brands, tab, minTrades, compute(ctx, trades) →
model, view}`. `compute` lives in `packages/core`, so it can be tested headless.

Debug builds also get a brand switcher, for agents and screenshots.

### 7.4 Process model and IPC

**The Rust process owns all state:**
- the single in-memory SQLite connection, on one writer thread with a command queue;
- the key and the vault;
- every file and network operation.

**The web view** holds rendered content and the trade rows it needs to draw charts.

**IPC is a small, typed command set**, and every command validates its arguments in Rust:
- **Journal:** `journal_query` (filters → rows), `journal_mutate` (add / edit / delete / notes /
  tags / emotion / checklist / costs), `import_preview`, `import_commit`.
- **Settings and data:** `settings_get`, `settings_set`, `backup_export`, `backup_restore`,
  `erase_all`.
- **App Lock:** `lock_status`, `lock_unlock`, `lock_setup` (no keyring), `lock_enable`,
  `lock_change`, `lock_disable`, `lock_now`, `lock_activity` (idle timer), `older_copy_open`,
  `prefs_set_idle`, `save_retry`, `app_quit`.
- **Backups:** `backup_export`, `backup_pick` (step 1: the file dialog opens in Rust and the
  path stays there), `backup_restore` (step 2).
- **Screenshots:** `screenshot_add`, `screenshot_get`, `screenshot_delete`.
- **Secrets and network:** `set_secret`, `has_secret`, `delete_secret`, `test_connection`,
  `ai_preview`, `ai_run`, `quotes_*`, `calendar_week`.
- **MT5 (Dojix only):** `mt5_discover`, `mt5_watch_set`.
- **App:** `updates_check`.

Events: `trades_changed`, `locked`, `unlocked`, `save_failed`, `import_progress`,
`quote_tick`.

**Analytics.** They run in a Web Worker over the in-memory trade array. The budget is about 10k
trades in under 300 ms per tab, enforced with fixture F9.

**Test-only commands** (`e2e_status`, `e2e_add_trade`, `e2e_set_idle_seconds`,
`e2e_backup_export`, `e2e_backup_pick`; later `__test_set_now`, `__test_import_path`,
`__test_vault_fail`, updater endpoint override) exist only behind the Cargo feature `e2e`. The release job scans the binary
to prove they are absent.

## 8. Online features (all optional, off by default, user's own keys)

### 8.1 Network rules

**General:**
- Only Rust makes network calls.
- HTTPS / WSS only, with a per-provider host allow-list. Redirects are allowed only to the same
  host over HTTPS. Nothing is cached on disk.
- The OS trust store is used through `rustls-platform-verifier`.

**No certificate pinning.** Dojix's Mac app removed its pins in the open-source release.
Greenwick's Mac app still pins the CA keys for two hosts. The desktop app doesn't pin at all:
- a pin can't be hot-fixed in an installed open-source desktop app;
- the earlier Mac pins broke when providers rotated certificates.

This is a logged difference for Greenwick.

**Keys go in headers wherever the provider allows it:**
- Anthropic `x-api-key`; Finnhub `X-Finnhub-Token`; OANDA `Authorization: Bearer`;
- Twelve Data REST `Authorization: apikey …`. The Mac app sends this one in the URL query.
- Twelve Data WS and Polygon need the key in the subscribe or auth message, as on the Mac.

There is no telemetry, and failures while offline are silent.

### 8.2 AI recommendations (both brands)

**Gates.** A key in the vault **and** an explicit "Allow AI analysis" switch, which is off by
default. Greenwick's Mac app has this switch; Dojix's gates on the key plus the click. Both
brands get the switch.

**What is sent.** Aggregated statistics only: totals, plus P&L and win rate by session, hour,
day, pair/ticker, and for Dojix also bias and volatility. Never individual trades, tickets,
notes or account details.
- The prompt builders are ported unchanged, so the content equals the Mac prompt for the same
  trades.
- Greenwick's prompt also adds R-multiple counts, win/loss durations and a position-size
  section (average, maximum and minimum shares, when the maximum is more than 2× the average).
  Its Mac "what is sent" text doesn't mention the size section; the desktop text and preview
  do.

**Preview and consent.** An exact preview of the request ("Show what will be sent") is
available before every run. The first run needs consent.

**Model.**
- The default is the brand's Mac default: `claude-opus-5-5` for Dojix, `claude-sonnet-5-5`
  for Greenwick.
- The request matches the Mac's: `anthropic-version: 2023-06-01`, and for Dojix server-side
  fallback, effort "medium", `max_tokens` 16000, a 300 s timeout.
- Settings → AI has an "Advanced: model" picker filled from the provider's model list, for
  when a default is retired.

**Results** are saved in the journal (`ai_reports`) and shown as a history. The Mac apps keep
them only in memory, so this is a logged difference.

### 8.3 Live data

**Dojix: Pulse and the sidebar ticker.** Sources:
- Twelve Data REST (poll every 120 s; a daily request counter persisted per day, which the Mac's
  per-instance counter doesn't enforce);
- Twelve Data WebSocket;
- Polygon WebSocket (the provider's current endpoint name is checked at build time);
- OANDA pricing stream;
- **MT5 file:** `DojixPrices.json` written by `DojixPriceFeed.mq5` into MT5's
  `Terminal\Common\Files` (capped at 256 KB, tolerant of half-written files, symbols normalised).

Streams reconnect with exponential backoff, at most 10 tries. Streaming prices are rendered, as
on the Mac today.

**Economic calendar** (Dojix): the public weekly JSON at `nfs.faireconomy.media`.
- Content-type check; refresh checked every 2 min and reloaded every 15 min.
- Danger zones are ±15 min around high-impact events.
- It sits behind a Settings toggle (on by default) with a source label, and the app works
  without it.
- **Fix:** the Pulse edge signal recomputes when the hour or session changes and when the
  calendar arrives. The Mac computes it once, when the screen appears, so it can miss the
  danger-zone penalty.

**Greenwick: Browse and Watchlist.** Finnhub quote, profile and symbol search, using the user's
key. A 30 s cache is shared between screens.

### 8.4 OANDA history import (Dojix)

- Same endpoints as the Mac: account summary, plus `transactions?type=ORDER_FILL&from=…` with
  page URLs.
- Practice or live host. Every URL, page URLs included, must be HTTPS on `oanda.com` /
  `*.oanda.com`.
- The account ID must match `[A-Za-z0-9-]{1,64}`.
- The default window is 90 days, and it can be changed.
- Units ÷ 100,000 = lots, as the Mac API path already does.

## 9. Updates, installers and CI

### 9.1 Updates (GitHub Releases)

- **One version number for both brands, and one GitHub Release per version**, with:
  - per brand: NSIS `.exe`, `.msi`, `.AppImage`, `.deb`, `.rpm`, plus `.sig` updater signatures;
  - `dojix-latest.json`, `greenwick-latest.json`;
  - `SHA256SUMS`, a CycloneDX SBOM, and build-provenance attestations.
- **Updater endpoint:** `releases/latest/download/<brand>-latest.json` on the project
  repository. The minisign signature is verified on every update.
  - The update-signing private key exists only as a GitHub Actions secret plus an offline
    copy held by the maintainer. If it is lost, existing installs can never update.
- **UX:**
  - A check at launch, at most once a day (Settings toggle, default on).
  - The prompt shows the release notes. Nothing installs silently.
  - Windows uses `installMode: passive`. The AppImage updates in place; deb/rpm users get a
    link.
- **Before an update installs**, the journal is saved and a snapshot is taken.

### 9.2 Installers

- **Windows NSIS:**
  - per-user (`currentUser`), so no admin is needed;
  - embedded WebView2 bootstrapper;
  - Start-menu entry;
  - the uninstaller **keeps the journal** unless "Remove my journal data" is ticked. Even then it
    deletes vault items only for this brand's service.
- **Windows MSI:** per-machine, for IT departments and winget. A stable upgrade code.
- **Targets:** x64 at launch. ARM64 (`windows-11-arm` runner) is nice-to-have.
- **Linux:** built on `ubuntu-22.04` (the glibc floor). AppImage, `.deb`, `.rpm`. Depends on
  WebKitGTK 4.1.
- **Signing:** an optional `sign-windows` CI step that runs only when signing secrets exist.
  Unsigned builds work fully. The README explains the SmartScreen "More info → Run anyway"
  prompt and the winget route.

### 9.3 CI (GitHub Actions; public repository)

| Workflow | Trigger | Jobs |
|---|---|---|
| `ci.yml` | every PR / push | Matrix {windows-latest, ubuntu-22.04}: <br>• pnpm install (frozen lockfile), typecheck, ESLint <br>• **vitest** (core, importers, ai-prompts, ui) <br>• **parity-check** <br>• `cargo fmt` / `clippy` / `test`: journal seal/open vectors, ledger verdicts, rotation crash points, throttle, vault mock with injected `Failed`, secure writer, restore validation, Mac backup vectors `DJXB` / `DOJX` / `GWBK` / `SJNL`, MT5 discovery on fake trees <br>• licence check (`cargo-deny`, `license-checker`; GPL-compatible only), `pnpm audit` + `cargo audit`, gitleaks, Semgrep |
| `e2e.yml` | every PR (after ci) | Builds both brands (release profile + `e2e` feature) on Windows and Linux. <br>• Playwright UI specs with mocked IPC (visual baselines) <br>• WebdriverIO + tauri-driver real-binary specs |
| `installers.yml` | PRs touching packaging + nightly | **Windows:** <br>• silent NSIS install `/S` → `--self-test` → seed data → install v(N+1) over it → data intact → uninstall (data kept) → reinstall <br>• MSI the same with `msiexec /qn` <br>• NSIS + MSI conflict check <br>**Linux:** AppImage under xvfb; `.deb` in a clean container |
| `nightly-hunt.yml` | nightly | • Property / fuzz tests: fast-check, 100k cases per parser and for the journal/backup/screenshot decoders <br>• TZ and locale matrix <br>• Updater e2e: local HTTPS feed, upgrade, data intact, tampered signature rejected <br>• MetaEditor compile of the `.mq5` files <br>• 100k-trade performance <br>• Crash-injection runs (kill the process at each save/rotation step, then reopen) |
| `parity-reference.yml` | manual | Swift reference harness on macOS (§10) → bot PR |
| `codeql.yml` | weekly + PR | CodeQL JS/TS (+ Rust) |
| `release.yml` | tag `v*` | `tauri-action` matrix, updater signing, optional Authenticode, `*-latest.json`, SBOM, attestations. Creates a **draft** release, which is published only when `installers.yml` passes on those exact artifacts |

**Rules:**
- Actions are pinned by full SHA; Dependabot runs weekly.
- `--self-test` in release builds runs these checks, prints JSON and exits; installer tests use
  it:
  - vault reachable;
  - data folder DACL/mode correct;
  - lock file takeable;
  - a seal → open round trip in memory.

  It never opens the user's journal.

## 10. Golden-number parity

### 10.1 Goal and equality rule

Identical fictional input must produce identical numbers in the Swift app and the desktop app.
That covers the headline metrics and every component output; anything that differs needs an
approved DIVERGENCE entry.

**Equality:**
- Integers, counts, strings and labels: exact.
- Doubles: |a−b| ≤ 1e-9·max(1,|a|).
- ±∞ must match ±∞.
- Formatted strings are tested separately with en-US vectors.

### 10.2 Where reference numbers come from

**Tier A — Swift unit-test expectations** (read, not run):
- **Dojix** has 374 unit tests in 35 files (MetricsCalculator, TradeGrader, CSVParser,
  GenericCSVParser, TradeModel, Formatting, AnalyticsComponent, AnalyticsClamp,
  ReimportDedupe, SampleFileCrossCheck, OANDAService, …).
- **Greenwick** now has unit tests too: 202 in 22 files (ImportParser, TradingDay with ET days,
  DST and time-zone independence, HostileValue, SampleTrades, RestoreValidation, …). It has no
  dedicated MetricsCalculator or component test file, so Tier B carries more weight there.
- Their fixtures and exact expected values are ported to `golden/swift-tests/*.json` test for
  test. Values the tests don't assert but that follow directly from the formulas are added and
  marked `derived`.
- Tests that re-implement a formula inside the test rank below Tier B.

**Tier B — Swift reference harness on GitHub's macOS runners** (authoritative):
- `parity-reference.yml` (manual trigger) runs on `macos-15` with **Xcode 16.4 pinned**, the
  same image the Mac apps' own CI uses.
- It checks out the public repositories **djctwo/dojix** and **djctwo/greenwick** at
  **pinned commit SHAs**. At the time of writing:
  - djctwo/dojix `614bd6a0bd85adcbb0a8a48891c7fa708a6b2605` (1.0.0 + CI fixes)
  - djctwo/greenwick `64495e28b0c9a8016ea86adf43098a569307e074` (1.0.1)

  Moving a pin is its own pull request. It regenerates the references and shows the diff.
- It copies the computational sources into a throwaway SwiftPM command-line target under
  `tools/swift-ref/`. GRDB is pinned to the same commit the apps pin
  (`b83108d10f42680d78f23fe4d4d80fc88dab3212`). The sources:
  - Models, MetricsCalculator, the parsers;
  - `Date+Forex` / `Date+Market` and `TradingCalendar`;
  - TradeGrader and every component file.
- In the runner's workspace only, `private var|func` becomes `internal`, so the harness can
  read each component's computed values.
- The CLI has no bundle ID, no Keychain access, no app data folder and no UI. It also
  sets `DOJIX_DATA_DIR` / `GREENWICK_DATA_DIR` to a temp folder for anything that asks.
- **Pinned environment:** `TZ=UTC`; `defaults write -g AppleLocale en_US_POSIX` on the
  throwaway runner. `Date()` is recorded in the output and injected into the TypeScript tests.
  Fixture dates stay at least 2 days away from any "now" boundary.
- **Output:** `golden/reference/<brand>/<fixture>.json` =
  `{source_sha, xcode, tz, locale, now, outputs: {"Metrics.profitFactor": …}}`. A bot commits it
  in a pull request. A checksum manifest makes CI fail if a reference file is edited by hand.

**Tier C — import through the Mac UI** (only if Tier B can't reach a path, e.g. the importer
view model):
- It runs on a GitHub macOS runner with a throwaway bundle ID, the Mac apps' own
  `*_UITEST_ROOT` / data-dir / keychain-service overrides and a scratch HOME.
- It reads the resulting journal through the Mac app's own backup export, never the sealed
  file.
- It never runs on a machine where either app is really used, and never with a production
  bundle ID.

### 10.3 Fictional fixtures (`golden/fixtures/`)

All fixtures are generated by a seeded generator or written by hand. They are clearly
fictional, and real trades are never used.

| Set | Contents |
|---|---|
| **F1 tiny** | The 5-trade hand-checkable set [100, 50, −30, −20, 80]: expectancy 36.0, maxDD 50.0, Sharpe 0.6872431934890912, Calmar 3.6. Plus every Swift test fixture |
| **F2 forex year** | About 600 trades in the 32-column MT5 format: 6 pairs, all sessions, no duplicate close times, no tied group totals |
| **F3 edge cases** | • breakeven trades; all wins; all losses; one trade; zero SL; JPY pairs <br>• negative slippage; values exactly on bucket edges; exactly 50% win rate <br>• 26-column rows; quoted and unquoted commas in comments <br>• CRLF/LF; UTF-8 BOM; UTF-16LE BOM; CP1252 <br>• multi-section file; renamed file <br>• the `Trade+Sanitize` limits (±1e9/±1e12, 32/256 characters, durations, lots floor) |
| **F4 long history** | At least 60 trades per window (EdgeDecay, KillZone, WhatToCut) |
| **F5** | One file per import format (both brands) + MT5 History Report + DojixExport |
| **F6 FIFO** | • partial fills; 1→n and n→1 matches; shorts <br>• same-timestamp buys and sells; date-only timestamps <br>• option rows; Schwab with and without a footer <br>• commission on every leg |
| **F7 time** | • ET trades across 2026-03-08 and 2026-11-01 <br>• EU switches 2026-03-29 and 2026-10-25, and the mismatch weeks <br>• Friday-evening ET trades seen from UTC+1 and UTC+9 (Greenwick's trading-day rule) <br>• Asia/Kolkata; Monday- vs Sunday-start weeks (Dojix) |
| **F8 tie traps** | Tests the desktop's deterministic tie-break only, never compared with Swift |
| **F9 scale** | 10k, 50k and 100k trades (performance and save-cost budgets) |
| **F10 Mac backups** | `DJXB`, `DOJX`, `GWBK`, `SJNL` and plain backups generated **by the Swift code in the Tier B harness** from F1/F2 data (password `fixture-password-1`). Tampered-header, wrong-password and too-many-rounds variants |

### 10.4 The parity gate

- During Phase 2 the engine has a `compat: 'swift' | 'fixed'` switch. The parity suite proves
  the port matches the Swift output, including known behaviours.
- Each intentional fix then lands as its own red→green commit with a DIVERGENCE entry in
  `golden/divergences.yaml` (id, reason, test). After that, the `swift` branch of the code is
  deleted. **The app always ships `fixed`.**
- `parity-check` fails when:
  - a reference value differs without a DIVERGENCE entry;
  - a DIVERGENCE entry has no test;
  - a headline number diverges without an entry marked approved by the maintainer.

The current DIVERGENCE list is in PARITY.md.

## 11. Security model

- **Trust boundary.** The web view renders content and is treated as untrusted. Rust holds keys,
  files and the network.
- **Capabilities:**
  - only this app's commands, plus the dialog and notification plugins, scoped to the main
    window;
  - no fs, shell or http plugin in the web view;
  - the opener is limited to an https allow-list (provider consoles and the project's GitHub
    pages).
- **CSP:**
  `default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'`.
  - Fonts are bundled (DM Sans, JetBrains Mono; OFL).
  - Devtools are off in release builds.
  - Markdown (help, AI responses, notes) is rendered without raw HTML.
- **Data at rest:** §6.
- **AI data minimisation:** §8.2.
- **Files:**
  - every path joined under the data folder is canonicalised and checked to be inside it;
  - screenshot names are app-generated UUIDs;
  - import reads are capped (50 MB per file) and opened read-only with full share mode, so MT5
    is never locked out;
  - the MT5 module is read-only (§5.4).
- **Exports:**
  - CSV formula guard: a leading `= + - @` (also after spaces or tabs, and including tab and CR)
    gets a `'` prefix, **unless the value parses as a number**. This matches the Mac, so
    `-12.50` stays numeric. Control characters are stripped.
  - Exports are written owner-only.
  - The clipboard is cleared after shareable summaries are copied.
- **Logs:** no keys, trade data, prices, file paths or response bodies. Logs rotate.
  "Export diagnostics" runs redaction again.
- **Supply chain:**
  - lockfiles, `cargo-deny`, audits, Semgrep, gitleaks, CodeQL;
  - an SBOM and provenance attestation for each release; signed updater artifacts;
  - Snyk at release time.
- **Threat model.** A STRIDE threat model is written in Phase 7, starting from the Mac apps'
  SECURITY.md. It explicitly records the platform differences:
  - no per-app ACL in Windows Credential Manager;
  - Linux without a Secret Service;
  - the web-view heap after a lock.
- **SECURITY.md (desktop)** follows the Mac structure: "What it protects" and "What it does not
  protect against" (a running, unlocked app; App Lock off; files you export; forgotten
  passwords; unsigned builds).

## 12. Build phases and gates

"Agent" means one AI coding agent in its own worktree.
- Every agent runs with a scratch `--data-dir`, a scratch vault service and a scratch HOME.
- No agent launches the Mac apps or touches their data or Keychain items.
- Rust is compiled, and the app launched, **only in CI**.
- A phase is done only when its gate is green **in CI on windows-latest and ubuntu-22.04**.

| Phase | Team | Branch(es) | Work | Done when |
|---|---|---|---|---|
| **0 Parity reference** (parallel with 1) | P (2) | `parity/*` | Fixture generator + F1–F10. Port the Swift test expectations of both apps (Tier A). `tools/swift-ref` + `parity-reference.yml` at the pinned SHAs (Tier B), including the F10 Mac-backup vectors | `golden/reference/{dojix,greenwick}/*.json` committed by the bot from a linked CI run |
| **1 Foundation** | F (lead + 1) | `phase1/foundation` | • Workspace, brand configs, Tauri shell <br>• Data folder + DACL/mode, `--data-dir` (debug only), single-instance lock <br>• Logging, `--self-test`, `e2e` hooks <br>• CI workflows (ci, e2e, installers skeleton), capabilities/CSP <br>• **Journal store v0:** in-memory rusqlite + migrations + seal/open + secure writer, lock off only | CI green on both OSes. Artifacts: 2 brands × {NSIS, MSI, AppImage, deb}. e2e smoke launches each brand on an empty journal, adds a trade, restarts, and the trade persists. `journal.sealed` is never plaintext (the test greps the data folder for the SQLite magic) |
| **1S Security core** (after 1's store, parallel with 2) | K (2) | `security/*` | • Vault with three-way lookup; App Lock enable/change/disable/unlock through the gate; Argon2id wrapping <br>• Key rotation (3 steps) + pending-rotation rules; rollback ledger + older-copy screen <br>• Throttle; idle lock + OS triggers; held journal + save-before-quit; erase <br>• Backups (`DXBK`) + validated restore + Mac backup readers; snapshots; sealed screenshots | Rust unit tests for each property in §6.1, including crash injection at every rotation and save step. Windows and Linux e2e: lock/unlock, idle lock (injected clock), throttle across a restart, older copy refused, restore of F10 files, erase. Vault `Failed` injection proves fail-closed at every decision point |
| **2 Engine** | E (4) + I (2) | `engine/*`, `import/*` | E1: types, MetricsCalculator, swiftcompat, calendars (day 1). E2: Timing, Sessions, Pairs/Symbols. E3: Risk, Behavioral, Advanced, TradeGrader. E4: Greenwick-only components + brand variants. I1: Dojix formats + MT5 report + DojixExport + content tickets. I2: Greenwick formats + FIFO | `parity-check` green in `swift` compat for every reference value; then each DIVERGENCE fix lands red→green. 100k property cases per parser, with no crash or hang (50 MB worst case under 5 s). Line coverage ≥ 90% in core and importers |
| **3 Screens** | S (4) | `ui/*` | Journal / Detail / Add Trade / Replay / screenshots; Dashboard + analytics registry; Edge Report / Import / Settings / Onboarding / Help / Lock / Older-copy / About; Pulse (mocked feeds) and Browse + Watchlist (mocked Finnhub) | Playwright spec per screen with visual baselines. Real-binary e2e: import F2 → the Dashboard headline numbers equal the reference (`data-testid`). axe: zero serious or critical issues. Shortcuts e2e |
| **4 Online** (parallel with 3) | N (2) | `net/*` | AI client + preview + `ai_reports`; Finnhub; Twelve Data REST/WS, Polygon, OANDA stream + import, calendar, MT5 price file | wiremock contract tests for every endpoint (401/429/5xx, timeouts, malformed data). Proof that no command returns a secret. CSP blocks web-view fetches. **No real network in CI** |
| **5 MT5** (parallel with 3/4) | W (1–2) | `mt5/*` | Discovery, `origin.txt`, watcher (opt-in) + ledger, Settings UI, `DojixExport.mq5`, Linux Wine discovery | windows-latest e2e on a synthetic terminal tree: files created, rewritten in place, partly written, locked, deleted. Deny-write ACL test. Idle CPU under 1%. Zero writes under watched roots (hash of the whole tree before and after) |
| **6 Release** | R (1) | `release/*` | Updater, `release.yml`, signing hook, installer matrix, updater e2e, winget manifest, SBOM/provenance, README + install guides, SECURITY.md | A dry-run release (`v0.9.0-rc1`, draft) produces every artifact. `installers.yml` + updater e2e pass on those exact files |
| **7 Hunt** | H (7, then re-hunt) | `hunt/<class>` | §13 | Two consecutive rounds with no Critical or High finding. Every fix has a test that was RED in CI before it went GREEN |

**Dependencies:**
- 0 and 1 run in parallel.
- 1S needs 1's store.
- 2 needs E1 on day 1, plus 1's CI.
- 3 needs 2's compute models (stubs are fine early) and 1S's lock routes.
- 4 and 5 need 1.
- 6 needs 3–5.
- 7 needs 6.

**Estimate (ranges, not promises):**

| Phase | Calendar |
|---|---|
| 0 | 3–4 days (parallel with 1) |
| 1 | 3–4 days |
| 1S | 1.5–2 weeks (parallel with 2) |
| 2 | 1–1.5 weeks |
| 3 | 1.5–2 weeks |
| 4 | 4–5 days (parallel with 3) |
| 5 | 4–5 days (parallel with 3/4) |
| 6 | 3–4 days |
| 7 | 1–1.5 weeks |
| **Total** | **about 6–8 weeks** |

The first draft estimated 5–7 weeks. The extra time is the security core (§6), which the Mac
apps gained after that draft, and the larger import and parity surface.

## 13. Hunt plan

**Process:**
- Each hunter gets a brief, the fixtures and a fresh data folder plus a scratch vault service.
- Each finding goes in `hunt-findings/<class>-<n>.md` with a repro, expected vs actual, and a
  severity.
- The fix agent commits a failing test first (CI RED), then the fix (GREEN). The reviewer checks
  that the RED run exists.

**Severity:**
- **Critical:** data loss; a plaintext journal on disk; a key leak; a wrong headline number; the
  watcher writing to MT5; rollback bypass.
- **High**, **Medium**, **Low** below that.

| Class | What hunters attack |
|---|---|
| **H1 Imports** | Every format: malformed, truncated or hostile input (formula strings, 1 MB fields, NUL bytes, 10M columns); the 50 MB edge; encodings; delimiters; decimal comma; quoted and unquoted commas; 26–33 columns; CRLF/LF/CR; duplicate tickets inside a file; re-import idempotence (content tickets); MT5 report variants; FIFO edge cases; Mac backups with every format, wrong passwords, tampered headers, iteration counts out of range, oversized tables |
| **H2 Numbers** | Drift from the reference; integer division; printf rounding; sentinels (∞/NaN shown as text); ties; empty / 1-trade / all-breakeven sets; extreme values against the sanitize limits; 100k trades; Monte Carlo seed reproducibility; brand mix-ups; Greenwick trading-day bucketing seen from any time zone |
| **H3 Installer / update** | Fresh install; upgrade with data; downgrade refused; uninstall keeps data; reinstall; NSIS vs MSI; WebView2 missing or old; tampered updater signature; interrupted download; offline; migration on first run after an upgrade, with a snapshot |
| **H4 Data safety** | Kill the process at every step of save, rotation, restore and migration (crash injection); disk full during a save, during a lock and during quit; read-only data folder; second instance; a corrupted or truncated `journal.sealed` (set aside, never deleted); an older copy put back (refused); the vault record missing or unreadable; backup → restore round trip; undo-delete window |
| **H5 App Lock** | Throttle bypass (clock changes, restart, vault errors); races (lock during unlock / enable / disable / change, double unlock from two windows, erase during unlock); the idle timer while menus or dialogs are open; OS lock/sleep triggers; data left in the web view after a lock (heap snapshot via devtools in an `e2e` build); screenshot access while locked |
| **H6 Windows / Linux environment** | Paths with spaces, `&`, Unicode, or over 260 characters; non-ASCII user names; `%LOCALAPPDATA%` on another drive; OneDrive-redirected Documents for exports; 100–200% DPI and multiple monitors; 12h/24h; Monday-start weeks; Thai Buddhist calendar; +5:30 / +5:45 / +10:30 zones; US and EU DST and the mismatch weeks; locales de-DE / tr-TR (dotless i in header matching) / ar-SA / ja-JP; Linux without a Secret Service; Wayland vs X11 |
| **H7 MT5 watcher** | No MT5; Common folder created after launch; several terminals; portable installs; same-day overwrite; partial writes; the file held open; 1 Hz price file next to trade files; huge history; a symlink or junction pointing outside; network drives; Wine prefixes; sleep/resume; **proof it never writes** |
| **H8 Security** | IPC surface (every command called with hostile arguments); CSP bypass; key leakage (logs, crash output, exports, diagnostics, web-view memory); path traversal (screenshots, restore, folder scan); CSV injection; update-channel tampering; dependency advisories; STRIDE review; Snyk/Semgrep clean |

## 14. Risks

1. **SmartScreen warnings on unsigned builds.** Mitigation: winget, clear README text, and a
   free signing programme after v1.
2. **Loss of the update-signing key.** Mitigation: an offline second copy.
3. **WebKitGTK quirks and uneven OS lock signals on Linux.** Linux is declared tier-2, and the
   idle timer always works.
4. **Unofficial feeds.** The economic calendar has no SLA, and provider endpoints get renamed.
   Both sit behind toggles, and the app works without them.
5. **Broker-time ambiguity in 32-column MT5 files.** The default keeps the Mac behaviour (times
   read as UTC); the new exporter writes true UTC.
6. **Whole-image save cost on very large journals.** It is measured with F9. If the budget
   fails, saves are coalesced inside one IPC call (one save per user action), never deferred
   past the reply.
7. **Tier B harness effort** (making private SwiftUI properties readable). Fallback: Tier A plus
   hand-derived values, listed in `golden/README.md`.

## Appendix A: Component formula catalogue (Swift behaviour, the parity source)

**Conventions.** §3.1 applies throughout.
- **ASC** = sorted by close time ascending (a stable sort).
- **WR%** = percent; **WRf** = fraction.
- **"day"** = the brand calendar's day:
  - Dojix: the computer's (display) zone;
  - Greenwick: the ET trading day of the close, via `TradingCalendar`, unless noted.
- **Dxx** marks an intentional desktop fix (PARITY.md). The Swift behaviour is described here.

### Shared (brand variants noted)

- **LotSize / ShareSize:** n≥5. Average size of wins vs losses. Flag when the average losing
  size is more than 1.2× the average winning size.
- **HourlyPnL:** hours 0–23 by stored hour (ST: ET); empty hours dropped; best = the last
  maximum.
- **WinLossDistribution:**
  - maxAbs = max(maxP, \|minP\|); bucket size bs = maxAbs/5;
  - buckets i = −5..4 cover [i·bs, (i+1)·bs); label `Int(low)`; empty buckets omitted;
  - median: mean of the two middle values when the count is even.
  - **D-01:** a value equal to +maxAbs falls outside every bucket.
- **DrawdownChart:** ASC; dd = cum − peak (≤ 0, both starting at 0); "Max" = min(dd).
- **TradeComparison:** best = max (the last of ties); worst = min (the first of ties).
- **DurationAnalysis:**
  - buckets 0–5, 6–15, 16–30, 31–60, 61–120, 121–999999 min;
  - per bucket: profit, WR%, avgR;
  - sweet spot = the bucket with the highest avgR, if its count is ≥ 3.
- **DayOfWeekChart:** "Mon"…"Fri"; profit, WR%; best and worst by profit. ST uses the ET
  trading weekday.
- **RMultipleChart:**
  - buckets [−100,−2), [−2,−1.5), [−1.5,−1), [−1,−0.5), [−0.5,0), [0,0.5), [0.5,1), [1,1.5),
    [1.5,2), [2,100);
  - labels "<-2R", ">2R", otherwise "%.1fR";
  - avg, median, best, worst.
- **PerformanceSummary:** this week, this month and last month on the brand calendar; P&L,
  WR%; sparkline by day.
- **StreakTimeline:** ASC segments of equal `isWin` (a breakeven groups with losses).
- **SlippageAnalysis:**
  - trades with slippage > 0: average; total cost = Σ(slip × 10 × lots) for FX, Σ(slip × shares)
    for ST;
  - high slippage = above 2× the average;
  - closed buckets [0,.5], [.5,1], [1,2], [2,3], [3,100], so values on an edge count twice
    (**D-02**) and values above 100 are dropped;
  - insight when the average is above 1.5.
- **MAEMFE:**
  - n≥5; ratio = avgMFE/avgMAE (0 if avgMAE = 0);
  - ≥3 Excellent, ≥2 Good, ≥1 Average, otherwise "drawdowns exceed";
  - captureRatio = Σ\|p/max(qty×10,1)\| / ΣMFE (ST keeps the ×10).
- **TagAnalytics:** a tag counts every trade that carries it; profit, WR%, avgR; sorted by
  \|profit\| descending; top 8.
- **SessionRankingCard:** sessions in enum order, non-empty ones; stable sort by P&L
  descending; rank = index + 1.
- **ExpectancyCurve:** n≥10 and E≠0; ASC; actual = cumulative, projected = E×(i+1); deviation =
  (lastA − lastP)/\|lastP\|×100.
- **PositionSizer:**
  - balance 10,000 by default; risk 1% by default (0.25–5); risk = balance × r/100;
  - FX: avgSL = mean(slDist > 0), else 20; lots = round_half_away(risk/(avgSL×10)×100)/100;
    aligned when 0.5 ≤ suggested/current ≤ 2;
  - ST: shares = risk/avgSLpoints, rounded to 0.01.
- **Pair / SymbolAnalytics:** grouped by symbol, profit descending; P&L, WR%, avgR, buys and
  sells with P&L each; a mini equity curve.
- **GradeDistribution:** n≥5; % per grade; averageScore = ΣInt(total)/n.
- **GrowthProjection** (computer calendar in both apps):
  - weeks = max(1, whole days from the first close to the last)/7, integer division;
  - trades per week (tpw) = weeks > 0 ? n/weeks : n; n≥5;
  - for w = 0…months×4: expected = E×tpw×w; conservative ×0.6, optimistic ×1.4.
- **StreakCard:**
  - current = run back from the last trade while `isWin` matches (a breakeven counts as a
    loss);
  - best win run and best loss run, each reset by a breakeven;
  - last 10 results (a breakeven shows as a loss);
  - near-best badge: current ≥ 3, best ≥ 3, and current ≥ ceil(0.8×best).
  - **D-17:** the semantics differ from MetricsCalculator. Documented; kept per component.
- **DirectionalEdge:** per direction: count, total, WR%, avgR, average; better = the higher
  average P&L; insight when both sides have ≥ 5 trades.
- **DataQuality:** checks, in order:
  - R == 0;
  - size > 5× the average;
  - duration == 0;
  - duplicate close times;
  - weekend opens (ST: ET);
  - MAE > 3×MFE (with MFE > 0), counted only when there are more than n/4 (integer division).
- **TradeTimeHeatmap:** Mon–Fri × 0–23; hours 6–21 shown; maxAbs over all cells; opacity
  .15 + .85×min(\|p\|/maxAbs, 1). ST: ET.
- **WeeklyHeatmap:**
  - weeks by (yearForWeekOfYear, weekOfYear) on the brand calendar; the last 16 shown;
  - profitable weeks; average week;
  - streak from newest to oldest: + extends, − extends, 0 is skipped, a sign change stops it.
- **MonthlyReturns:** key YYYY-MM on the brand calendar; profit, count, WR%; best and worst
  month; year total.
- **TradeCalendar:** daily P&L by day; month total; trading days. ST grid: ET days; only the
  first weekday is local (display).
- **BenchmarkComparison:**
  - total ≥ 10; benchmarks WR 45, PF 1.3, AvgR 0.3, Sharpe 0.5;
  - DD% = maxDD/max(\|total\|,1)×100 vs 30 (lower is better);
  - status band ±10%.
- **TimeToMFE:**
  - trades with ttMFE > 0, at least 10;
  - buckets 0–5, 6–15, 16–30, 31–60, 61+;
  - integer-division median (even count) and average hold;
  - overholding when the average hold is above 2× the median.
- **Trade.exitEfficiency** = clamp(R×slDist/MFE×100, 0, 100) when MFE > 0 and slDist > 0
  (losers clamp to 0).
  **moneyLeftOnTable** = max(MFE − R×slDist, 0), wins only.
- **SessionHeatmap:** Mon–Fri × hours that have trades; opacity .2 + .8i. ST: ET.
- **SessionIntelligence:** per session: profit, wins, losses, WR%, avgR, PF (∞ if no losses).
  - FOCUS: avgR ≥ .5, WR ≥ 50 and n ≥ 5;
  - OK: avgR ≥ 0 and WR ≥ 40;
  - AVOID: avgR < 0 and n ≥ 5;
  - otherwise REDUCE.
- **CommissionAnalytics:**
  - shown only when some cost ≠ 0;
  - totals, cost per trade; cost% = \|costs\|/Σ(p>0)×100 (< 5 green, < 15 yellow);
  - per symbol: cost per lot (FX) or per share (ST); top 5.
  - ST gross = net + costs.
- **EmotionalAnalytics:** ≥ 10 tagged trades and ≥ 2 emotions; per emotion: count, WRf, P&L,
  average; sorted by average descending.
- **ImprovementTracker:**
  - n ≥ 20; window w = max(10, n/10) (integer division);
  - rolling WR%, avgR, PF (5 if no losses, capped at 5);
  - trend needs ≥ 10 points; compare the two halves: improving when R improves by more than .1
    and WR by more than 2; declining when R falls by more than .2 or WR by more than 5; else
    stable.
- **RiskOfRuin:**
  - n ≥ 10; w = WRf; rr = avgWin/avgLoss;
  - return 1 when w ≤ 0 or rr ≤ 0; edge = w·rr − (1 − w); return 1 when edge ≤ 0;
  - **return 1 when w == .5 (D-04)**, even with a positive edge;
  - base = (1 − edge)/(1 + edge); outside [0,1) return 1 (base ≥ 1) or 0; else RoR = base²⁰;
  - Kelly = max(0, w − (1 − w)/rr); half-Kelly = Kelly/2;
  - levels < .01, < .05, < .2, < .5.
- **MonteCarlo:**
  - n ≥ 15; 1,000 shuffles **without replacement** of the ASC P&Ls (every final total equals
    the real total);
  - bands at indices 49/249/499/749/949; median final = finals[500]; worst/best =
    finals[49]/finals[949];
  - target = max(2×total, 500), so "Hit Target" is always 0 (**D-05**);
  - DD threshold = .2×max(total, 1000); unseeded.
- **SequenceAnalysis:**
  - n ≥ 20; transitions WW/WL/LW/LL (a breakeven counts on the loss side);
  - conditional percentages; average P&L after a win and after a loss;
  - Tilt Risk: LL > 55 and avgAfterLoss < .5×avgAfterWin;
  - Momentum: WW > 55 and LL > 55; Mean Reverting: LW > 55 and WL > 55; otherwise Random.
- **StrategyCheckpoints:** before = close < date, after = close ≥ date (each ASC, then the
  metrics); compared only when both sides have ≥ 5 trades.
- **ChecklistAnalytics:**
  - ≥ 5 trades with checklist data;
  - per rule: followed vs broken (count, average P&L, WR%); impact = avgF − avgB, sorted
    descending;
  - compliance %; all-followed vs any-broken.
- **ConsistencyScore:** n ≥ 10, ASC. The overall score is the mean of five sub-scores; grades
  ≥ 85 A, ≥ 70 B, ≥ 55 C, ≥ 40 D.
  1. WR windows w = max(5, n/4): clamp((1 − σ/μ)×100), with cv = 1 when μ = 0.
  2. PF of the two halves (10 if a half has no losses): min/max×100.
  3. Underwater stretches: 100 − avg/n×200 − (max > n/3 ? 20 : 0).
  4. Size CV: (1 − cv)×100, or 50 when the mean is 0.
  5. min(100, (1 − uniqueHours/24)×120).
- **WhatToCut:** n ≥ 30; trading days = distinct close days (ST: ET); conditions with E < 0 and
  count ≥ 10, sorted by monthly impact ascending; savings = Σ monthly impact.
- **KillZone:**
  - n ≥ 30; trading days: **Dojix counts distinct local open days (D-08)**, Greenwick counts ET
    close days;
  - an hour qualifies with count ≥ 10 and the right sign; consecutive hours merge (no wrap);
  - window WR is count-weighted; monthly impact = pnl×21/tradingDays;
  - label "%02d-%02d UTC" (ST: ET).
- **ExitAnalysis:**
  - FX: n ≥ 10; average efficiency; money left (pips); "continued %" = winners with pc15 > 0;
  - closed buckets 0–20 … 80–100 (**D-03**);
  - ST: early exit = winners with efficiency < 50.
- **PeriodComparison:** 7/30/90 days; current = close ≥ now − d; previous = [now − 2d, now − d)
  (computer clock in both apps). %change(c, p) = p == 0 ? ±100/0 : (c − p)/\|p\|×100; WR and
  avgR shown as absolute differences.
- **EdgeDecay:**
  - window 30, ASC; rolling WRf, PF (capped at 5), expectancy, Sharpe (clamped ±3), dominant
    volatility regime (FX);
  - status from the last 30 vs the prior 30 points: decaying when PF drops by more than .5 or
    expectancy by more than 30%; warning above .25 / 15%;
  - diagnoses when n ≥ 60: regime shift (FX); overtrading (trades per day, second half more
    than 1.3×/1.5× the first; ST: ET days); strategy drift; per-session WR drop above 15/25.
- **BehavioralAnalytics (Discipline):**
  - n ≥ 15; days = close days (ST: ET); avgDaily = n/days;
  - overtrading days: count > max(2×avg, 5);
  - revenge: the next trade opens 0–600 s after a loss closes;
  - tilt: ≥ 3 losses closing within 60 min of a loss, capped at n/5 (integer division);
  - size ratio = the average size after a loss (breakeven included) / after a win;
  - scores: 100 − 25·otDays; revenge 100, or max(0, Int(100 − rate%×10)); 100 − 20·tilt; size
    (≤ 1.05 → 100, ≤ 1.2 → 75, ≤ 1.5 → 50, else max(0, Int(100 − (r − 1)×80)));
  - ST clamps each score to 0–100 (`clampedScore`);
  - overall = Σ/4 (integer division).
- **Pair / SymbolCorrelation:** daily P&L per symbol; Pearson on common days (≥ 2, else 0); the
  average of the upper triangle including zeros; > .6 High, < −.3 Good.
- **CalendarCorrelation / EventImpactProfiler:**
  - heuristics on the open time's weekday, weekOfMonth, day, month and hour;
  - **Dojix** uses the computer's calendar (D-09, D-19):
    - NFP: Fri, week 1. FOMC: Wed, months {1,3,5,6,7,9,11,12}, day 15–28. CPI: Tue/Wed, day
      10–14;
    - ECB: Thu, day 7–21, months {1,3,4,6,7,9,10,12}, hour 11–15. BOE: Thu, day 1–14, months
      {2,3,5,6,8,9,11,12}, hour 10–14;
    - Monday open: Mon, hour < 9. Friday close: Fri, hour ≥ 18.
  - **Greenwick** uses the ET exchange calendar and replaces ECB/BOE with Earnings (hour 16–18)
    and Jobs (Fri, week 1, hour 8–14). Its weeks start Monday with minDays 4, so in a month
    that starts on a Friday the first Friday is "week 0" (D-19).
  - Profiler:
    - ≥ 3 matches per type; WRf; PF (99 if no losses);
    - pre/during/post windows on the stored hour vs the typical hour (FX UTC, ST ET);
    - TRADE (n ≥ 10, WR ≥ .55, PF ≥ 1.2); AVOID (WR < .4 or PF < .8); else CAUTION;
    - monthly cost uses months from the first trade to now (computer calendar in both apps).
- **PropFirmTracker / Badge:**
  - account 100,000, target 8%, daily 5%, DD 10%;
  - balance = account + Σp; daily = today's P&L (brand calendar); maxDD as in Metrics;
  - breaches: daily loss > account×daily%, DD > account×DD%;
  - warnings at ≥ 75% / ≥ 90% / breached.
- **DrawdownRecovery:**
  - n ≥ 20; equity with dd$ and dd% of the peak;
  - events: recovered duration = idx − start; **unrecovered = last − start + 1 (D-20)**;
  - average recovery; deepest and longest; % of time in drawdown; phase stats; top 10.
- **PlaybookCatalog:** tag = setup; count, WR%, avgR, total, PF (∞ → 99.99); KEEP when PF ≥ 1
  and n ≥ 5, DROP when PF < .8 and n ≥ 5, else REVIEW; best and worst session; last 10.
- **DailyBrief:**
  - n ≥ 5; Decimal sums;
  - n ≥ 20: hot streak (recent 10 > 1.5×previous 10 and > 0; priority 1); dip (recent < 0 and
    previous > 0; priority 0);
  - current session with ≥ 3 trades (priority 2); best pair (3); worst pair (1); DD > total
    with total > 0 (0); Sharpe ≥ 1.5 (4);
  - top 3 by priority.
- **ShareableSummary:** a fixed text template.

### Dojix only

- **PostCloseAnalysis:**
  - averages of pc15 and pc30 over all trades, winners and losers;
  - early exits = wins with pc30 > 10, as a % of wins;
  - insight when that is above 40%, else "good timing" when avg30 < 0.
- **NetCurrencyExposure:**
  - n ≥ 5; ± lots added to the base currency and subtracted from the quote currency;
  - sorted by \|net\|; concentration = top/Σ\|net\| (warning above 50, red above 70);
  - correlated-direction insights.
- **TradeGrader FX:**
  - **R:** ≥3 → 25, ≥2 → 22, ≥1.5 → 20, ≥1 → 17, ≥.5 → 13, ≥0 → 8, ≥−.5 → 5, ≥−1 → 3, else
    0.
  - **Execution:**
    - ratio = MAE > 0 ? MFE/MAE : (MFE > 0 ? 10 : 0); ≥3 +15, ≥2 +12, ≥1.5 +10, ≥1 +7, else
      +3;
    - slippage ≤ .5 +5, ≤ 1 +3, ≤ 2 +1;
    - FVG +5;
    - cap 25.
  - **Timing:**
    - London / NY Overlap +10, NY +7, Asian +5, Late +2;
    - hour {7,8,9,12,13,14} +10, {10,11,15,16} +7, {17–21} +4, else +1;
    - bias WITH +5, NEUTRAL +2;
    - cap 25.
  - **Management:**
    - breakeven hit on a win +5;
    - r = dur/max(avgDur,1): 0.5–2 → +10, 0.25–3 → +6, else +2;
    - win: pc30 < 5 +10, < 15 +6, else +2;
    - loss or breakeven: dur ≤ max(avgDur/2, 5) → +8, else +4;
    - cap 25.
- **Pulse edge signal:**
  - n ≥ 30; per active session (related sessions included):
    - session with ≥ 5 trades: WR ≥ 60 and PF ≥ 1.5 → +2; WR < 40 or PF < .8 → −2;
    - current hour with ≥ 3 trades: WR ≥ 60 and profit > 0 → +1; profit < 0 → −1;
    - danger zone −2;
  - ≥ 2 strong, ≥ 0 neutral, else avoid.
  - The Mac computes it once, when the screen appears (desktop fix in §2.4).

### Greenwick only

- **TradeGrader ST:** no FVG or bias.
  - Session: Regular +10; Pre-market and After-hours take the NY and Asian slots; Extended +2.
  - Hours (ET): 9–10 or 15–16 best; 10–12 or 13–15 middle; 4–9 low.
  - Win exit: efficiency > 60 +10, > 30 middle, else +2.
- **SectorExposure:** P&L, count and WR% per sector; warning when one sector holds more than
  50% of the sector-tagged trades.
- **VolumeAnalysis:** RVOL = volume/avgVolume; closed buckets 0–.5, .5–1.5, 1.5–3, 3–1000;
  average P&L above 1.5 vs below .5.
- **GapAnalysis:**
  - per symbol, by ET open day (`dayKey`, zero-padded, so sorting by string is date order):
    previous traded day's last close vs today's first open;
  - \|gap\| > 0.5%; filled when the day's low/high crosses the previous close;
  - gap-and-go vs gap-and-fade (≥ 3 trades).
- **OpeningRange:** minutes after 09:30 ET in buckets 0–5, 5–15, 15–30, 30–120, 120–210,
  210–330, 330–390; best and worst average.
- **ExecutionQuality:** n ≥ 10 and some slippage; score = .4·clamp((1 − avgSlip/3)×100) +
  .3·clamp((1 − σ/2)×100) + .3·avgEfficiency (50 if none); > 70 Good, ≥ 40 Fair.
- **IntradayEquityCurve:** n ≥ 10; hours 9–15 ET, average P&L, cumulated; morning (9–11) vs
  afternoon (12–15).
- **RegimeAnalysis:**
  - n ≥ 10 and ≥ 3 ET days; each day is classified as:
    - Trending: WR > 60 and avgWinner > 1.5×avgLoser;
    - Choppy: WR < 40;
    - Volatile: average MAE > 2× the median day MAE;
    - otherwise Calm;
  - current regime = the most common over the last 5 days.
- **EarningsImpact:** n ≥ 20; volatility per symbol = max(MAE, range); catalyst days have ≥ 2×
  the mean volatility (ET open day); ≥ 3 catalyst trades; TRADE / AVOID / CAUTION.
- **DiversificationScore:**
  - n ≥ 10 and ≥ 2 symbols; effective N = N²/Σcorr²; ratio = effN/N;
  - grades: A (> .7 and top sector ≤ 40%), B > .5, C > .3, D > .2, else F;
  - concentration warnings: top symbol > 40%, top sector > 60%.
- **MetricsCalculator ST:** adds edgeBySector ("Unknown"); netProfitAfterCosts = total.
