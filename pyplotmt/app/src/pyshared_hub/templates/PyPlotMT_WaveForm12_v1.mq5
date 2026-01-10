// PyPlotMT WaveForm 12-buffer bridge (v1)
// - Receives 12 cycles from Python plugin (concatenated buffers).
// - Optional sum-cycles mode: plugin can send single buffer.
// - Uses same transport logic as PyPlotMT_Bridge_v7.

#property strict
#property indicator_separate_window
#property indicator_buffers 12
#property indicator_plots   12

#property indicator_type1   DRAW_LINE
#property indicator_color1  clrLime
#property indicator_label1  "C1"
#property indicator_type2   DRAW_LINE
#property indicator_color2  clrLime
#property indicator_label2  "C2"
#property indicator_type3   DRAW_LINE
#property indicator_color3  clrLime
#property indicator_label3  "C3"
#property indicator_type4   DRAW_LINE
#property indicator_color4  clrLime
#property indicator_label4  "C4"
#property indicator_type5   DRAW_LINE
#property indicator_color5  clrLime
#property indicator_label5  "C5"
#property indicator_type6   DRAW_LINE
#property indicator_color6  clrLime
#property indicator_label6  "C6"
#property indicator_type7   DRAW_LINE
#property indicator_color7  clrLime
#property indicator_label7  "C7"
#property indicator_type8   DRAW_LINE
#property indicator_color8  clrLime
#property indicator_label8  "C8"
#property indicator_type9   DRAW_LINE
#property indicator_color9  clrLime
#property indicator_label9  "C9"
#property indicator_type10  DRAW_LINE
#property indicator_color10 clrLime
#property indicator_label10 "C10"
#property indicator_type11  DRAW_LINE
#property indicator_color11 clrLime
#property indicator_label11 "C11"
#property indicator_type12  DRAW_LINE
#property indicator_color12 clrLime
#property indicator_label12 "C12"

#define BUF_COUNT 12

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

// WaveForm params -> META (proto=101)
input int    InpFFTWindow    = 4096;
input int    InpMinPeriod    = 18;
input int    InpMaxPeriod    = 52;
input int    InpTrendPeriod  = 1024;
input double InpBandwidth    = 0.5;
// 0=none,1=hann,2=hamming,3=blackman,4=bartlett
input int    InpWindowType   = 3;
input bool   InpSumCycles    = false;
input bool   InpSortByPower  = true;
input int    InpMaxBars      = 0;
input int    InpHop          = 0;
input double InpTrackerTolerance = 5.0;
input int    InpMaxCycles    = BUF_COUNT;

// Plot timeframe selection (same as v7)
input int    InpPlotCustomMinutes = 0;
input bool   InpCustomAnchorMidnight = true;
input int    InpCustomOffsetMinutes = 0;
input bool   InpPlotAtBarClose = true;

// Logging
input bool   InpVerbose = true;
input int    InpLogEveryMs = 1000;

// Buffers
double OutBuffers[BUF_COUNT][];
double WaveInTF[BUF_COUNT][];
double gSend[];
double gRecv[];
double gMeta[];

ulong    g_last_log_ms = 0;
long     g_last_ts_log = 0;
ulong    g_last_recv_ms = 0;

datetime g_last_in_bar_time = 0;
datetime g_last_chart_bar_time = 0;

bool     g_full_sent = false;
bool     g_full_received = false;
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
bool     g_need_redraw = false;
bool     g_single_mode = false; // plugin sent single buffer

void LogMsg(const string msg)
{
   if(!InpVerbose) return;
   static string last_msg = "";
   if(msg == last_msg) return;
   last_msg = msg;

   ulong now_ms = (ulong)(GetMicrosecondCount() / 1000);
   if(now_ms - g_last_log_ms < (ulong)InpLogEveryMs) return;
   g_last_log_ms = now_ms;

   Print("PyPlotMT-WaveForm12: ", msg);
}

