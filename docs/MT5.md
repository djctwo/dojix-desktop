# MT5 auto-import (Dojix)

How the desktop app finds MetaTrader 5's files, watches the folders the user enables, and
imports new trades. The design is in [SPEC.md §5.4](SPEC.md); this page is the reference for
the code and for the Settings screen.

## What it does

- **Off by default.** Nothing in MetaTrader's folders is read until the user enables a folder
  in Settings → MT5.
- **Strictly read-only.** The Rust module `src-tauri/src/mt5/` can list, stat and read files,
  nothing else. A test (`apps/desktop/src/mt5/readonlyGate.test.ts`) fails the build if any
  write, create, rename, delete or permission API appears there. Files are opened with full
  sharing on Windows, so MetaTrader is never locked out.
- **Paused while locked.** When the journal locks, the watcher stops; it starts again when the
  UI calls `mt5_status` after unlocking.
- **Files it picks up:** `DojixExport_*.csv` (written by [`mql5/DojixExport.mq5`](../mql5/README.md))
  and, once the user enters their file-name prefix, files in the 32-column MT5 CSV format.
  Other CSV files are listed as "not a trade file" and never read.

## Where MetaTrader 5 writes

| Location | Windows | Linux (Wine) |
|---|---|---|
| Shared folder (scripts using `FILE_COMMON`, including DojixExport) | `%APPDATA%\MetaQuotes\Terminal\Common\Files` | `<prefix>/drive_c/users/<user>/AppData/Roaming/MetaQuotes/Terminal/Common/Files` (older prefixes: `Application Data`) |
| One terminal's own folder | `%APPDATA%\MetaQuotes\Terminal\<32-hex id>\MQL5\Files` | the same under the Wine user's `AppData\Roaming` |
| Portable install | `<install folder>\MQL5\Files` (found one level under Program Files when `terminal64.exe` is next to it) | `<prefix>/drive_c/Program Files/<install>/MQL5/Files` |

Each terminal folder has an `origin.txt` (UTF-16LE) holding the install folder, such as
`C:\Program Files\<Broker> MetaTrader 5`. Its last part becomes the label, so the user can tell
terminals apart. Wine prefixes searched: `$WINEPREFIX`, `~/.wine`, `~/.mt5`. Folders the user
adds with "Add folder…" are listed too. Links and junctions inside a watched folder are never
followed.

## How a file is imported

1. **Triggers:** folder events (ReadDirectoryChangesW / inotify) plus a scan at start and a poll
   every 60 s, which catches in-place rewrites, network drives, Wine, and a `Common\Files`
   folder that MetaTrader creates later.
2. **Debounce:** a burst of events waits until the file has been quiet for 2 s.
3. **Stable file:** size and modification time must be unchanged across two looks 1 s apart. A
   file whose last line has no line ending yet waits for the next poll; after two unchanged polls
   it is imported as it is (the importer reports a cut-off last row as skipped).
4. **Busy file:** if another program holds the file without sharing it, the watcher tries again
   after 5 s, doubling up to the poll interval.
5. **Ledger:** each handled file's path, size, modification time and SHA-256 are kept in the
   journal (`watched_files`). An unchanged file is never read again; a file whose bytes are the
   same as last time is not imported again. A rewritten file is imported whole and its earlier
   rows are skipped as duplicates by ticket.
6. **Queue → web view → commit:** the watcher queues the file and emits `mt5_file_ready`. The web
   view reads the queued bytes (`mt5_read`), parses them with `packages/importers` (the same
   parser as a manual import) and sends the result to `mt5_import_commit`. The shell checks every
   row again (the restore rules in SPEC §4.3, and only the three MT5 formats), then writes the
   trades, an `import_batches` row (origin `mt5_watch`) and the ledger row in one transaction and
   one save. The web view can read only files the watcher queued.

`apps/desktop/src/mt5/autoImport.ts` is the web view's half; `App.tsx` runs it (through
`useMt5AutoImport`) whenever the Dojix journal is unlocked.

## Commands and TypeScript bindings

The bindings are on the `Ipc` interface (`apps/desktop/src/ipc.ts`, `Mt5Ipc`); the shapes are in
`@dojix-desktop/core` (`packages/core/src/mt5.ts`). Every command fails with `locked` while the
journal is locked. In Greenwick builds every MT5 command fails with `unsupported`.

