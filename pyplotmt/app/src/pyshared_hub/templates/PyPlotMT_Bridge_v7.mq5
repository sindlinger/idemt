// PySharedBridgePlot_v6.mq5
//
// Purpose:
//   - Input always in InputTF (recommended: M1) and sent to Python.
//   - Python returns a wave in InputTF resolution.
//   - Indicator plots that wave on:
//       * chart timeframe (default), OR
//       * a TRUE custom plot timeframe in minutes (InpPlotCustomMinutes > 0)
//     by time-mapping (never by index).
//
// v6 fixes two transport issues observed in logs:
//   1) PB_Write META failed (w=0) means stream0 queue full (v2 DLL FIFO). We now:
//        - stop spamming META while waiting
//        - only send META when a FULL is successfully sent or on a new bar (throttled)
//        - never block FULL by META
//   2) v4/v5 incorrectly set g_full_sent=true even when PB_Write FULL failed.
//      That caused: "waiting FULL output" forever. Fixed.
//
// Requires v2 DLL exporting:
//   PB_ReadNextDoubles, PB_Available, PB_MaxSlots, PB_Dropped

#property strict
#property indicator_separate_window
#property indicator_buffers 1
#property indicator_plots   1
#property indicator_type1   DRAW_LINE
#property indicator_color1  clrLime
#property indicator_label1  "PY_OUT"

#import "PyShared_v2.dll"
int  PB_Init(string channel, int capacity_bytes);
void PB_Close();
int  PB_MaxDoubles();
int  PB_MaxSlots();
int  PB_Available(int stream);
int  PB_Dropped(int stream);
int  PB_WriteDoubles(int stream, int series_id, double &data[], int count, long ts);
int  PB_ReadNextDoubles(int stream, int &series_id, double &out[], int max_count, int &out_count, long &ts);
#import

// ------------------------------
// Transport
// ------------------------------
input string Channel  = "MAIN";
input ENUM_TIMEFRAMES InputTF = PERIOD_M1;
input int    SendBars = 65536;
input int    TimerMs  = 50;
input bool   InpUseTimer = true;
input bool   SendOnlyOnNewBar = true;
input int    CapacityMB = 0;
input int    SeriesIdFull = 100;
input int    SeriesIdUpdate = 101;
input int    SeriesIdMeta = 900;
input int    SeriesIdAck = 990;
input bool   SendMeta = true;
input int    ForceFullEveryBars = 0;

enum ENUM_PY_SEND_SOURCE
{
   PY_SEND_CLOSE = 0,      // Close price
   PY_SEND_TICKVOL = 1,    // Tick volume
   PY_SEND_REALVOL = 2     // Real volume (if available)
};
input ENUM_PY_SEND_SOURCE InpSendSource = PY_SEND_CLOSE;

// Retry/Throttle
input int    InpFullRetryMs = 500;     // when FULL wasn't successfully sent yet
input int    InpMetaCooldownMs = 1000; // minimum time between META sends

// Update behavior
input bool   InpUpdateOnTick = true;   // true = send UPDATE on each tick (or every N ticks)
input int    InpUpdateEveryTicks = 1;  // N ticks between UPDATE sends (>=1)

// ------------------------------
// Dominant-wave configuration (META)
// ------------------------------
// Period units:
//  0 => min/max periods are expressed in InputTF bars (e.g., M1 bars)
//  1 => min/max periods are expressed in PlotTF bars (chart TF or custom) and converted to InputTF bars
input int    InpPeriodUnits = 0;

