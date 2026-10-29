# DojixExport for MetaTrader 5

`DojixExport.mq5` is a free, open-source Expert Advisor (GPL-3.0-or-later) that writes your
closed MT5 positions to a CSV file Dojix imports. It only **reads** your account history: it
never places, changes or closes orders, and it reads no passwords.

## Install

1. In MetaTrader 5: **File → Open Data Folder**. Open `MQL5\Experts` and copy
   `DojixExport.mq5` into it.
2. In MetaTrader 5, open the **Navigator** (Ctrl+N), right-click **Expert Advisors** and choose
   **Refresh**. Double-click `DojixExport.mq5` to open it in MetaEditor and press **Compile**
   (F7). It should compile with no errors.
3. Drag **DojixExport** from the Navigator onto any chart. On the **Common** tab nothing needs
   to be allowed (it doesn't trade). Click **OK**. One chart per account is enough.
4. In Dojix: **Settings → MT5 → Find MetaTrader 5**, and switch on **All terminals
   (Common\Files)**. Dojix imports each file as it appears or changes.

On Linux (Wine), the steps are the same inside MetaTrader; Dojix finds the Wine prefix
(`~/.mt5`, `~/.wine` or `$WINEPREFIX`).

## What it writes

- **File:** `DojixExport_<login>_<YYYYMMDD>.csv` in MetaTrader's shared folder
  (`%APPDATA%\MetaQuotes\Terminal\Common\Files`), one file per account per day (UTC date). It
  is written under a temporary name (`.tmp`) and then renamed, so Dojix never sees a
  half-written file. Older days' files are left in place; you can delete them.
- **Format:** UTF-8, comma-separated, CRLF line endings, a header line, then one row per
  position closed in the last *Days of history* days.
- **Columns:** the 32-column MT5 CSV layout, then `Account`, `Commission`, `Swap`, `TimeBasis`
  and `ServerUTCOffset`. Any program that reads the 32-column format reads this file too.

| Column | Value |
|---|---|
| `Ticket` | The position ID |
| `Lots`, `OpenPrice`, `ClosePrice` | Total entry volume; volume-weighted entry and exit prices |
| `OpenTime`, `CloseTime` | **UTC**, `yyyy.MM.dd HH:mm:ss` (`TimeBasis` is `UTC`) |
| `NetProfit` | Profit + commission + fees + swap (the `Commission` and `Swap` columns show those parts) |
| `SL`, `TP` | From the entry deal, or the entry order when the deal has none |
| `MAE_Pips`, `MFE_Pips`, `TimeToMFE_Min` | From M1 bars between entry and exit (empty when bars aren't available) |
| `RMultiple`, `SLDist_Pips` | Price move ÷ stop distance; the stop distance in pips (0 without a stop) |
| `Slippage_Pips` | Entry price against the price the entry order asked for (adverse is positive) |
| `PostClose15m`, `PostClose30m` | Pips the price moved in the trade's direction 15 / 30 minutes after the exit |
| `Session`, `DayOfWeek`, `Hour` | From the UTC open time (Asian 0–6, London 7–11, NY overlap 12–15, NY 16–20, late 21–23) |
| `HitBreakeven`, `ScaledIn` | `YES` when the stop was at the entry price at the exit; `YES` with more than one entry deal |
| `RangeSize`, `SweepDepth`, `UsedFVG`, `VolRegime`, `BiasAtEntry` | Left empty (strategy-specific; Dojix shows them as unknown) |
| `ServerUTCOffset` | Seconds the server clock was ahead of UTC at the open |

A pip is 10 points on 3- and 5-digit quotes and one point otherwise. A fictional example is in
[`samples/`](samples/).

## Settings

| Input | Default | Meaning |
|---|---|---|
| Days of history to export | 90 | 0 exports the whole history |
| Export again every N minutes | 15 | 0 exports only when the EA starts |
| Also export within a minute after a deal | true | Picks up a closed trade quickly |
| Server daylight-time rule | Auto | How to turn server times into UTC: *Auto* treats UTC+2/+3 servers as following US daylight time (the usual "New York close" servers) and anything else as a fixed offset; or choose *Fixed*, *US* or *European* |
| Compute MAE / MFE from M1 bars | true | Turn off for very long histories if exports are slow |

## Notes

- Netting accounts: a reversal is exported as part of the same position.
- A position that is still partly open is exported once it is fully closed.
- The CI can't compile MQL5 (MetaEditor isn't available on the build machines), so the file is
  kept simple, and a test checks that its header, its row layout and the sample file match what
  the Dojix importer reads (`apps/desktop/src/mt5/dojixExport.test.ts`). If MetaEditor reports
  an error, please open an issue with the message.