void LogMsgForce(const string msg)
{
   if(!InpVerbose) return;
   Print("PyPlotMT-WaveForm12: ", msg);
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
      return (datetime)offset_sec;

   if(InpCustomAnchorMidnight)
   {
      datetime mid = (datetime)StringToTime(TimeToString(t, TIME_DATE));
      return mid + offset_sec;
   }
   return (datetime)offset_sec;
}

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

bool Stream0HasSpace(const int need_free)
{
   if(g_slots <= 0) return true;
   int avail = PB_Available(0);
   int max_fill = g_slots - 1;
   int free = max_fill - avail;
   return (free >= need_free);
}

int MapChartBarToInputTF(const int chart_shift)
{
   datetime t_sample = 0;

   if(InpPlotCustomMinutes > 0)
   {
      if(chart_shift == 0)
         return 0;

      datetime t_ref = (InpPlotAtBarClose ? iTime(_Symbol, _Period, chart_shift - 1) : iTime(_Symbol, _Period, chart_shift));
      if(t_ref == 0) return -1;

      datetime cust_open = CustomOpen(t_ref);
      datetime cust_close = cust_open + PlotSeconds();

      if(InpPlotAtBarClose)
         t_sample = cust_close - 1;
      else
         t_sample = cust_open;

      int sh = iBarShift(_Symbol, InputTF, t_sample, false);
      return sh;
   }

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
   if(chart_bars <= 0) return;

   for(int b=0; b<BUF_COUNT; ++b)
   {
      int wave_n = ArraySize(WaveInTF[b]);
      int out_n  = ArraySize(OutBuffers[b]);
      int limit = MathMin(chart_bars, out_n);

      if(g_single_mode && b > 0)
      {
         for(int i=0; i<limit; ++i)
            OutBuffers[b][i] = EMPTY_VALUE;
         continue;
      }

      for(int i=0; i<limit; ++i)
      {
         int sh = MapChartBarToInputTF(i);
         if(sh >= 0 && sh < wave_n)
            OutBuffers[b][i] = WaveInTF[b][sh];
         else
            OutBuffers[b][i] = EMPTY_VALUE;
      }
   }

   g_need_redraw = true;
}

void ApplyUpdateToChart()
{
   for(int b=0; b<BUF_COUNT; ++b)
   {
      int wave_n = ArraySize(WaveInTF[b]);
      int out_n  = ArraySize(OutBuffers[b]);

      if(wave_n <= 0 || out_n <= 0)
         continue;

      if(g_single_mode && b > 0)
      {
         OutBuffers[b][0] = EMPTY_VALUE;
         continue;
      }

      OutBuffers[b][0] = WaveInTF[b][0];

      datetime chart_bt = iTime(_Symbol, _Period, 0);
      if(chart_bt != 0 && chart_bt != g_last_chart_bar_time)
      {
         g_last_chart_bar_time = chart_bt;
         if(out_n > 1 && Bars(_Symbol, _Period) > 1)
         {
            int sh = MapChartBarToInputTF(1);
            if(sh >= 0 && sh < wave_n)
               OutBuffers[b][1] = WaveInTF[b][sh];
         }
      }
   }

   g_need_redraw = true;
}

void StoreWaveFullMulti(double &arr[], int n, long ts)
{
   for(int b=0; b<BUF_COUNT; ++b)
   {
      ArrayResize(WaveInTF[b], n);
      ArraySetAsSeries(WaveInTF[b], true);
      int off = b * n;
      for(int i=0; i<n; ++i)
         WaveInTF[b][i] = arr[off + i];
   }
   g_last_wave_ts = ts;
}