input double InpMinPeriodBars = 20.0;
input double InpMaxPeriodBars = 240.0;
input int    InpNperseg       = 16384;
input int    InpNoverlap      = 16128;
input int    InpNfft          = 65536;
input double InpRidgePenalty  = 0.15;
input int    InpScoreHarmonics = 3;
input int    InpMaskMaxHarmonic = 3;
input double InpSigmaFund     = 3.0;
input double InpSigmaHarm     = 3.0;
input bool   InpBaselineEnable = true;
input double InpBaselineCutoffPeriodBars = 1200.0;
input double InpMinConfidence = 0.12;
// 0=phase, 1=AR, 2=hybrid, 3=GBM Monte Carlo
input int    InpPredictionMethod = 0;
input int    InpAROrder       = 64;
input int    InpARFitLen      = 8192;
input double InpARReg         = 0.000001;
input int    InpPredictWaveHorizon = 0;
// 0=cycle (oscillator), 1=price_wave
input int    InpOutputMode = 1;
input bool   InpUseLogPrice = true;
input bool   InpDetrendLinear = true;
input bool   InpUpdateReturnsFull = false;

// ------------------------------
// Plot timeframe selection
// ------------------------------
// 0 => plot in chart timeframe (standard)
// >0 => plot in a TRUE custom timeframe (minutes) built from InputTF (typically M1)
input int    InpPlotCustomMinutes = 0;
// If true, custom bars are anchored at server-day midnight (00:00) + offset.
// If false, anchored at Unix epoch (1970-01-01) + offset.
input bool   InpCustomAnchorMidnight = true;
// Optional alignment (minutes). Example: set 1 to align bars at 00:01, 00:08, 00:15 for 7-minute TF.
input int    InpCustomOffsetMinutes = 0;

// Plot mapping
input bool   InpPlotAtBarClose = true;  // true = sample at chart bar CLOSE; false = at chart bar OPEN

// Logging
input bool   InpVerbose = true;
input int    InpLogEveryMs = 1000;

double Out[];        // plotted buffer (chart TF indexing)
double WaveInTF[];   // stored wave in InputTF resolution (series indexing)
double gSend[];
double gRecv[];
double gMeta[];

ulong    g_last_log_ms = 0;
long     g_last_ts_log = 0;
ulong    g_last_recv_ms = 0;

datetime g_last_in_bar_time = 0;     // InputTF bar 0 time
datetime g_last_chart_bar_time = 0;  // chart bar 0 time

bool     g_full_sent = false;        // FULL input successfully written to stream0
bool     g_full_received = false;    // FULL output received from Python
bool     g_meta_sent_once = false;
bool     g_py_connected = false;
int      g_tick_count = 0;

int      g_bar_count = 0;
long     g_last_wave_ts = 0;
long     g_last_tx_full_ts = 0;
long     g_last_tx_upd_ts = 0;

ulong    g_last_full_tx_ms = 0;
ulong    g_last_meta_tx_ms = 0;

int      g_slots = 0;

bool     g_need_redraw = false; // request chart redraw after buffer updates

void LogMsg(const string msg)
{
   if(!InpVerbose) return;
   static string last_msg = "";
   if(msg == last_msg) return;
   last_msg = msg;

   ulong now_ms = (ulong)(GetMicrosecondCount() / 1000);
   if(now_ms - g_last_log_ms < (ulong)InpLogEveryMs) return;
   g_last_log_ms = now_ms;

   Print("PySharedBridgePlot_v6: ", msg);
}

void LogMsgForce(const string msg)
{
   if(!InpVerbose) return;
   Print("PySharedBridgePlot_v6: ", msg);
}

void LogStartupChecks()
{
   LogMsgForce("dll_import=PyShared_v2.dll");
   LogMsgForce("channel=" + Channel + " mapping=Local\\PyBridge_" + Channel);
}

int PlotSeconds()
{
   if(InpPlotCustomMinutes > 0)
      return InpPlotCustomMinutes * 60;
   return PeriodSeconds(_Period);
}

datetime CustomBase(datetime t)
{
   int offset_sec = InpCustomOffsetMinutes * 60;
   if(InpPlotCustomMinutes <= 0)
      return (datetime)offset_sec; // unused in non-custom

   if(InpCustomAnchorMidnight)
   {
      datetime mid = (datetime)StringToTime(TimeToString(t, TIME_DATE));
      return mid + offset_sec;
   }
   return (datetime)offset_sec; // epoch + offset
}

