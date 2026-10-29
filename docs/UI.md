# UI foundation (Phase 3)

How the screens of Dojix and Greenwick are built: the design system, the data layer, the mock IPC,
the analytics card framework and the tests. Read this before adding a screen or a card.

## Map

| Where | What |
|---|---|
| `packages/ui/` | The design system. React only: no IPC, no Tauri, data comes in through props. |
| `packages/ui/src/theme/` | `theme.css` (shared tokens: semantic palette, type scale, spacing, motion), `tokens.ts` (`applyBrandTokens`, `readThemeColors`, `pnlTone`, session and pair colours), `contrast.ts` |
| `packages/ui/src/fonts/` | DM Sans + JetBrains Mono, the files the Mac apps bundle (SIL OFL, licences next to them). Never loaded from the network. |
| `packages/ui/src/primitives/` | `Button`, `IconButton`, `Card`, `Inset`, `MetricCard`/`MetricGrid`, `Badge`, `Kbd`, `HelpTip`, `PillTabs`/`TabPanel`, `SegmentedControl`, `Section`, screen icons |
| `packages/ui/src/states/` | `EmptyState`, `LoadingState`, `ErrorState`, `Skeleton`, `QueryState` |
| `packages/ui/src/feedback/` | `ToastProvider`/`useToast` (3.5 s; Undo 5 s), `Dialog`, `ConfirmDialog` |
| `packages/ui/src/forms/` | `Field` (label, hint, error wiring), `TextInput`, `TextArea`, `Select`, `Checkbox`, `Switch` |
| `packages/ui/src/table/` | `DataTable` (TanStack Table v8 + TanStack Virtual) |
| `packages/ui/src/charts/` | `EChart` (the one ECharts wrapper), `chartTheme`, the modular ECharts registration |
| `packages/ui/src/shell/` | `AppShell` (sidebar), `Screen` (screen frame + `screen-title`) |
| `packages/ui/src/analytics/` | `AnalyticsCard`, `AnalyticsGrid`, `AnalyticsViewRegistry`, `defineAnalyticsView` |
| `apps/desktop/src/ipc.ts` | The **only** file that imports `@tauri-apps/api` (`boundary.test.ts`). |
| `apps/desktop/src/ipc/contract.ts` | Every command (available + planned), its arguments and result; events; `Ipc`. |
| `apps/desktop/src/mock/` | The mock IPC and its fictional fixture journals. |
| `apps/desktop/src/data/` | `IpcProvider`/`useIpc`/`useIpcEvent`, TanStack Query hooks and keys. |
| `apps/desktop/src/analytics/` | The Web Worker running the core engine, its client, `useAnalyticsRun`, `AnalyticsTab`, the app's view registry (`views.tsx`). |
| `apps/desktop/src/app/` | Launch gate (`App.tsx`), `MainWindow`, navigation, shortcuts, the app command bus, session state, providers. |
| `apps/desktop/src/screens/` | Screen skeletons: Dashboard, Analytics, Edge Report, Help, placeholders. |
| `apps/desktop/playwright/` | Playwright specs against the mock builds (smoke, a11y, visual). |

## Conventions

- **Colours only through tokens.** Brand tokens (`--bg-app`, `--accent`, `--text-secondary`, …) come
  from `brands/<brand>/brand.ts`, so the other brand never ships. Shared tokens (`--profit`, `--loss`,
  `--info`, `--warning`, the semantic hues, type sizes, radii, spacing, motion) are in `theme.css`.
  No hex values in components. Charts read the same tokens (`readThemeColors`).
- **Text contrast.** Every text token meets 4.5:1 on every surface (`theme/tokens.test.ts`). The Mac's
  tertiary grey is below 3:1, so it is for non-text marks only; text the Mac draws in it uses
  `--text-secondary`. Zero P&L uses `--flat-text`.
