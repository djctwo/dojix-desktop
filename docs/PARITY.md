# Parity with the Mac apps

The desktop apps must behave like the current Mac apps. Each exception is either an
intentional fix, which has an ID and a test, or a platform necessity, which has a reason.

**Reference sources** (public, read as code; the numbers come from the Tier B harness, see
SPEC §10):
- **djctwo/dojix** `614bd6a0bd85adcbb0a8a48891c7fa708a6b2605` (Dojix 1.0.0 + CI fixes)
- **djctwo/greenwick** `64495e28b0c9a8016ea86adf43098a569307e074` (Greenwick 1.0.1)

Moving either pin is its own pull request. It regenerates the references and updates this
file.

---

## A. Must match exactly

### A1. Numbers

- **Formulas.** Every formula in SPEC §3.3 and Appendix A, with the brand variants. This
  includes the sentinels:
  - profit factor +∞ (shown as 99.99), 99, 10 and 5 by component;
  - Calmar 10 or 0;
  - Sharpe 0 when σ = 0.
- **Rounding.** Integer division that truncates toward zero, `%.2f` half-to-even, `.rounded()`
  half away from zero, and `Int(saturating:)`.
- **Order of operations.** Summation in close-time-descending order. Drawdown and streaks run
  ascending.
- **Win rate.** Breakevens count in the denominator. Win rate is a percent in some components
  and a fraction in others, exactly as listed in §3.1.
- **P&L is net of costs in both brands.** Greenwick stores net on every path: generic, FIFO and
  manual. Editing costs moves Greenwick's net P&L. Dojix keeps P&L and reports "net after
  costs" = total − costs.
- **Greenwick exchange calendar.** America/New_York; Monday-start weeks with
  `minimumDaysInFirstWeek` 4; POSIX weekday names.
  - Session, hour and day come from the **open** time in ET. The trading day is the ET date of
    the **close**.
  - The 21 components and filters that use `TradingCalendar` must be independent of the
    computer's time zone.
  - The few that use the computer's calendar on the Mac (PeriodComparison, GrowthProjection,
    the EventImpactProfiler day span) keep doing so.
  - The analytics have no holiday calendar.
- **Dojix calendar.** Day, week and month bucketing uses the user's zone and locale week, which
  is the Mac's `Calendar.current`. 32-column MT5 times are read as UTC by default.
- **Sessions.** The Dojix app buckets and the 32-column file buckets (each trusted where the
  Mac trusts it), and the Greenwick ET sessions.
- **Grading.** TradeGrader thresholds for both brands.
- **Tickets, computed exactly as on the Mac:**
  - **Dojix:** the broker ticket where the format has one, else the SHA-256 content ticket in
    [8×10¹⁸, 9×10¹⁸).
  - **Greenwick:** the FNV-1a 63-bit ticket over the row or the FIFO key, with an occurrence
    counter.
  - Re-importing a file never duplicates. A Mac backup restored on the desktop dedupes against
    a later import of the same broker file.
- **Storage validation.** Dojix clamps (`Trade+Sanitize`); Greenwick rejects (`TradeLimits`).
  A restore rejects any row that breaks either rule (`storageViolations`).
- **FIFO pairing (Greenwick).** Costs prorated by each side's own size; shorts when the sell
  comes first; pairs above 1e12 skipped; output sorted by open time.
- **Sample trades.**
  - 30 trades with comment "Sample (fictional)".
  - Ticket ranges: Dojix 9,000,000,000,000 + 0…29; Greenwick 900000–900029.
  - "Remove Sample Trades" removes only those.

### A2. Security and storage behaviour

The *mechanism* follows SPEC §6. The *behaviour* the user sees must match:

1. **The journal is never plaintext on disk.** It is held in memory and sealed with AES-256-GCM
   after every commit. The authenticated header carries the epoch, the generation and the save
   time.
2. **Durable atomic save.** Temp file, flush, rename, folder flush, then the generation is
   recorded. A failed save is reported, never silent.
3. **The empty image is always a valid one-page database.** This is the macOS-15 SQLite fix,
   tested on every platform.
4. **App Lock wraps the key.** With it off, the key is a plain vault item. With it on, the key
   is only stored wrapped by the password.
5. **Crash-safe key rotation** when App Lock is turned on or the password changes:
   - Begin stores [new, old] together.
   - The journal, stray copies, snapshots and screenshots are re-sealed.
   - Finish runs only when everything opens with the new key. A folder that can't be listed
     counts as not done.
   - A pending rotation blocks any further key change.
   - Once begin is stored, the new password is in force ("finishes at the next unlock").
