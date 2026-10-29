//+------------------------------------------------------------------+
//| DojixExport.mq5                                                  |
//| Writes your closed MT5 positions to a CSV file Dojix imports.    |
//+------------------------------------------------------------------+
// Copyright (C) 2026 Douglas Cleary
//
// This program is free software: you can redistribute it and/or modify it under the terms of
// the GNU General Public License as published by the Free Software Foundation, either version 3
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
// See the GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License along with this program.
// If not, see <https://www.gnu.org/licenses/>.
//
// What it does (see README.md next to this file):
// - Reads your account history (closed positions only). It never places, changes or closes
//   orders, and it reads no passwords or keys.
// - Writes DojixExport_<login>_<YYYYMMDD>.csv to MetaTrader's shared Common\Files folder:
//   UTF-8, comma-separated, CRLF line endings, one header line, one row per closed position.
//   The file is written under a temporary name and then renamed, so a reader never sees a
//   half-written file.
// - Columns: the 32-column MT5 CSV layout, then Account, Commission, Swap, TimeBasis,
//   ServerUTCOffset. Times are UTC. NetProfit includes commission, fees and swap; the
//   Commission and Swap columns show those parts. Strategy-specific columns (RangeSize,
//   SweepDepth, UsedFVG, VolRegime, BiasAtEntry) are left empty.
#property copyright "Copyright (C) 2026 Douglas Cleary. GPL-3.0-or-later."
#property link      "https://github.com/djctwo/dojix-desktop"
#property version   "1.00"
#property description "Exports closed positions to a CSV file for Dojix (free, open source)."
#property description "Read-only: it never places, changes or closes orders."

//--- How the server's clock moves with daylight-saving time (to turn server times into UTC).
enum ENUM_DJX_DST
  {
   DJX_DST_AUTO = 0, // Auto (UTC+2/+3 servers follow US daylight time)
   DJX_DST_NONE = 1, // Fixed offset (no daylight time)
   DJX_DST_US   = 2, // US daylight time (New York close)
   DJX_DST_EU   = 3  // European daylight time
  };

input int          InpDaysBack      = 90;           // Days of history to export (0 = all)
input int          InpIntervalMin   = 15;           // Export again every N minutes (0 = only at start)
input bool         InpExportOnClose = true;         // Also export within a minute after a deal
input ENUM_DJX_DST InpServerDST     = DJX_DST_AUTO; // Server daylight-time rule
input bool         InpMaeMfe        = true;         // Compute MAE / MFE from M1 bars

//--- The file's header line (the importer's test checks it against its sample file).
const string DJX_HEADER = "Ticket,Symbol,Direction,Lots,OpenTime,CloseTime,DurationMin,OpenPrice,ClosePrice,SL,TP,NetProfit,MAE_Pips,MFE_Pips,RMultiple,Session,DayOfWeek,Hour,RangeSize,SweepDepth,UsedFVG,VolRegime,HitBreakeven,ScaledIn,Magic,Comment,TimeToMFE_Min,SLDist_Pips,Slippage_Pips,PostClose15m,PostClose30m,BiasAtEntry,Account,Commission,Swap,TimeBasis,ServerUTCOffset";

datetime     g_last_export = 0;
bool         g_dirty       = false;
int          g_std_offset  = 0;          // server minus UTC outside daylight time, seconds
ENUM_DJX_DST g_rule        = DJX_DST_NONE;