void StoreWaveFullSingle(double &arr[], int n, long ts)
{
   ArrayResize(WaveInTF[0], n);
   ArraySetAsSeries(WaveInTF[0], true);
   for(int i=0; i<n; ++i)
      WaveInTF[0][i] = arr[i];
   for(int b=1; b<BUF_COUNT; ++b)
   {
      ArrayResize(WaveInTF[b], n);
      ArraySetAsSeries(WaveInTF[b], true);
      for(int i=0; i<n; ++i)
         WaveInTF[b][i] = EMPTY_VALUE;
   }
   g_last_wave_ts = ts;
}

void StoreWaveUpdateValue(int b, double v, long ts)
{
   int n = ArraySize(WaveInTF[b]);
   if(n <= 0) return;

   if(g_last_wave_ts == 0)
      g_last_wave_ts = ts;

   if(ts != 0 && ts != g_last_wave_ts)
   {
      for(int i=n-1; i>=1; --i)
         WaveInTF[b][i] = WaveInTF[b][i-1];
      WaveInTF[b][0] = v;
      g_last_wave_ts = ts;
   }
   else
      WaveInTF[b][0] = v;
}

void SendMetaPacket(int bars)
{
   if(!SendMeta) return;

   ulong now_ms = (ulong)(GetMicrosecondCount() / 1000);
   if(g_meta_sent_once && (now_ms - g_last_meta_tx_ms) < 1000)
      return;

   if(!Stream0HasSpace(1))
      return;

   ArrayResize(gMeta, 13);
   gMeta[0]  = 101; // proto
   gMeta[1]  = (double)InpFFTWindow;
   gMeta[2]  = (double)InpMinPeriod;
   gMeta[3]  = (double)InpMaxPeriod;
   gMeta[4]  = (double)InpTrendPeriod;
   gMeta[5]  = InpBandwidth;
   gMeta[6]  = (double)InpWindowType;
   gMeta[7]  = InpSumCycles ? 1.0 : 0.0;
   gMeta[8]  = InpSortByPower ? 1.0 : 0.0;
   gMeta[9]  = (double)InpMaxBars;
   gMeta[10] = (double)InpHop;
   gMeta[11] = InpTrackerTolerance;
   gMeta[12] = (double)InpMaxCycles;

   long ts = (long)iTime(_Symbol, InputTF, 0);
   if(ts == 0) ts = (long)TimeCurrent();

   int wmeta = PB_WriteDoubles(0, SeriesIdMeta, gMeta, ArraySize(gMeta), ts);
   if(wmeta > 0)
   {
      g_meta_sent_once = true;
      g_last_meta_tx_ms = now_ms;
      LogMsgForce("TX META sid=" + IntegerToString(SeriesIdMeta) +
                  " count=" + IntegerToString(ArraySize(gMeta)));
   }
}