bool Stream0HasSpace(const int need_free)
{
   if(g_slots <= 0) return true;
   // ring uses one empty slot; max fill = slots-1
   int avail = PB_Available(0);
   int max_fill = g_slots - 1;
   int free = max_fill - avail;
   return (free >= need_free);
}

int OnInit()
{
   SetIndexBuffer(0, Out, INDICATOR_DATA);
   ArraySetAsSeries(Out, true);

   ArraySetAsSeries(WaveInTF, true);

   int bars = MathMin(SendBars, Bars(_Symbol, InputTF));
   int need = (int)(bars * 8 * 4 + 1024 * 1024);
   int cap = (CapacityMB > 0) ? CapacityMB * 1024 * 1024 : MathMax(8 * 1024 * 1024, need);

   if(PB_Init(Channel, cap) != 1)
   {
      Print("PB_Init failed. Check: Allow DLL imports, and PyShared_v2.dll in MQL5\\Libraries.");
      LogMsgForce("PB_Init failed (channel=" + Channel + ")");
      return INIT_FAILED;
   }

   g_slots = PB_MaxSlots();
   int maxd = PB_MaxDoubles();

   LogMsg("PB_Init ok (channel=" + Channel + ", capMB=" + IntegerToString(cap / (1024 * 1024)) +
          ") maxD=" + IntegerToString(maxd) + " slots=" + IntegerToString(g_slots));
   LogMsgForce("[Connected] indicator connected to DLL (PB_Init ok)");
   LogStartupChecks();
   if(maxd > 0 && SendBars > maxd) LogMsgForce("WARN send_bars(" + IntegerToString(SendBars) + ") > max_doubles(" + IntegerToString(maxd) + ")");

   if(InputTF != PERIOD_M1)
      Print("NOTICE: InputTF != M1. v6 maps output by time; it still works, but Python engine is tuned for M1.");

   if(InpPlotCustomMinutes > 0)
      Print("NOTICE: Custom Plot TF enabled: ", InpPlotCustomMinutes, " minutes (anchor_midnight=", InpCustomAnchorMidnight, ", offset_min=", InpCustomOffsetMinutes, ")");

   if(InpUseTimer)
      EventSetMillisecondTimer(MathMax(10, TimerMs));
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(InpUseTimer)
      EventKillTimer();
   PB_Close();
   LogMsgForce("[Disconnected] indicator disconnected (PB_Close)");
}