- **Numbers.** Never format money, percents or R yourself: use core's `asCurrency(x, locale)`,
  `asPercent`, `asProfitFactor`, `asRMultiple`, `asCompactCurrency`, with the locale from
  `useAnalyticsEnvironment().settings.locale` (or the view's `locale` prop). Numbers render in
  `.num` / `.mono` (JetBrains Mono, tabular figures).
- **States.** Every async block has loading, error (with retry) and empty states: use `QueryState` or
  the three state components. Errors from the shell are `{ code, message }`; `ErrorState` shows
  `message`.
- **Accessibility.** Keyboard first: every action reachable with Tab/Enter/Space/arrows; focus is
  always visible (`:focus-visible` ring in the accent). Icon-only buttons use `IconButton` (a label is
  required). Dialogs use `Dialog` (focus trap, Escape, focus return). Tabs and radio groups use
  `PillTabs`/`SegmentedControl` (arrow keys). Charts need `ariaLabel` with the takeaway. Motion turns
  off under the OS reduced-motion setting (CSS and ECharts). axe must report zero serious or
  critical issues.
- **Test ids.** `data-testid` on anything a spec reads. The real-binary e2e (`apps/desktop/e2e`)
  reads `brand-name`, `screen-title`, `journal-empty`, `journal-table`, `db-status`, the lock /
  setup / older-copy / erase ids: never rename those.
- **Optional props** are typed `prop?: T | undefined` (the repo builds with
  `exactOptionalPropertyTypes`).
- **No telemetry, no network, no remote assets.** The CSP allows `'self'` only for scripts, styles
  and fonts. No `console` output in app code (ESLint). Online data goes through planned Rust
  commands with the user's own keys.
- **Wording.** Plain English, sentence case, the Mac's terms. Never name other journaling products.

## Adding a screen

1. Write `apps/desktop/src/screens/<Name>Screen.tsx` rendering `<Screen title=… testId="screen-…">`.
   Read data with the hooks in `data/queries.ts` (add a hook there for a new command) and render
   it through `QueryState`.
2. Route it in `app/MainWindow.tsx` (lazy-load it if it draws charts). The sidebar entry comes
   from `brands/<brand>/brand.ts`; keyboard shortcuts from `app/shortcuts.ts` (the Help page lists
   that table automatically).
3. App-wide commands (Ctrl+E Export PDF, Ctrl+Shift+E Essential/All, Ctrl+N Add Trade, Ctrl+Enter
   confirm mapping) arrive through `useAppCommand("exportPdf", handler)`.
4. UI state that should survive screen switches (filters, column layout) goes in
   `useSessionState("screen.key", initial)`; anything that must survive a restart needs a
   `prefs_*` / `settings_*` command.
5. Add the screen to the Playwright lists in `playwright/support.ts` if it is a sidebar screen, and
   record its baseline (below).

## Adding an analytics card

The registry in `packages/core` decides **which** components exist, their brands, tab (placement)
and `minTrades`. `AnalyticsTab` runs every component of a placement in the worker and draws one
card each. A card without a view shows a preview of its model's fields, so a screen team only
writes the view:

```tsx
// apps/desktop/src/analytics/views.tsx (or a file per component, registered there)
analyticsViews.register(
  defineAnalyticsView<WinLossDistributionModel>({
    id: "WinLossDistribution", // the registry id
    title: "Win / Loss Distribution", // the Mac card title
    help: "How your wins and losses are spread by size.",
    span: 2, // 1 (default), 2 or "full"
    emptyMessage: "Not enough trades to show a distribution.",
    view: ({ model, locale, brand, tradeCount }) => <EChart option={…} ariaLabel={…} />,
  }),
);
```

`HourlyPnLChart` in `views.tsx` is the worked example. The card frame handles loading, "needs N
trades" (below `minTrades`), empty (compute returned null), compute errors and render errors (an
error boundary per card). Models cross the worker boundary by structured clone, so they must be
plain data (Maps, Dates and Infinity are fine; functions are not).