| Binding | Command | Returns | Notes |
|---|---|---|---|
| `mt5Discover()` | `mt5_discover` | `Mt5Location[]` | Every folder found plus the user's own, each with `enabled`, counts and a preview (newest trade files first, at most 20). Use it for the "Find MetaTrader 5" list. Reads folder listings only |
| `mt5Status()` | `mt5_status` | `Mt5Status` | The watcher's folders (`watching` / `polling` / `missing`), recent files with their state, the queue and the last result. **Also starts the watcher** after an unlock; the auto-import hook calls it |
| `mt5WatchSet(id, enabled)` | `mt5_watch_set` | `Mt5Status` | Turns one listed folder on or off (the opt-in). `id` comes from `mt5Discover()` |
| `mt5AddFolder()` | `mt5_add_folder` | `Mt5Location \| null` | "Add folder…": the folder dialog opens in the shell. The folder is listed with its preview but not enabled |
| `mt5RemoveFolder(id)` | `mt5_remove_folder` | `Mt5Status` | Removes an added folder (and stops watching it) |
| `mt5SetPrefix(prefix \| null)` | `mt5_set_prefix` | `Mt5Status` | The 32-column files' name prefix; `null` clears it. Refused (`invalid_prefix`) when empty, longer than 64 characters, or containing `/ \ : * ? " < > \|` or control characters |
| `mt5Rescan()` | `mt5_rescan` | `Mt5Status` | Looks at the enabled folders now ("Scan now") |
| `mt5Read(token)` | `mt5_read` | `Uint8Array` | A queued file's bytes, checked against what was queued. Errors: `not_pending`, `changed` (queued again), `gone`, `busy_file` |
| `mt5ImportCommit(token, outcome)` | `mt5_import_commit` | `Mt5ImportSummary` | Used by the auto-import module only. Errors: `not_pending`, `invalid_import`, `save_failed` |

Events (`ShellEvent`): `mt5_file_ready` (payload: the queue length), `mt5_imported` (payload:
`Mt5ImportSummary`, for a toast such as "3 new trades imported from MT5"), and `trades_changed`
(trades were added outside the UI).

File states (`Mt5FileState`) for the Settings list: `waiting`, `partial` (last line still being
written), `busy`, `pending`, `imported`, `unchanged`, `deleted`, `not_trade_file`, `failed`,
`denied`, `too_large`.

Settings (journal key `mt5`): `{ enabled: string[], custom: string[], prefix32: string | null }`,
bounded on read (at most 64 folders each, no empty or NUL paths, an invalid prefix dropped).

### Settings screen checklist

- "Find MetaTrader 5": `mt5Discover()`; show the label, the path, `exists`, the counts and the
  preview, with a switch per folder (`mt5WatchSet`). Explain that nothing is read until a folder
  is switched on.
- "Add folder…": `mt5AddFolder()`; added folders can be removed (`mt5RemoveFolder`).
- 32-column prefix field: `mt5SetPrefix`.
- Status: `mt5Status()` (folders, recent files, last result); "Scan now": `mt5Rescan()`.
- Several accounts: 32-column files use one name per day for every account, so two terminals
  writing to `Common\Files` overwrite each other's file; DojixExport file names carry the login.

## Tests

- `apps/desktop/src-tauri/tests/mt5.rs` (CI, Windows and Linux): discovery on synthetic trees
  (Windows layout, Wine prefixes, `origin.txt` encodings, links not followed); the watcher with
  files created, rewritten in place, partly written, still growing, held without sharing
  (Windows), deleted, touched without changes, changed after queueing, other CSVs, a folder
  created later, several folders, restarts with the ledger; the commit's row checks; a
  deny-write folder (Windows ACL / Unix mode bits); and the whole tree hashed before and after.
- `apps/desktop/src-tauri/tests/mt5_idle_cpu.rs`: an idle watcher on four folders uses under 1%
  CPU (default clocks, and a 500 ms poll).
- `apps/desktop/e2e/run.mjs --scenario mt5` (real binary, Windows and Linux): the full path
  through the web view's importer, including the tree hash.
- `apps/desktop/src/mt5/*.test.ts`: the web view's half, the read-only gate, and the exporter's
  output format against `mql5/samples/`.

## Known limits

- One account row in v1: every auto-imported trade goes to the default account (the
  `Account` column of DojixExport files is not mapped yet).
- Tickets are unique across the journal, so two brokers that reuse the same position number
  would collide (the second is skipped as a duplicate). The same is true on the Mac.
- Parsing runs on the web view's main thread; a 50 MB file can pause the window briefly.
- OS notifications ("12 new trades imported") are not wired yet; the `mt5_imported` event
  carries what a toast needs.