void SendMetaPacket(int bars)
{
   if(!SendMeta) return;

   ulong now_ms = (ulong)(GetMicrosecondCount() / 1000);
   if(g_meta_sent_once && (now_ms - g_last_meta_tx_ms) < (ulong)InpMetaCooldownMs)
      return;

   // If stream0 is almost full, skip META (do not block FULL).
   if(!Stream0HasSpace(1))
   {
      LogMsg("skip META: stream0 queue full (avail=" + IntegerToString(PB_Available(0)) + ")");
      return;
   }

   int in_sec  = PeriodSeconds(InputTF);
   int plot_sec = PlotSeconds();
   int out_bars = Bars(_Symbol, _Period);

   // Optionally convert user period inputs (expressed in plot bars) -> InputTF bars.
   double scale = 1.0;
   if(InpPeriodUnits != 0 && in_sec > 0)
      scale = (double)plot_sec / (double)in_sec;

   double minP = InpMinPeriodBars * scale;
   double maxP = InpMaxPeriodBars * scale;
   double baseCut = InpBaselineCutoffPeriodBars * scale;

   ArrayResize(gMeta, 29);
   gMeta[0]  = 2; // proto
   gMeta[1]  = (double)in_sec;
   gMeta[2]  = (double)plot_sec;   // chart TF or custom TF in seconds
   gMeta[3]  = (double)out_bars;
   gMeta[4]  = (double)bars;

   gMeta[5]  = minP;
   gMeta[6]  = maxP;
   gMeta[7]  = (double)InpNperseg;
   gMeta[8]  = (double)InpNoverlap;
   gMeta[9]  = (double)InpNfft;
   gMeta[10] = InpRidgePenalty;
   gMeta[11] = (double)InpScoreHarmonics;
   gMeta[12] = (double)InpMaskMaxHarmonic;
   gMeta[13] = InpSigmaFund;
   gMeta[14] = InpSigmaHarm;
   gMeta[15] = InpBaselineEnable ? 1.0 : 0.0;
   gMeta[16] = baseCut;
   gMeta[17] = InpMinConfidence;
   gMeta[18] = (double)InpPredictionMethod;
   gMeta[19] = (double)InpAROrder;
   gMeta[20] = (double)InpARFitLen;
   gMeta[21] = InpARReg;
   gMeta[22] = (double)InpPredictWaveHorizon;
   gMeta[23] = (double)InpOutputMode;
   gMeta[24] = InpUseLogPrice ? 1.0 : 0.0;
   gMeta[25] = InpDetrendLinear ? 1.0 : 0.0;
   gMeta[26] = InpUpdateReturnsFull ? 1.0 : 0.0;
   gMeta[27] = (double)InpPlotCustomMinutes; // for logging/debug on Python side
   gMeta[28] = (double)InpPeriodUnits;

   // Use current InputTF bar time as ts (stable).
   long ts = (long)iTime(_Symbol, InputTF, 0);
   if(ts == 0) ts = (long)TimeCurrent();

   int wmeta = PB_WriteDoubles(0, SeriesIdMeta, gMeta, ArraySize(gMeta), ts);
   if(wmeta <= 0)
      LogMsg("PB_Write META failed (w=" + IntegerToString(wmeta) + ") avail=" + IntegerToString(PB_Available(0)) + " dropped=" + IntegerToString(PB_Dropped(0)));
   else
   {
      g_meta_sent_once = true;
      g_last_meta_tx_ms = now_ms;
      LogMsgForce("TX META sid=" + IntegerToString(SeriesIdMeta) +
                  " count=" + IntegerToString(ArraySize(gMeta)));
   }
}

// Custom plot bar open time for a given reference time t.
datetime CustomOpen(datetime t)
{
   int sec = PlotSeconds();
   if(InpPlotCustomMinutes <= 0)
      return t;

   datetime base = CustomBase(t);
   long dt = (long)t - (long)base;
   if(dt < 0) dt = 0;
   long k = dt / sec;
   return (datetime)((long)base + k * sec);
}

// Map a chart bar shift -> InputTF bar shift by sampling time (open or close).
int MapChartBarToInputTF(const int chart_shift)
{
   datetime t_sample = 0;

   if(InpPlotCustomMinutes > 0)
   {
      // Plot TF is custom. We define the custom bar boundaries and sample at custom bar close/open.
      if(chart_shift == 0)
      {
         // keep current bar responsive: always map to current InputTF bar
         return 0;
      }

      // Reference time on chart
      datetime t_ref = (InpPlotAtBarClose ? iTime(_Symbol, _Period, chart_shift - 1) : iTime(_Symbol, _Period, chart_shift));
      if(t_ref == 0) return -1;

      datetime cust_open = CustomOpen(t_ref);
      datetime cust_close = cust_open + PlotSeconds();

      if(InpPlotAtBarClose)
         t_sample = cust_close - 1; // last InputTF bar before close
      else
         t_sample = cust_open;

      int sh = iBarShift(_Symbol, InputTF, t_sample, false);
      return sh;
   }

   // Standard: plot in chart TF, sample at chart open/close
   if(InpPlotAtBarClose)
   {
      if(chart_shift == 0)
         return 0;
      datetime close_time = iTime(_Symbol, _Period, chart_shift - 1);
      if(close_time == 0) return -1;
      t_sample = close_time - 1;
   }
   else
   {
      datetime open_time = iTime(_Symbol, _Period, chart_shift);
      if(open_time == 0) return -1;
      t_sample = open_time;
   }
   return iBarShift(_Symbol, InputTF, t_sample, false);
}