//+------------------------------------------------------------------+
int OnInit()
  {
   if(InpDaysBack < 0 || InpIntervalMin < 0)
     {
      Print("DojixExport: days and minutes can't be negative");
      return(INIT_PARAMETERS_INCORRECT);
     }
   EventSetTimer(60);
   Export();
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

//+------------------------------------------------------------------+
void OnTick()
  {
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   bool due = (InpIntervalMin > 0 && TimeLocal() - g_last_export >= (long)InpIntervalMin * 60);
   if(g_dirty || due)
      Export();
  }

//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
  {
   if(InpExportOnClose && trans.type == TRADE_TRANSACTION_DEAL_ADD)
      g_dirty = true;
  }

//+------------------------------------------------------------------+
//| Text and time helpers                                            |
//+------------------------------------------------------------------+
string CleanText(string text)
  {
   StringReplace(text, ",", " ");
   StringReplace(text, "\"", "'");
   StringReplace(text, "\r", " ");
   StringReplace(text, "\n", " ");
   StringReplace(text, "\t", " ");
   StringTrimLeft(text);
   StringTrimRight(text);
   if(StringLen(text) > 64)
      text = StringSubstr(text, 0, 64);
   return(text);
  }

string YesNo(const bool value)
  {
   return(value ? "YES" : "NO");
  }

string DayName(const int day_of_week)
  {
   switch(day_of_week)
     {
      case 1: return("Mon");
      case 2: return("Tue");
      case 3: return("Wed");
      case 4: return("Thu");
      case 5: return("Fri");
      case 6: return("Sat");
     }
   return("Sun");
  }

//--- Dojix's session for a UTC hour: Asian 0-6, London 7-11, NY overlap 12-15, NY 16-20, late.
string SessionOf(const int hour)
  {
   if(hour >= 12 && hour < 16)
      return("NY_OVERLAP");
   if(hour >= 7 && hour < 12)
      return("LONDON");
   if(hour >= 0 && hour < 7)
      return("ASIAN");
   if(hour >= 16 && hour < 21)
      return("NY");
   return("LATE");
  }

int DaysInMonth(const int year, const int month)
  {
   if(month == 2)
      return((year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28);
   if(month == 4 || month == 6 || month == 9 || month == 11)
      return(30);
   return(31);
  }

//--- Midnight of the n-th Sunday of a month (n = -1: the last one).
datetime NthSunday(const int year, const int month, const int n)
  {
   MqlDateTime t;
   ZeroMemory(t);
   t.year = year;
   t.mon  = month;
   t.day  = 1;
   MqlDateTime first;
   TimeToStruct(StructToTime(t), first);
   int day = 1 + (7 - first.day_of_week) % 7;
   if(n > 0)
      day += 7 * (n - 1);
   else
      while(day + 7 <= DaysInMonth(year, month))
         day += 7;
   t.day = day;
   return(StructToTime(t));
  }

bool InUsDst(const datetime utc)
  {
   MqlDateTime t;
   TimeToStruct(utc, t);
   datetime start = NthSunday(t.year, 3, 2) + 7 * 3600;   // 02:00 EST
   datetime stop  = NthSunday(t.year, 11, 1) + 6 * 3600;  // 02:00 EDT
   return(utc >= start && utc < stop);
  }

bool InEuDst(const datetime utc)
  {
   MqlDateTime t;
   TimeToStruct(utc, t);
   datetime start = NthSunday(t.year, 3, -1) + 3600;      // 01:00 UTC
   datetime stop  = NthSunday(t.year, 10, -1) + 3600;
   return(utc >= start && utc < stop);
  }

bool InDst(const datetime utc)
  {
   if(g_rule == DJX_DST_US)
      return(InUsDst(utc));
   if(g_rule == DJX_DST_EU)
      return(InEuDst(utc));
   return(false);
  }

//--- The server's offset from UTC now, and the rule used for older times.
void ComputeOffsets()
  {
   datetime utc_now = TimeGMT();
   long raw = (long)(TimeTradeServer() - utc_now);
   int now_offset = (int)MathRound(raw / 1800.0) * 1800;
   g_rule = InpServerDST;
   if(g_rule == DJX_DST_AUTO)
      g_rule = (now_offset == 7200 || now_offset == 10800) ? DJX_DST_US : DJX_DST_NONE;
   g_std_offset = now_offset;
   if(InDst(utc_now))
      g_std_offset -= 3600;
  }

//--- Server minus UTC, in seconds, at a server time.
int OffsetAt(const datetime server_time)
  {
   if(InDst(server_time - g_std_offset))
      return(g_std_offset + 3600);
   return(g_std_offset);
  }

//--- One pip: 10 points on 3- and 5-digit quotes, otherwise one point.
double PipSize(const string symbol)
  {
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   long digits = SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(point <= 0.0)
      return(0.0);
   if(digits == 3 || digits == 5)
      return(point * 10.0);
   return(point);
  }

string LotsText(const double lots)
  {
   if(MathAbs(lots * 100.0 - MathRound(lots * 100.0)) < 1e-6)
      return(DoubleToString(lots, 2));
   return(DoubleToString(lots, 3));
  }

//--- Pips the price moved in the trade's direction between the exit and `at` (0 when unknown).
double PostClose(const string symbol, const datetime at, const double exit_price,
                 const bool buy, const double pip)
  {
   if(pip <= 0.0 || at > TimeCurrent())
      return(0.0);
   MqlRates bar[];
   if(CopyRates(symbol, PERIOD_M1, at, 1, bar) != 1)
      return(0.0);
   double move = buy ? (bar[0].close - exit_price) : (exit_price - bar[0].close);
   return(move / pip);
  }

//+------------------------------------------------------------------+
//| One closed position as a CSV row. False when it isn't closed.    |
//+------------------------------------------------------------------+
bool PositionRow(const long position_id, const long login, string &row)
  {
   if(PositionSelectByTicket((ulong)position_id))
      return(false);                          // still open (partly closed): export it later
   if(!HistorySelectByPosition(position_id))
      return(false);
   int deals = HistoryDealsTotal();
   if(deals <= 0)
      return(false);

   string   symbol = "";
   string   comment = "";
   long     direction = -1;
   long     magic = 0;
   ulong    entry_order = 0;
   int      entries = 0;
   double   in_volume = 0.0, in_value = 0.0, out_volume = 0.0, out_value = 0.0;
   double   profit = 0.0, commission = 0.0, swap = 0.0;
   double   sl = 0.0, tp = 0.0, exit_sl = 0.0, entry_price = 0.0;
   datetime open_time = 0, close_time = 0;

   for(int i = 0; i < deals; i++)
     {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0)
         continue;
      long type = HistoryDealGetInteger(deal, DEAL_TYPE);
      ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(deal, DEAL_ENTRY);
      double volume = HistoryDealGetDouble(deal, DEAL_VOLUME);
      double price = HistoryDealGetDouble(deal, DEAL_PRICE);
      datetime deal_time = (datetime)HistoryDealGetInteger(deal, DEAL_TIME);
      profit     += HistoryDealGetDouble(deal, DEAL_PROFIT);
      commission += HistoryDealGetDouble(deal, DEAL_COMMISSION) + HistoryDealGetDouble(deal, DEAL_FEE);
      swap       += HistoryDealGetDouble(deal, DEAL_SWAP);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL)
         continue;
      if(entry == DEAL_ENTRY_IN)
        {
         if(direction < 0)
           {
            direction   = type;
            symbol      = HistoryDealGetString(deal, DEAL_SYMBOL);
            comment     = HistoryDealGetString(deal, DEAL_COMMENT);
            magic       = HistoryDealGetInteger(deal, DEAL_MAGIC);
            entry_order = (ulong)HistoryDealGetInteger(deal, DEAL_ORDER);
            sl          = HistoryDealGetDouble(deal, DEAL_SL);
            tp          = HistoryDealGetDouble(deal, DEAL_TP);
            open_time   = deal_time;
            entry_price = price;
           }
         in_volume += volume;
         in_value  += volume * price;
         entries++;
        }
      else
         if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT)
           {
            out_volume += volume;
            out_value  += volume * price;
            if(deal_time > close_time)
               close_time = deal_time;
            exit_sl = HistoryDealGetDouble(deal, DEAL_SL);
           }
     }
   if(direction < 0 || in_volume <= 0.0 || out_volume <= 0.0 || open_time == 0 || close_time == 0)
      return(false);

   // The entry order's stops when the deal has none.
   if(sl == 0.0 && entry_order > 0)
      sl = HistoryOrderGetDouble(entry_order, ORDER_SL);
   if(tp == 0.0 && entry_order > 0)
      tp = HistoryOrderGetDouble(entry_order, ORDER_TP);

   bool   buy = (direction == DEAL_TYPE_BUY);
   int    digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(digits <= 0)
      digits = 5;
   double pip = PipSize(symbol);
   double open_price = in_value / in_volume;
   double close_price = out_value / out_volume;
   double net = profit + commission + swap;
   long   duration = (long)(close_time - open_time) / 60;
   double risk = (sl > 0.0) ? MathAbs(open_price - sl) : 0.0;
   double move = buy ? (close_price - open_price) : (open_price - close_price);
   double r_multiple = (risk > 0.0) ? move / risk : 0.0;
   double sl_pips = (risk > 0.0 && pip > 0.0) ? risk / pip : 0.0;

   // Slippage: the deal's price against the price the entry order asked for (adverse > 0).
   double slippage = 0.0;
   if(entry_order > 0 && pip > 0.0)
     {
      double requested = HistoryOrderGetDouble(entry_order, ORDER_PRICE_OPEN);
      if(requested > 0.0)
         slippage = (buy ? (entry_price - requested) : (requested - entry_price)) / pip;
     }

   // MAE / MFE from M1 bars between entry and exit.
   string mae_text = "", mfe_text = "", ttmfe_text = "";
   if(InpMaeMfe && pip > 0.0)
     {
      MqlRates rates[];
      datetime first_bar = (datetime)(((long)open_time / 60) * 60);
      int got = CopyRates(symbol, PERIOD_M1, first_bar, close_time, rates);
      if(got > 0)
        {
         double best = 0.0, worst = 0.0;
         long   best_at = 0;
         for(int b = 0; b < got; b++)
           {
            double favourable = buy ? (rates[b].high - open_price) : (open_price - rates[b].low);
            double adverse    = buy ? (open_price - rates[b].low) : (rates[b].high - open_price);
            if(favourable > best)
              {
               best = favourable;
               best_at = (long)(rates[b].time - first_bar) / 60;
              }
            if(adverse > worst)
               worst = adverse;
           }
         mae_text   = DoubleToString(worst / pip, 1);
         mfe_text   = DoubleToString(best / pip, 1);
         ttmfe_text = IntegerToString(best_at);
        }
     }

   double tolerance = (pip > 0.0) ? pip * 0.5 : SymbolInfoDouble(symbol, SYMBOL_POINT);
   bool   breakeven = (exit_sl > 0.0 && MathAbs(exit_sl - open_price) <= tolerance);
   double post15 = PostClose(symbol, close_time + 15 * 60, close_price, buy, pip);
   double post30 = PostClose(symbol, close_time + 30 * 60, close_price, buy, pip);

   int      offset = OffsetAt(open_time);
   datetime open_utc = open_time - offset;
   datetime close_utc = close_time - OffsetAt(close_time);
   MqlDateTime ot;
   TimeToStruct(open_utc, ot);

   row = IntegerToString(position_id) + "," +
         CleanText(symbol) + "," +
         (buy ? "BUY" : "SELL") + "," +
         LotsText(in_volume) + "," +
         TimeToString(open_utc, TIME_DATE | TIME_SECONDS) + "," +
         TimeToString(close_utc, TIME_DATE | TIME_SECONDS) + "," +
         IntegerToString(duration) + "," +
         DoubleToString(open_price, digits) + "," +
         DoubleToString(close_price, digits) + "," +
         DoubleToString(sl, digits) + "," +
         DoubleToString(tp, digits) + "," +
         DoubleToString(net, 2) + "," +
         mae_text + "," +
         mfe_text + "," +
         DoubleToString(r_multiple, 2) + "," +
         SessionOf(ot.hour) + "," +
         DayName(ot.day_of_week) + "," +
         IntegerToString(ot.hour) + "," +
         ",,,," +                              // RangeSize, SweepDepth, UsedFVG, VolRegime
         YesNo(breakeven) + "," +
         YesNo(entries > 1) + "," +
         IntegerToString(magic) + "," +
         CleanText(comment) + "," +
         ttmfe_text + "," +
         DoubleToString(sl_pips, 1) + "," +
         DoubleToString(slippage, 1) + "," +
         DoubleToString(post15, 1) + "," +
         DoubleToString(post30, 1) + "," +
         "," +                                 // BiasAtEntry
         IntegerToString(login) + "," +
         DoubleToString(commission, 2) + "," +
         DoubleToString(swap, 2) + "," +
         "UTC," +
         IntegerToString(offset);
   return(true);
  }

