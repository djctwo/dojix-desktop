# Online features: shell commands and bindings

How the UI uses the online features (SPEC §8). Rust: `apps/desktop/src-tauri/src/net/*`.
TypeScript: the types in `@dojix-desktop/core` (`online/types.ts`), the prompt builders in
`@dojix-desktop/ai-prompts`, and the bindings `tauriOnlineIpc` in `apps/desktop/src/ipc.ts`
(`createOnlineIpc(ipc)` in `apps/desktop/src/ipc/online.ts` gives the same bindings over the mock
IPC for browser development; see docs/UI.md). The commands are typed in the IPC contract
(`apps/desktop/src/ipc/contract.ts`).

## Rules the shell enforces

- **The web view never touches the network.** CSP `connect-src ipc: http://ipc.localhost`;
  no http/websocket plugin; every request is made in Rust (a test checks the config).
- **Off by default.** AI analysis has its own switch (both brands), live prices start with no
  source, Finnhub has its own switch, OANDA import runs only when the user clicks. The economic
  calendar is the one exception (a public feed, no key): on by default, with a toggle.
- **Keys** live only in the OS credential vault (Windows Credential Manager, Secret Service).
  `set_secret` / `has_secret` / `delete_secret` never return one; no command reads a key for the
  web view. Provider results go through a no-echo check (a response that repeats a stored key
  is refused). On Linux without a Secret Service, keys can't be stored (`keyringAvailable:
  false`): they would otherwise sit on disk.
- **HTTPS / WSS only**, to per-provider host lists; redirects only to the same host over HTTPS;
  OANDA page URLs are checked before the token is sent.
- **TLS uses the operating system's trust store** (`rustls-platform-verifier`). **No
  certificate pinning** (SPEC 8.1, PARITY B2): pins can't be hot-fixed in an installed
  open-source desktop app, and the Mac pins broke on provider certificate rotations. Greenwick's
  Mac app pins two CA keys; that is a logged difference.
- **Limits:** every request has a timeout (30 s; AI 300 s Dojix / 180 s Greenwick); every body
  is read with a cap (AI 4 MB, OANDA page 16 MB, others 0.25–2 MB); WebSocket messages 1 MB;
  OANDA stream lines 64 KB; MT5 price file 256 KB. Streams reconnect after 2, 4, 8 … 60 s, at most
  10 times in a row, and stop at once on a refused key.
- **Nothing is cached on disk.** The calendar copy and Finnhub caches live in memory and are
  dropped when the journal locks; the price stream stops on lock.
- **No telemetry.** Logs hold no keys, prices, trade data, paths or response bodies.
- Every command needs an **unlocked journal** (error `locked` otherwise).

## Commands

All return `Promise<T>` and reject with a `NetError` (`{ code, message, retryAfterSecs? }`).

| Binding (`tauriOnlineIpc`) | Command | Returns | Notes |
|---|---|---|---|
| `settings()` | `online_settings_get` | `OnlineSettingsView` | Switches, model, live source, which keys are stored (booleans) |
| `updateSettings(patch)` | `online_settings_set` | `OnlineSettingsView` | Changing the live source or OANDA host stops the stream; `aiModel: ""` resets the model |
| `setSecret(account, value)` | `set_secret` | `void` | Trimmed, printable ASCII, ≤ 512; OANDA account ID `[A-Za-z0-9-]{1,64}` |
| `hasSecret(account)` | `has_secret` | `boolean` | A vault that can't answer is an error, not `false` |
| `deleteSecret(account)` | `delete_secret` | `void` | |
| `testConnection(provider)` | `test_connection` | `TestResult` | Sends only what the Mac's Test sends: one model-list call, one EUR/USD or AAPL quote, an account summary, or checks the MT5 file's age |
| `aiModels()` | `ai_models` | `ModelInfo[]` | The advanced model picker (bills nothing) |
| `aiPreview(prompt)` | `ai_preview` | `AiPreview` | The exact request (headers with the key shown as a placeholder, body bytes, SHA-256). Needs neither a key nor the switch |
| `aiRun(prompt, requestSha256, consent)` | `ai_run` | `AiReport` | Needs the switch and a key; refuses a body that differs from the preview; the first run needs `consent: true`; one run at a time; the answer is saved in `ai_reports` |
| `aiReports(limit)` | `ai_reports_list` | `AiReport[]` | Newest first, ≤ 500 |
| `deleteAiReport(id)` | `ai_report_delete` | `void` | |
| `quotesStart(symbols)` | `quotes_start` | `QuotesStatus` | Dojix. Starts the chosen source for the watchlist (≤ 32 symbols, normalised to `EUR/USD`) |
| `quotesStop()` | `quotes_stop` | `void` | |
| `quotesStatus()` | `quotes_status` | `QuotesStatus` | Status, latest price per symbol, Twelve Data credits left today |
| `calendarWeek(force)` | `calendar_week` | `CalendarWeek` | Dojix. Call every 2 min; fetched again after 15 min (`force`: after 2 min); a failed refresh returns the last copy with `stale: true` |
| `finnhubQuote(symbol)` | `finnhub_quote` | `StockQuote` | Greenwick; 30 s cache shared by every screen |
| `finnhubProfile(symbol)` | `finnhub_profile` | `CompanyProfile` | Cached for the session |
| `finnhubSearch(query)` | `finnhub_search` | `SymbolSearchResult[]` | Debounce 300 ms in the UI; ≤ 10 results |
| `oandaFetchHistory(days)` | `oanda_fetch_history` | `OandaHistory` | Dojix; `days` 1–3650 or `null` for the setting (default 90) |

Events: `onQuoteTick(handler)` (`quote_tick`, a `PriceTick`) and `onQuoteStatus(handler)`
(`quote_status`, a `StreamStatus`). Both return an unsubscribe function.

Accounts: `anthropic_api_key` (both), `twelve_data_api_key`, `polygon_api_key`,
`oanda_api_token`, `oanda_account_id` (Dojix), `finnhub_api_key` (Greenwick).

Error codes the UI should handle: `off`, `no_key`, `invalid_key`, `rate_limited` (with
`retryAfterSecs` when the provider sent one), `unavailable`, `timeout`, `offline`,
`bad_response`, `too_large`, `blocked_host`, `invalid`, `vault`, `locked`, `busy`, `refused`,
`empty`, `consent_required`, `preview_mismatch`, `not_found`, `stale`, `unsupported`, `http`.

## Flows

**AI analysis (Edge Report, both brands).**
1. Build the message: `edgeAnalysisPrompt(ctx, trades)` from `@dojix-desktop/ai-prompts`
   (aggregates only; the Mac text line for line). Offer it from 30 trades, as on the Mac.
2. "Show what will be sent": `aiPreview(prompt)`; show `DATA_SENT[brand]`, the sections
   (`promptSections(prompt)`) and the exact body.
3. Run: `aiRun(prompt, preview.requestSha256, consent)`. On `consent_required`, show
   `consentText(brand)` and run again with `consent: true`. When the switch is off or there is
   no key, show `aiOffText(brand)`.
4. History: `aiReports(n)`. Render `responseText` as Markdown without raw HTML (SPEC 11).

Defaults: `claude-opus-5-5` (Dojix, with server-side fallback), `claude-sonnet-5-5`
(Greenwick); `max_tokens` 16000, effort `medium`, `anthropic-version: 2023-06-01`.

**Live prices (Pulse, Dojix).** Pick a source in Settings (`updateSettings({ liveSource })`),
store its key, `testConnection`, then `quotesStart(watchlist)` when Pulse opens and
`quotesStop()` when it closes. Ticks arrive as events; `quotesStatus()` gives the current
state for a screen that opens later. Currency strength from Twelve Data polling ticks:
`currencyStrength(ticks.map(t => ({ symbol: t.symbol, changePercent: t.changePercent ?? 0 })))`.

**Pulse edge signal (D-28).** Keep `week = await calendarWeek(false)` (every 2 minutes) and
recompute `computePulseEdgeSignals(ctx, trades, { activeDangerZone: pulseDangerState(ctx,
week).active !== null })` whenever `pulseRefreshKey(ctx, week)` changes; set one timer for
`nextPulseRefreshAt(ctx, week)`.

**OANDA import (Dojix).** `oandaFetchHistory(days)` → `decodeOandaPage({ transactions })` /
`mapOandaTransactions(...)` (`@dojix-desktop/importers`) → the normal preview and commit, with
origin `oanda`.

## Tests

`cargo test` runs the contract tests in `net/tests.rs` against local mock servers only
(wiremock for HTTP, a local tungstenite server for WebSockets; no real network in CI): for every
HTTP endpoint 401, 429 with `Retry-After`, 503, a timeout, malformed JSON and an oversized body;
WebSocket auth, refused subscriptions, oversized messages and the ten-reconnect limit; OANDA
page-host checks; the no-secret proof (canary keys stored, mocks echo them, no result contains
one; every command's return type is pinned); CSP and capability checks. Vitest covers the prompt
builders (Mac text, data minimisation on the golden fixtures, hostile input), the Pulse schedule
and currency strength, and the bindings against the shell's command list.