6. **Rollback protection.** Lower generation, another epoch, or the same generation with a
   different hash means "older copy": the app explains and asks. The file opens only with the
   App Lock password (lock on) or after a confirmation (lock off). A confirmed open starts a new
   epoch, and the counter never goes down. A vault record that can't be written or read is
   logged and never fatal.
7. **Fail-closed vault reads.** Only "not found" means absent. An unreadable lock item keeps the
   app locked and says so. An unreadable key is never replaced.
8. **Throttle.**
   - 4 free attempts ("n/5"), then 30 s, 60 s, 5 min, 15 min and 30 min.
   - Persisted in the vault and shared by the lock screen, the older-copy screen and Settings.
   - An unreadable count means no password is checked and nothing is written.
9. **Idle auto-lock.** Off, 1, 5, 15, 30 or 60 minutes; **default 15**. Activity is the user's
   input in the app. The app also locks on OS lock, sleep, user switch and minimize.
10. **One key operation at a time.** Unlock, Enable, Change and Disable are refused as "busy"
    while another runs. A lock requested during one happens when it ends. Disable needs the
    current password.
11. **Locking** saves, wipes the key and the in-memory journal, and closes dialogs.
12. **"Forgot password?" = Erase all local data.** There is no recovery.
    - Erase is refused while key items can't be read.
    - It deletes the journal and checks it is gone before removing any key.
    - It then removes screenshots, copies and every vault item for the app (API keys included,
      as Dojix does).
13. **Password-protected backups** (AES-256-GCM, header bound as associated data); on by default
    when App Lock is on. A backup without a password is labelled unencrypted.
14. **Restores are rebuilt from validated rows** in one transaction: schema/migration check,
    every row checked, size limits (512 MB, 2,000,000 rows). A backup file is never copied over
    the journal. Newer-version backups are refused.
15. **Screenshots are sealed with the journal key**, decrypted into memory only, and never read
    or written while locked. Plain images left by older versions are sealed when first found.
    Backups contain screenshot names, not images.
16. **Single instance.** A second copy shows "already open" and opens nothing. Where locks are
    unsupported, the app opens anyway and the docs say so.
17. **No telemetry. Every online feature is off by default** and uses the user's own key. AI
    sends aggregates only, and only on "Run Analysis".

### A3. Import and UX behaviour

- **Every Mac import format detects and parses the same.** Header signatures; the 32-column
  layout with short rows padded (column 31 `NEUTRAL`, the rest `0`); date formats; the 50 MB
  cap.
- **Re-import is idempotent.** Auto-imports skip the confirmation dialog.
- **Screens.** Every screen, card and Edge Report section in both apps, with the same titles,
  thresholds, empty states and "?" definitions.
- **Onboarding** is shown once and can be reopened from Settings.
- **CSV export.** The Mac's columns come first, in the Mac's order, with UTC times. The
  formula-injection guard leaves numeric values unprefixed, so `-12.50` stays a number.
- **KillZone / WhatToCut CSV** go through a Save dialog.
- **Trade Replay, Toasts and Undo**, as on the Mac.
- **Keyboard shortcuts:** the Mac set, with Ctrl/Alt in place of Cmd/Option.

---

## B. Intentional differences

### B1. Number and import fixes (each is a DIVERGENCE entry with a red→green test)

The IDs continue the first draft's numbering. IDs fixed on the Mac since then are listed in
B3 and are now parity.