void ApplyFullMappingToChart()
{
   int chart_bars = Bars(_Symbol, _Period);
   int wave_n = ArraySize(WaveInTF);
   int out_n  = ArraySize(Out);

   if(chart_bars <= 0 || wave_n <= 0 || out_n <= 0)
      return;

   int limit = MathMin(chart_bars, out_n);

   for(int i=0; i<limit; ++i)
   {
      int sh = MapChartBarToInputTF(i);
      if(sh >= 0 && sh < wave_n)
         Out[i] = WaveInTF[sh];
      else
         Out[i] = EMPTY_VALUE;
   }

   g_need_redraw = true;
}

void ApplyUpdateToChart()
{
   int wave_n = ArraySize(WaveInTF);
   int out_n  = ArraySize(Out);

   if(wave_n <= 0 || out_n <= 0)
      return;

   Out[0] = WaveInTF[0];

   datetime chart_bt = iTime(_Symbol, _Period, 0);
   if(chart_bt != 0 && chart_bt != g_last_chart_bar_time)
   {
      g_last_chart_bar_time = chart_bt;
      if(out_n > 1 && Bars(_Symbol, _Period) > 1)
      {
         int sh = MapChartBarToInputTF(1);
         if(sh >= 0 && sh < wave_n)
            Out[1] = WaveInTF[sh];
      }
   }

   g_need_redraw = true;
}

void StoreWaveFull(double &arr[], int n, long ts)
{
   ArrayResize(WaveInTF, n);
   ArraySetAsSeries(WaveInTF, true);
   for(int i=0; i<n; ++i)
      WaveInTF[i] = arr[i];

   g_last_wave_ts = ts;
}

void StoreWaveUpdate(double v, long ts)
{
   int n = ArraySize(WaveInTF);
   if(n <= 0)
      return;

   if(g_last_wave_ts == 0)
      g_last_wave_ts = ts;

   if(ts != 0 && ts != g_last_wave_ts)
   {
      // New InputTF bar -> shift wave buffer by 1
      for(int i=n-1; i>=1; --i)
         WaveInTF[i] = WaveInTF[i-1];
      WaveInTF[0] = v;
      g_last_wave_ts = ts;
   }
   else
   {
      // Same bar update
      WaveInTF[0] = v;
   }
}

void ReceiveOutput(int bars)
{
   int out_max = bars;
   ArrayResize(gRecv, out_max);
   ArraySetAsSeries(gRecv, true);

   int drained = 0;

   for(int it=0; it<64; ++it)
   {
      int sid=0, got=0;
      long ts=0;

      int r = PB_ReadNextDoubles(1, sid, gRecv, out_max, got, ts);
      if(r <= 0 || got <= 0)
         break;
      drained++;

      if(!g_py_connected)
      {
         g_py_connected = true;
         LogMsgForce("[Connected] python client detected (sid=" + IntegerToString(sid) +
                     " got=" + IntegerToString(got) + " ts=" + IntegerToString((int)ts) + ")");
      }

      if(sid == 201 && got > 1)
      {
         StoreWaveFull(gRecv, got, ts);
         g_full_received = true;
         ApplyFullMappingToChart();
      }
      else if(sid == 202 && got >= 1)
      {
         StoreWaveUpdate(gRecv[0], ts);
         ApplyUpdateToChart();
      }
      else if(sid == SeriesIdAck)
      {
         LogMsgForce("RX ACK sid=" + IntegerToString(sid) +
                     " got=" + IntegerToString(got) + " ts=" + IntegerToString((int)ts));
      }

      if(ts != g_last_ts_log)
      {
         g_last_ts_log = ts;
         double first = gRecv[0];
         double last = gRecv[got-1];
         LogMsgForce("RX sid=" + IntegerToString(sid) + " got=" + IntegerToString(got) +
                " v0=" + DoubleToString(first, 6) + " vN=" + DoubleToString(last, 6) +
                " avail1=" + IntegerToString(PB_Available(1)) +
                " dropped1=" + IntegerToString(PB_Dropped(1)));
      }
   }

   if(drained == 0)
   {
      ulong now_ms = (ulong)(GetMicrosecondCount() / 1000);
      ulong idle_ms = (ulong)PeriodSeconds(InputTF) * 1000;
      if(idle_ms < 2000) idle_ms = 2000;
      if(g_py_connected && g_last_recv_ms > 0 && (now_ms - g_last_recv_ms) > idle_ms)
      {
         LogMsgForce("[Disconnected] python client idle (no output for " +
                     IntegerToString((int)(now_ms - g_last_recv_ms)) + " ms)");
         g_py_connected = false;
      }
      if((g_last_recv_ms == 0 || (now_ms - g_last_recv_ms) > 2000))
         LogMsg("no Python output (avail1=" + IntegerToString(PB_Available(1)) + ")");
   }
   else
      g_last_recv_ms = (ulong)(GetMicrosecondCount() / 1000);
}