//+------------------------------------------------------------------+
//| Writes the lines to Common\Files through a temporary file.       |
//+------------------------------------------------------------------+
bool WriteLines(const string name, const string &lines[], const int count)
  {
   string temp = name + ".tmp";
   int handle = FileOpen(temp, FILE_WRITE | FILE_BIN | FILE_COMMON);
   if(handle == INVALID_HANDLE)
     {
      PrintFormat("DojixExport: can't write %s (error %d)", temp, GetLastError());
      return(false);
     }
   bool ok = true;
   for(int i = 0; i < count && ok; i++)
     {
      uchar bytes[];
      int length = StringToCharArray(lines[i] + "\r\n", bytes, 0, WHOLE_ARRAY, CP_UTF8);
      // The count includes the terminating zero, which is not written.
      if(length > 1)
         ok = (FileWriteArray(handle, bytes, 0, length - 1) == (uint)(length - 1));
     }
   FileClose(handle);
   if(!ok)
     {
      PrintFormat("DojixExport: writing %s failed (error %d)", temp, GetLastError());
      FileDelete(temp, FILE_COMMON);
      return(false);
     }
   if(!FileMove(temp, FILE_COMMON, name, FILE_COMMON | FILE_REWRITE))
     {
      PrintFormat("DojixExport: can't replace %s (error %d)", name, GetLastError());
      FileDelete(temp, FILE_COMMON);
      return(false);
     }
   return(true);
  }