| ID | App(s) | Mac behaviour today | Desktop | Headline? |
|---|---|---|---|---|
| D-01 | both | WinLossDistribution: the largest win (= +maxAbs) falls outside every bucket | The top bucket is closed at +maxAbs | no |
| D-02 | both | SlippageAnalysis: closed buckets count edge values twice, and values above 100 are dropped | Half-open buckets, with the last one open-ended | no |
| D-03 | both | ExitAnalysis: closed efficiency buckets count edges twice | Half-open buckets, with 100 in the last | no |
| D-04 | both | RiskOfRuin returns 100% at exactly a 50% win rate, even with a positive edge | The general formula is used at 50% | no |
| D-05 | both | Monte Carlo shuffles without replacement, so every final equals the real total and "Hit Target" is always 0. Unseeded | Bootstrap (resample with replacement) with a seeded RNG (seed shown). Only invariants are parity-tested | no |
| D-06 | Dojix | Generic CSV JPY R-multiple uses pip value 100 per lot, against 10 for other pairs | A pip value of 10 per lot for every pair. This is an approximation in account currency, but it is on the same scale for JPY and non-JPY pairs; with the Mac's 100, a JPY-pair R is ten times too small | no |
| D-08 | Dojix | KillZone counts trading days by **open** day, WhatToCut by **close** day | Both use the close day, which is Greenwick's rule | no |
| D-09 | Dojix | News-event heuristics use the computer's calendar, while the comments say UTC | UTC for FX events. Greenwick already uses ET | no |
| D-15 | Dojix | cTrader and OANDA CSV volume (units) is stored raw as lots | Units ÷ 100,000 = lots, the same as the Mac's OANDA API path | no (size analytics only) |
| D-16 | both | TradingView entry and exit rows are each a trade, with no close time or price | Paired by Trade # into one round trip | **yes** (count, win rate) |
| D-17 | both | Streaks: MetricsCalculator lets breakevens pass; StreakCard counts them as losses | **No change.** Documented per component | — |
| D-18 | both | Unknown MAE/MFE (non-MT5 imports) is stored as 0 and averaged in | Stored as NULL; averages exclude unknowns; shown as "—" | **yes** (average MAE/MFE) |
| D-19 | both | NFP "week 1" depends on the locale (Dojix) or on Monday/minDays-4 weeks (Greenwick misses months that start on a Friday) | "First Friday of the month" | no |
| D-20 | both | DrawdownRecovery adds +1 to the duration of unrecovered drawdowns only | The same duration rule for both | no |
| D-21 | Dojix | 32-column file: an unquoted comma in Comment shifts every later column | Extra fields are re-joined into Comment | no |
| D-22 | Greenwick | Option rows (BTO/STC, Buy to Open, `*_TO_OPEN`) imported as shares without the ×100 multiplier | Skipped, with a count ("options aren't supported yet") | **yes** (if a file has options) |
| D-23 | Greenwick | Schwab: the last line is always dropped and a header on line 0 gives 0 trades | The footer is detected, and the header is found on line 0 or 1 | **yes** (missing trade) |
| D-24 | Greenwick | Fidelity price falls back to column 0 (the date), so the row is silently skipped | No fallback; the row is reported | no |
| D-25 | Greenwick | Unmatched FIFO legs: buys are logged, sells dropped silently | Both reported as skipped with a reason | no |
| D-26 | Greenwick | Same-date sell then buy in date-only exports is recorded as a long | Ties broken by file order to detect the short | no (P&L unchanged) |
| D-27 | Greenwick | Robinhood fees are never read | Fees read when the column exists | **yes** (P&L by fees) |
| D-28 | Dojix | The Pulse edge signal (and the active danger zone) is computed once, when the screen appears | Recomputed when the UTC hour or the active sessions change, when a danger zone starts or ends, and after the calendar loads (`pulseRefreshKey` / `nextPulseRefreshAt`) | no |
| D-29 | Dojix | Broker tickets from two different platforms can collide, and the second trade is skipped as a duplicate (UNIQUE ticket) | **No change**, which keeps Mac-backup interop. Documented in Help | — |

**"Headline? yes"** means the entry can change a number on the Dashboard header for some input.
`parity-check` then requires the entry to be marked approved (see "Open questions").

**Proposed, not approved** (in `golden/divergences.yaml` with `approved: false`, no fix in either
compat mode; they cover no difference until the maintainer decides, see C3):

| ID | App | Mac behaviour (confirmed by the Tier B reference) | Proposed fix | Headline? |
|---|---|---|---|---|
| D-30 | Greenwick | A skipped ET wall time (spring-forward gap) fails `MM/dd/yyyy` and is then read day-first: `03/08/2026 02:30:00` becomes 3 August 2026 | Don't fall through to a day-first format for a time the gap rejected | yes |
| D-31 | Dojix | The compact cTrader header (`PositionId`, `EntryTime`, `CloseTime`, `ClosePrice`) is detected as cTrader but its close columns stay unmapped: 0 trades | Map the compact close columns | yes |
| D-32 | Greenwick | Fidelity without a price column reads column 0 (the Run Date) as the price, so the month becomes the price (`02/03/2026` → 2) | Never take the price from the date; report the row (as D-24 intends) | yes |

### B2. Platform and design differences