bool FillSendBuffer(const int bars)
{
   if(bars <= 0) return false;
   ArrayResize(gSend, bars);
   ArraySetAsSeries(gSend, true);

   if(InpSendSource == PY_SEND_CLOSE)
      return (CopyClose(_Symbol, InputTF, 0, bars, gSend) > 0);

   long vbuf[];
   ArrayResize(vbuf, bars);
   ArraySetAsSeries(vbuf, true);
   int copied = 0;
   if(InpSendSource == PY_SEND_TICKVOL)
      copied = CopyTickVolume(_Symbol, InputTF, 0, bars, vbuf);
   else
      copied = CopyRealVolume(_Symbol, InputTF, 0, bars, vbuf);

   if(copied <= 0)
      return false;

   int limit = MathMin(bars, copied);
   for(int i=0; i<limit; ++i)
      gSend[i] = (double)vbuf[i];
   return true;
}

void TrySendFull(int bars, datetime in_bar_time)
{
   ulong now_ms = (ulong)(GetMicrosecondCount() / 1000);
   if((now_ms - g_last_full_tx_ms) < (ulong)InpFullRetryMs)
      return;
   g_last_full_tx_ms = now_ms;

   // If stream0 queue is full, do not attempt (will fail with w=0).
   if(!Stream0HasSpace(1))
   {
      LogMsg("skip FULL: stream0 queue full (avail0=" + IntegerToString(PB_Available(0)) + ")");
      return;
   }

   if(!FillSendBuffer(bars))
   {
      LogMsg("FillSendBuffer failed (FULL)");
      return;
   }

   int wfull = PB_WriteDoubles(0, SeriesIdFull, gSend, bars, (long)in_bar_time);
   if(wfull > 0)
   {
      if((long)in_bar_time != g_last_tx_full_ts)
      {
         g_last_tx_full_ts = (long)in_bar_time;
         LogMsgForce("TX FULL sid=" + IntegerToString(SeriesIdFull) +
                     " bars=" + IntegerToString(bars) +
                     " v0=" + DoubleToString(gSend[0], _Digits) +
                     " vN=" + DoubleToString(gSend[bars-1], _Digits));
      }
      g_full_sent = true;
      g_full_received = false;
      // Send META once after a successful FULL (throttled)
      SendMetaPacket(bars);
   }
   else
   {
      // IMPORTANT FIX: do NOT mark FULL as sent if write failed
      g_full_sent = false;
      LogMsg("PB_Write FULL failed (w=" + IntegerToString(wfull) + ") avail0=" + IntegerToString(PB_Available(0)) +
             " dropped0=" + IntegerToString(PB_Dropped(0)));
   }
}