Running analytics elsewhere (the Dashboard's headline metrics, Edge Report sections):
`useAnalyticsRun({ brand, placement | componentIds, filter: { dateRange, symbol }, metrics: true })`.
The engine context comes from `AnalyticsProvider`: the computer's zone, locale and week rule
(`analytics/settings.ts`), `compat: "fixed"`; Settings (ui-tools) will override them from prefs.

## Data layer

- `ipc.call("name", args)` is fully typed from `Commands` in `ipc/contract.ts`. Commands with no
  arguments take none: `ipc.call("lock_now")`.
- Queries: `useAppInfo`, `useLockStatus`, `useJournalRows`, `useTrades`, `useSetting`;
  mutations: `useJournalMutation` (invalidates everything under `queryKeys.journal`),
  `useLockTransition`. Defaults: no retries, no refetch on focus, data is fresh until invalidated.
- `trades_changed` invalidates the journal queries; when the session is not unlocked every query
  under `journal` (trades, analytics) is removed from memory.
- Planned commands reject with `{ code: "unavailable" }` in the real app until Rust implements
  them, and the contract test fails the moment Rust registers a command the contract still calls
  planned (or the reverse). Flip `COMMAND_INFO[name].status` and add the capability in the same
  change.

## The mock IPC

`mock/mockIpc.ts` implements the contract in memory over fictional journals from
`golden/fixtures` (`f2`: a year of trades, `f1`: five trades, `empty`). It runs in a plain browser:

```sh
pnpm --filter @dojix-desktop/desktop dev:mock:dojix      # http://localhost:5174
pnpm --filter @dojix-desktop/desktop dev:mock:greenwick
```

URL parameters: `?fixture=f2|f1|empty`, `?gate=none|locked|setup|olderCopy|storageError|lockFailed|setAside|saveFailing`
(the App Lock password is `fictional-pass-1`), `?now=2026-09-30T12:00:00Z` (fixed by default so
screenshots are stable), `?latency=300`, `?fail=journal_trades,quotes_get`. Deep links:
`#/analytics/risk`, `#/settings`. In the page, `window.__mockIpc.emit("trades_changed", null)` sends
a shell event. When you build a screen on a planned command, implement it in the mock in the same
change (the mock test lists what it covers). Mock builds go to `dist-mock/` and are never
packaged; `ci.yml` fails if fixture text or the mock reaches `dist/`.

## Tests

| What | Command | Where it runs |
|---|---|---|
| Unit (design system) | `pnpm --filter @dojix-desktop/ui test` | local + ci.yml (coverage ≥ 90 % lines) |
| Unit (app: gate, shortcuts, IPC contract, mock, worker engine, screens) | `pnpm --filter @dojix-desktop/desktop test` | local + ci.yml (coverage ≥ 90 % lines) |
| Playwright smoke, shortcuts, axe | `pnpm --filter @dojix-desktop/desktop build:mock:dojix && … build:mock:greenwick && pnpm --filter @dojix-desktop/desktop test:ui` | ui.yml on Windows and Linux (CI only, per the repo rules) |
| Visual baselines | `playwright/visual.spec.ts` | ui.yml, Windows Chromium only |
| Real binary | `apps/desktop/e2e/run.mjs` | e2e.yml |

Visual baselines live in `apps/desktop/playwright/__screenshots__/win32/<brand>/`. To record or
update them, run the **ui** workflow by hand with *update_snapshots* ticked, download the
`ui-baselines` artifact and commit it. Every ui.yml run uploads `ui-<os>` with the HTML report,
traces of failures and a plain screenshot of every screen (`e2e-output/ui/screens/`).

## Window

The main window opens at 1200 × 800 (minimum 900 × 600, SPEC 2.1) and then where it was last
closed: size, position and maximised state are kept in `window.json` in the data folder
(`src-tauri/src/window_state.rs`), in logical pixels, and ignored if they are off every monitor.
Screens and filters reset at launch, as on the Mac (the app opens on the Journal).

## Who builds what (Phase 3)

| Team | Screens | Rust commands still needed (all `planned` in `ipc/contract.ts`) |
|---|---|---|
| **ui-journal** | Journal table (virtualised `DataTable`, filters, performance strip), trade detail, Add Trade, Replay, screenshots, CSV / PDF export | `journal_trades`, `journal_mutate` (+ `trades_changed` event), `checklist_rules_get/set`, `screenshot_add/list/get/delete`, `export_save`, `clipboard_write_temporary` |
| **ui-dashboard** | Dashboard (headline grid, Essential/All, First Look, DailyBrief, equity curve, filters), Analytics views for every registry component, Prop Firm | `journal_trades` (shared), `settings_get/set` (prop-firm parameters), `prefs_get/set` (Essential/All, First Look), `checkpoints_list/add/delete`, `export_save` (PDF) |
| **ui-tools** | Edge Report (+ AI card, PDF), Import (drop zone, mapping sheet, history, skipped rows), Settings (all sections beyond Security & Data), Onboarding, Help topics, About | `import_pick`, `import_preview_mapping`, `import_commit` (+ `import_progress`), `import_history`, `mapping_presets_list/save`, `sample_trades_load/remove`, `data_info`, `open_data_folder`, `diagnostics_export`, `set_secret/has_secret/delete_secret`, `test_connection`, `ai_preview`, `ai_run`, `ai_reports_list`, `updates_check`, `open_external`, `prefs_get/set` (display zone, week start, onboarding), `mt5_discover`, `mt5_watch_set` |
| **ui-brand** | Pulse (Dojix), Browse + Watchlist (Greenwick), sidebar live ticker and session clock (`AppShell` `sidebarExtras`) | `watchlist_get/set`, `quotes_get`, `quotes_subscribe/unsubscribe` (+ `quote_tick`), `symbol_search`, `company_profile`, `calendar_week` |

Available today (Phase 1 + security core): `app_info`, `journal_query` (5 columns), `lock_*`,
`older_copy_open`, `prefs_set_idle`, `erase_all`, `save_retry`, `app_quit`, `backup_export`,
`backup_pick`, `backup_restore`; events `save_failed`, `unsaved_close`, `locked`. The shapes of the
planned commands are proposals: the Rust team that implements one may refine its types, in the
contract and the mock in the same change.