| Area | Mac | Desktop | Reason |
|---|---|---|---|
| Journal file | `Dojix.sqlite` (`DJXJ`) / `Greenwick.sqlite` (`GWJN`) | `journal.sealed` (`DXJN`, same construction) | The payload is the desktop schema, so a distinct magic avoids any mix-up |
| KDF for App Lock and desktop backups | PBKDF2-SHA256, 600,000 | Argon2id (64 MiB, t = 3, p = 1), with parameter bounds | Memory-hard. No compatibility constraint: App Lock items never leave the machine, and the Mac can't restore a desktop-schema backup anyway. PBKDF2 kept for reading Mac backups |
| Backup format | `DJXB` / `GWBK` | `DXBK`. Reads `DJXB`, `DOJX`, `GWBK`, `SJNL` and plain Mac backups | As above |
| Credential store | macOS Keychain (`WhenUnlockedThisDeviceOnly`) | Windows Credential Manager (no per-app ACL) / Linux Secret Service | Platform. The App-Lock-off risk is the same as stated in the Mac SECURITY.md |
| No keyring (Linux) | n/a | App Lock is mandatory; the wrapped key lives in the data folder; rollback and throttle records stay inside the folder, and this is disclosed | Never fall back to an unencrypted journal |
| Screenshot format | Dojix `DJXS` (no associated data) / Greenwick `GWSC` (header + file name as associated data) | `DXSC` = Greenwick's construction for both brands | The stronger variant |
| Screenshot input limits | No byte limit | 25 MB and 100 megapixels per input file | Memory-exhaustion guard |
| Certificate pinning | Dojix: none (system trust). Greenwick: pins CA keys for two hosts | No pinning; OS trust store; host allow-list | Pins can't be hot-fixed in an installed open-source app, and the earlier Mac pins broke on provider rotations |
| Twelve Data REST key | In the URL query | `Authorization` header | Keeps the key out of URLs and logs |
| Twelve Data daily counter | Per service instance (not enforced in practice), one per request | Persisted per UTC day, one credit per symbol (Twelve Data's own accounting) | Correct quota display |
| Twelve Data WebSocket heartbeat | Answers the server's heartbeat with `{"event":"heartbeat"}` | Sends `{"action":"heartbeat"}` every 10 s (the provider's documented client heartbeat) | Keeps the stream open |
| Polygon WebSocket auth | Reads only the first message after `auth`; Polygon sends a `connected` status first, so every connection is treated as an auth failure | Waits for `auth_success` / `auth_failed` | Bug |
| Live price symbols | Each source's own names (`EURUSD.r` from MT5 never matches the watchlist's `EUR/USD`) | One form for every source (`EUR/USD`); only the requested symbols reach the window | Bug; a feed can't inject other text |
| Economic calendar dates | An event whose date can't be read gets the current time, which can invent a high-impact danger zone "now" | The event is dropped | Bug |
| Economic calendar refresh | Reloaded every 15 min while Pulse is open; a failure clears nothing but shows an error | Checked every 2 min, reloaded after 15 min, never fetched twice within 2 min; a failure keeps the last copy marked stale (offline failures are silent) | The feed has no SLA and rate-limits hard |
| Finnhub | No local rate limit; profile includes the logo and web address | At most 60 lookups a minute; logo and web address dropped (the web view loads no remote content) | Avoids provider lock-outs; CSP |
| AI prompt labels | Group labels as stored | Control characters removed from labels (a symbol can't add lines to the summary) | Shape check in the shell |
| AI average MAE/MFE | Unknowns count as 0 | In `fixed` compat (D-18) "n/a" when no value is known | Consistent with D-18 |
| AI model list, test | Settings → Test is per data source only | Anthropic key test = one model-list call (bills nothing) | Free check |
| AI switch | Greenwick: "Allow AI analysis". Dojix: key + click | The switch in both brands | Consistent opt-in |
| AI model | Hard-coded per brand | Same defaults, plus an advanced picker from the provider's model list | Survives model retirement |
| AI results | In memory only | Saved in the journal (`ai_reports`), shown as history | Usefulness. Encrypted with the journal |
| AI disclosure (Greenwick) | The text omits the position-size section | The text and the exact preview list everything | Accuracy |
| Watchlist, checklist rules, MT5 settings | Plain preferences file | Inside the encrypted journal | They describe the user's trading. Non-sensitive UI preferences stay in a plain `prefs.json` |
| MT5 watcher | Always on; Wine Common + default terminal folder, or one custom folder | **Off by default**; multi-terminal discovery; several folders; preview before enabling | Decision: opt-in, read-only |
| Broker server time | Read as UTC, no setting | The same by default, plus an opt-in broker zone | Lets users correct hour/session buckets |
| Scan Folder | Only the last file's confirmation survives | One queue and one combined summary | Bug |
| Import history | Session only | Saved | Usefulness |
| Skipped rows | Dropped silently | Reported with row and reason | Transparency |
| Encodings and delimiters | UTF-8 / CP1252 (Dojix also tries UTF-16LE; it never triggers); comma only | Adds BOM sniffing, UTF-16LE/BE, semicolon, tab and decimal comma | MT5 reports are UTF-16; European CSVs. A superset, so every Mac-parsable file parses the same way |
| CSV export | Dojix 27 columns (no notes, tags, emotion, costs, comment) | The same 27 first, plus those appended | Completeness without breaking column positions |
| Greenwick session countdown | Ignores weekends and holidays (Friday evening counts to Saturday 04:00) | Skips weekends and NYSE full-day holidays | Display only. Analytics unchanged |
| Add Trade | Greenwick only | Both brands (Dojix in lots/pips) | Same feature on both |
| About window | Exists, but no menu item opens it | Help → About | Reachability |
| Help: shortcuts page | Omits ⌘E, ⇧⌘E, ⌘? (Dojix) | Lists every shortcut | Accuracy |
| Sample trades | Partly random per load; Greenwick uses real ticker symbols while the copy says "made-up tickers" | Seeded per load (dates relative to now); the copy says "fictional trades" | Reproducible tests; accurate copy |
| Password rule | Dojix 8–128; Greenwick minimum 8, no maximum | 8–128 for both | One rule |
| Save failure while locking | Greenwick holds the journal decrypted behind the lock screen and asks before quitting | The same for both brands | Greenwick's rule is the safer one |
| Erase confirmation | Greenwick: Touch ID / Mac password; Dojix: an alert | Type the app name (both platforms). Windows Hello / account password (`UserConsentVerifier`) is planned on top, where available | Closest platform equivalent; the Hello prompt is not in phase 1S yet |
| Password recovery copy | Greenwick, signed builds only (the released builds are unsigned) | None | Matches the shipped builds |
| Automatic snapshots | None | Before migrations, plus daily (keep 7), sealed | Recovery without plaintext |
| Web view after a lock | SwiftUI views are released | Query caches cleared, the lock route loaded in a fresh document; the JS heap can't be zeroed on demand | Platform. Disclosed in SECURITY.md |
| Data folder and identifiers | `com.dojix.app` / `com.greenwick.app` | `io.github.djctwo.dojix` / `io.github.djctwo.greenwick` | A future macOS build can never touch the native apps' data |
| Control characters on restore | Dojix strips Apple's `controlCharacters` set (Cc and Cf, so zero-width joiners too) | Both brands use Greenwick's definition: Cc plus U+2028/2029 (Dojix strips them, Greenwick refuses the row) | Keeps emoji sequences in notes intact |
| Dev overrides | `DOJIX_DATA_DIR`, `DOJIX_KEYCHAIN_SERVICE`, `GREENWICK_*` (Debug only) | `--data-dir`, `--vault-service` (debug and `e2e` builds only) | Same rule: release builds ignore them |

### B3. Retired: fixed on the Mac since the first draft (now parity)

The first draft listed these as Mac bugs. The current Mac apps already behave correctly, and
the desktop matches them:

- **MT5 folder:** watches the shared folder and the terminal folder, honours a custom folder,
  scans at start and polls for in-place rewrites.
- **Streaming prices** are rendered on Pulse and in the sidebar.
- **"Forgot password?"** erases the local data (no silent removal of the lock). Turning App
  Lock off needs the current password.
- **Password-protected backups** can be restored (`DJXB` / `GWBK`, and the 1.x formats are
  read).
- **D-07** Re-importing a ticketless file creates no duplicates: content tickets in both apps.
- **D-10** Greenwick P&L is net of commissions and fees.
- **D-11** Greenwick FIFO prorates costs by each side's own size.
- **D-12** Greenwick shorts are recorded as SELL (except D-26).
- **D-13** Greenwick GapAnalysis sorts by zero-padded ET day keys.
- **D-14** Greenwick components use the ET trading calendar (the remaining local uses are
  parity, see A1).
- **Onboarding** appears once.
- **KillZone / WhatToCut export** uses a Save dialog.
- **CSV export** no longer prefixes negative numbers.
- **The journal is encrypted at all times,** not only on quit.
- **The cTrader and OANDA API path** already converts units (only the CSV path remains: D-15).

---

## C. Open questions for the maintainer

Both were answered on 2026-10-27:

1. **The headline-affecting fixes D-16, D-18, D-22, D-23 and D-27 are approved.** Each one can change
   a Dashboard header number compared with the Mac app *for the affected files only* (TradingView
   exports; trades without MAE/MFE; Greenwick files with options, a Schwab file with no footer, or
   Robinhood fees). Each is logged and tested.
2. **No Windows → Mac backup export in v1.** Mac → Windows is supported; the reverse can follow when
   someone asks.
3. **Open: D-30, D-31 and D-32** (proposed by the importers team, 2026-10-27; table under B1). Each
   would change Dashboard numbers for the affected files, so each needs an approval before it is
   implemented.