void TrySendUpdate(datetime in_bar_time)
{
   if(!Stream0HasSpace(1))
   {
      LogMsg("skip UPDATE: stream0 queue full (avail0=" + IntegerToString(PB_Available(0)) + ")");
      return;
   }

   if(!FillSendBuffer(1))
   {
      LogMsg("FillSendBuffer failed (UPDATE)");
      return;
   }

   int wupd = PB_WriteDoubles(0, SeriesIdUpdate, gSend, 1, (long)in_bar_time);
   if(wupd > 0)
   {
      if((long)in_bar_time != g_last_tx_upd_ts)
      {
         g_last_tx_upd_ts = (long)in_bar_time;
         LogMsgForce("TX UPDATE sid=" + IntegerToString(SeriesIdUpdate) +
                     " v0=" + DoubleToString(gSend[0], _Digits));
      }
   }
   else
      LogMsg("PB_Write UPDATE failed (w=" + IntegerToString(wupd) + ") avail0=" + IntegerToString(PB_Available(0)) +
             " dropped0=" + IntegerToString(PB_Dropped(0)));
}

void PumpTransport()
{

   datetime in_bar_time = iTime(_Symbol, InputTF, 0);
   bool new_in_bar = (in_bar_time != 0 && in_bar_time != g_last_in_bar_time);
   if(new_in_bar)
      g_last_in_bar_time = in_bar_time;

   int bars = MathMin(SendBars, Bars(_Symbol, InputTF));

   // Single-exit block so we can keep final redraw logic sem usar desvio por label
   do
   {
      if(bars < 32)
      {
         ReceiveOutput(bars);
         break;
      }

      // Always drain output first (so we can flip g_full_received ASAP)
      ReceiveOutput(bars);

      bool allow_send = (!SendOnlyOnNewBar) ? true : new_in_bar;
      bool force_full = (ForceFullEveryBars > 0 && g_bar_count > 0 && (g_bar_count % ForceFullEveryBars) == 0);

      // 1) Ensure a FULL input is successfully sent at least once.
      //    Retry even inside the same bar until it succeeds.
      if(!g_full_sent)
      {
         // if we don't even have an InputTF bar time yet, use TimeCurrent
         if(in_bar_time == 0) in_bar_time = (datetime)TimeCurrent();
         TrySendFull(bars, in_bar_time);
         break; // wait for Python output after first successful FULL
      }

      // 2) If forced, send FULL again on new bar
      if(force_full && allow_send)
      {
         TrySendFull(bars, in_bar_time);
         if(new_in_bar) g_bar_count++;
         break;
      }

      // 3) Handshake: don't send UPDATE until we received at least one FULL output.
      if(allow_send)
      {
         if(g_full_received)
         {
            if(!InpUpdateOnTick)
               TrySendUpdate(in_bar_time);
            // META on new bar (throttled) so Python can react to timeframe changes/inputs
            if(SendMeta) SendMetaPacket(bars);
         }
         else
            LogMsg("waiting FULL output (skip UPDATE)");

         if(new_in_bar) g_bar_count++;
      }

   } while(false);

   if(g_need_redraw)
   {
      ChartRedraw();
      g_need_redraw = false;
   }
}

void OnTimer()
{
   if(!InpUseTimer) return;
   PumpTransport();
   if(SendMeta)
      SendMetaPacket(MathMin(SendBars, Bars(_Symbol, InputTF)));
   OnTimerExtras();
}

void OnTimerExtras()
{
   // custom timer tasks (non-tick)
}
int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
{
   if(prev_calculated == 0)
   {
      ArrayInitialize(Out, EMPTY_VALUE);
      g_last_chart_bar_time = iTime(_Symbol, _Period, 0);
   }
   if(InpUpdateOnTick)
   {
      int bars = MathMin(SendBars, Bars(_Symbol, InputTF));
      if(bars >= 32)
      {
         g_tick_count++;
         int every = (InpUpdateEveryTicks <= 0 ? 1 : InpUpdateEveryTicks);
         if((g_tick_count % every) == 0)
         {
            datetime in_bar_time = iTime(_Symbol, InputTF, 0);
            if(in_bar_time == 0) in_bar_time = (datetime)TimeCurrent();
            TrySendUpdate(in_bar_time);
         }
         ReceiveOutput(bars);
      }
   }
   // OnCalculate already triggers a redraw by the terminal
   g_need_redraw = false;
   PumpTransport();
   return rates_total;
}