int OnInit()
{
   for(int i=0; i<BUF_COUNT; ++i)
      SetIndexBuffer(i, OutBuffers[i], INDICATOR_DATA);

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

bool FillSendBuffer(const int bars)
{
   if(bars <= 0) return false;
   ArrayResize(gSend, bars);
   ArraySetAsSeries(gSend, true);
   return (CopyClose(_Symbol, InputTF, 0, bars, gSend) > 0);
}

void TrySendFull(int bars, datetime in_bar_time)
{
   ulong now_ms = (ulong)(GetMicrosecondCount() / 1000);
   if((now_ms - g_last_full_tx_ms) < 500) return;
   g_last_full_tx_ms = now_ms;

   if(!Stream0HasSpace(1)) return;
   if(!FillSendBuffer(bars)) return;

   int wfull = PB_WriteDoubles(0, SeriesIdFull, gSend, bars, (long)in_bar_time);
   if(wfull > 0)
   {
      g_full_sent = true;
      g_full_received = false;
      SendMetaPacket(bars);
      double v0 = gSend[0];
      double vN = gSend[bars-1];
      LogMsgForce("TX FULL sid=" + IntegerToString(SeriesIdFull) +
                  " count=" + IntegerToString(bars) +
                  " v0=" + DoubleToString(v0, 6) +
                  " vN=" + DoubleToString(vN, 6));
   }
   else
      g_full_sent = false;
}

void TrySendUpdate(datetime in_bar_time)
{
   if(!Stream0HasSpace(1)) return;
   if(!FillSendBuffer(1)) return;

   int wupd = PB_WriteDoubles(0, SeriesIdUpdate, gSend, 1, (long)in_bar_time);
   if(wupd > 0)
   {
      if((long)in_bar_time != g_last_tx_upd_ts)
         g_last_tx_upd_ts = (long)in_bar_time;
      LogMsgForce("TX UPDATE sid=" + IntegerToString(SeriesIdUpdate) +
                  " v0=" + DoubleToString(gSend[0], 6));
   }
}

void ReceiveOutput(int bars)
{
   int out_max = bars * BUF_COUNT;
   if(out_max < BUF_COUNT) out_max = BUF_COUNT;
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

      if(sid == 201 && got >= 1)
      {
         if(got % BUF_COUNT == 0)
         {
            int n = got / BUF_COUNT;
            g_single_mode = false;
            StoreWaveFullMulti(gRecv, n, ts);
         }
         else
         {
            g_single_mode = true;
            StoreWaveFullSingle(gRecv, got, ts);
         }
         g_full_received = true;
         ApplyFullMappingToChart();
      }
      else if(sid == 202 && got >= 1)
      {
         if(got == BUF_COUNT)
         {
            g_single_mode = false;
            for(int b=0; b<BUF_COUNT; ++b)
               StoreWaveUpdateValue(b, gRecv[b], ts);
         }
         else
         {
            g_single_mode = true;
            StoreWaveUpdateValue(0, gRecv[0], ts);
         }
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
         LogMsgForce("RX sid=" + IntegerToString(sid) + " got=" + IntegerToString(got));
      }
   }

   if(drained == 0)
   {
      ulong now_ms = (ulong)(GetMicrosecondCount() / 1000);
      ulong idle_ms = (ulong)PeriodSeconds(InputTF) * 1000;
      if(idle_ms < 2000) idle_ms = 2000;
      if(g_py_connected && g_last_recv_ms > 0 && (now_ms - g_last_recv_ms) > idle_ms)
      {
         LogMsgForce("[Disconnected] python client idle");
         g_py_connected = false;
      }
   }
   else
      g_last_recv_ms = (ulong)(GetMicrosecondCount() / 1000);
}

void PumpTransport()
{

   datetime in_bar_time = iTime(_Symbol, InputTF, 0);
   bool new_in_bar = (in_bar_time != 0 && in_bar_time != g_last_in_bar_time);
   if(new_in_bar)
      g_last_in_bar_time = in_bar_time;

   int bars = MathMin(SendBars, Bars(_Symbol, InputTF));

   do
   {
      if(bars < 32)
      {
         ReceiveOutput(bars);
         break;
      }

      ReceiveOutput(bars);

      bool allow_send = (!SendOnlyOnNewBar) ? true : new_in_bar;
      bool force_full = (ForceFullEveryBars > 0 && g_bar_count > 0 && (g_bar_count % ForceFullEveryBars) == 0);

      if(!g_full_sent)
      {
         if(in_bar_time == 0) in_bar_time = (datetime)TimeCurrent();
         TrySendFull(bars, in_bar_time);
         break;
      }

      if(force_full && allow_send)
      {
         TrySendFull(bars, in_bar_time);
         if(new_in_bar) g_bar_count++;
         break;
      }

      if(allow_send)
      {
         if(g_full_received)
         {
            TrySendUpdate(in_bar_time);
            if(SendMeta) SendMetaPacket(bars);
         }
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
      for(int b=0; b<BUF_COUNT; ++b)
         ArrayInitialize(OutBuffers[b], EMPTY_VALUE);
      g_last_chart_bar_time = iTime(_Symbol, _Period, 0);
   }
   PumpTransport();
   return rates_total;
}