//+------------------------------------------------------------------+
//| Exports every position closed in the window.                     |
//+------------------------------------------------------------------+
void Export()
  {
   g_dirty = false;
   g_last_export = TimeLocal();
   ComputeOffsets();

   datetime to = TimeCurrent() + 86400;
   datetime from = 0;
   if(InpDaysBack > 0)
      from = (datetime)((long)TimeCurrent() - (long)InpDaysBack * 86400);
   if(!HistorySelect(from, to))
     {
      Print("DojixExport: the account history isn't available yet; trying again in a minute");
      g_dirty = true;
      return;
     }

   // Every position with an exit deal in the window.
   long ids[];
   int  count = 0;
   int  total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0)
         continue;
      ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(deal, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT)
         continue;
      long type = HistoryDealGetInteger(deal, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL)
         continue;
      long position_id = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      if(position_id <= 0)
         continue;
      ArrayResize(ids, count + 1, 256);
      ids[count] = position_id;
      count++;
     }
   if(count > 1)
      ArraySort(ids);

   long   login = AccountInfoInteger(ACCOUNT_LOGIN);
   string lines[];
   ArrayResize(lines, 1, 256);
   lines[0] = DJX_HEADER;
   int  rows = 1;
   long previous = -1;
   for(int k = 0; k < count; k++)
     {
      if(ids[k] == previous)
         continue;
      previous = ids[k];
      string row = "";
      if(PositionRow(ids[k], login, row))
        {
         ArrayResize(lines, rows + 1, 256);
         lines[rows] = row;
         rows++;
        }
     }

   MqlDateTime today;
   TimeToStruct(TimeGMT(), today);
   string name = StringFormat("DojixExport_%I64d_%04d%02d%02d.csv", login, today.year, today.mon, today.day);
   if(WriteLines(name, lines, rows))
      PrintFormat("DojixExport: %d closed positions written to %s (Common\\Files)", rows - 1, name);
  }
//+------------------------------------------------------------------+
