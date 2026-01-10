//+------------------------------------------------------------------+
//| Kalman_STFT_DominantCycle_Forecast.mq5                           |
//| "Kalman de verdade" + STFT (atributos) + Forecast (causal)       |
//|                                                                  |
//| Arquitetura (causal, barra-a-barra):                             |
//|  1) Kalman (tendência local) em preço: nível + inclinação        |
//|  2) Resíduo = preço - nível (pós-update)                         |
//|  3) STFT (janela móvel trailing) no resíduo -> frequência dominante| 
//|     (bin/omega), amplitude, fase, SNR/qualidade                  |
//|  4) Kalman escalar em omega (frequência angular) -> "período true"|
//|  5) Kalman oscilador (estado 2D, rotação) no resíduo -> ciclo     |
//|  6) Linha-guia = nível + ciclo filtrado                           |
//|  7) Forecast h passos = (nível + slope*h) + ciclo previsto        |
//|                                                                  |
//| Observações importantes:                                         |
//|  - Nenhum lookahead: STFT usa apenas barras passadas (trailing). |
//|  - STFT só "volta" ao tempo se fizer iSTFT; aqui usamos STFT para |
//|    extrair atributos (freq/amp/fase/qualidade).                  |
//|  - Ruídos Q/R podem ser adaptativos via EWMA de volatilidade.    |
//|  - Indicador em subjanela: plota Price/Guide/Forecast + setas.   |
//+------------------------------------------------------------------+
#property strict
#property indicator_separate_window

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

//-------------------- Enumerations --------------------
enum ENUM_PEAK_REFINEMENT
{
   PEAK_REFINE_NONE         = 0, // sem refino sub-bin
   PEAK_REFINE_LOG_PARABOLA = 1, // refino por parábola em log(potência)
   PEAK_REFINE_JACOBSEN     = 2  // refino sub-bin (Jacobsen, complexo)
};

//-------------------- Inputs --------------------
input ENUM_APPLIED_PRICE InpAppliedPrice = PRICE_CLOSE;

// Cálculo
input int    InpComputeBars        = 20000;   // barras recentes a recalcular
input bool   InpRecalcOnEveryTick  = true;    // se false, só atualiza no novo bar
input int    InpRecalcOverlapBars  = 2;       // recálculo extra além das novas barras

// STFT
input int    InpSTFTWindow         = 256;     // janela STFT (potência de 2)
input int    InpSTFTMinPeriod      = 10;      // período mínimo (barras)
input int    InpSTFTMaxPeriod      = 120;     // período máximo (barras)
input bool   InpUseHannWindow      = true;    // janela Hann
input bool   InpSTFTRemoveMean     = true;    // remove DC (média ponderada) do frame
input ENUM_PEAK_REFINEMENT InpPeakRefinement = PEAK_REFINE_JACOBSEN;

// Rastreamento do pico (anti-jumps)
input bool   InpPeakContinuity     = true;
input int    InpPeakMaxBinJump     = 8;       // busca local +- bins em torno do bin anterior
input double InpPeakOverrideRatio  = 1.35;    // se pico global for > local*ratio, permite salto

// Volatilidade (EWMA) para adaptação de ruído
input bool   InpAdaptiveNoise      = true;
input double InpEWMALambda         = 0.94;    // 0.94 ~ RiskMetrics
input double InpVolFloorPoints     = 1.0;     // piso sigma (pontos)

// Kalman tendência (nível+inclinação): ruídos como múltiplos de sigma
input double InpTrendR_VolMult      = 1.0;    // R = (mult*sigma)^2
input double InpTrendQLevel_VolMult = 0.20;   // Q_level
input double InpTrendQSlope_VolMult = 0.02;   // Q_slope
input double InpTrendGate           = 25.0;   // gating (Mahalanobis^2) p/ outliers

// Kalman omega (frequência): random-walk
input double InpOmegaQ             = 1e-5;    // Q_omega (rad^2)
input double InpOmegaRBase         = 5e-4;    // R_omega base (rad^2) - ajustado por qualidade
input double InpOmegaGate          = 16.0;    // gating (Mahalanobis^2)
input double InpOmegaQualityGain   = 6.0;     // reduz R conforme qualidade (0..1)
input double InpMinSNR             = 1.15;    // se SNR < isso, considera medição fraca

// Kalman ciclo (oscilador 2D): ruídos como múltiplos de sigma
input double InpCycleR_VolMult     = 1.0;     // R_cycle = (mult*sigma)^2
input double InpCycleQ_VolMult     = 0.30;    // Q_cycle = (mult*sigma)^2
input double InpCycleDamping       = 0.0;     // amortecimento por barra: rho=exp(-damping)
input double InpCycleGate          = 25.0;    // gating (Mahalanobis^2)

// Forecast
input int    InpForecastHorizon     = 1;      // h barras à frente
input bool   InpForecastIncludeCycle= true;

// Sinais
input bool   InpEmitSignals         = true;
input bool   InpSignalUseVol        = true;   // threshold baseado em sigma
input double InpSignalThresholdMult = 0.25;   // thr = mult*sigma
input double InpSignalAbsThresholdPoints = 0.0; // se !UseVol, thr em pontos
input double InpSignalHysteresis    = 0.15;   // histerese relativa

// Diagnóstico
input bool   InpShowDiagnosticsInDataWindow = true; // expõe atributos via DataWindow
input bool   InpShowDashboard               = false; // painel via Comment()

//-------------------- Plot indices --------------------
// Principais (visíveis)
#define PLOT_PRICE        0
#define PLOT_GUIDE        1
#define PLOT_FORECAST     2
#define PLOT_BUY          3
#define PLOT_SELL         4

// Diagnósticos (por padrão DRAW_NONE)
#define PLOT_TREND        5
#define PLOT_SLOPE        6
#define PLOT_RESID        7
#define PLOT_CYCLE        8
#define PLOT_CYCLE_FC     9
#define PLOT_PERIOD_M    10
#define PLOT_PERIOD_F    11
#define PLOT_OMEGA_M     12
#define PLOT_OMEGA_F     13
#define PLOT_BIN_M       14
#define PLOT_BIN_F       15
#define PLOT_AMP_STFT    16
#define PLOT_AMP_CYCLE   17
#define PLOT_PHASE_STFT  18
#define PLOT_PHASE_CYCLE 19
#define PLOT_PHASE_STFT_U 20
#define PLOT_PHASE_CYCLE_U 21
#define PLOT_SNR         22
#define PLOT_QUALITY     23
#define PLOT_VOL         24
#define PLOT_SIGNAL      25

#property indicator_plots 26

// Buffers: 26 data (0..25) + 8 cálculo (26..33)
#property indicator_buffers 34

//-------------------- DATA buffers --------------------
double BufPrice[];
double BufGuide[];
double BufForecast[];
double BufBuy[];
double BufSell[];

double BufTrend[];
double BufSlope[];
double BufResid[];
double BufCycle[];
double BufCycleFc[];
double BufPeriodMeas[];
double BufPeriodFilt[];
double BufOmegaMeas[];
double BufOmegaFilt[];
double BufBinMeas[];
double BufBinFilt[];
double BufAmpSTFT[];
double BufAmpCycle[];
double BufPhaseSTFT[];
double BufPhaseCycle[];
double BufPhaseSTFTUnwrap[];
double BufPhaseCycleUnwrap[];
double BufSNR[];
double BufQuality[];
double BufVol2[];
double BufSignalState[];

//-------------------- CALC buffers --------------------
double CalcTrendP00[];
double CalcTrendP01[];
double CalcTrendP11[];

double CalcOmegaP[];

double CalcCycleP00[];
double CalcCycleP01[];
double CalcCycleP11[];

double CalcCycleQuad[]; // componente quadratura (seno)

//-------------------- STFT precomputed --------------------
int    gN=0;
int    gKLow=0, gKHigh=0;
double gOmegaMin=0.0, gOmegaMax=0.0;

double gWin[];
double gWinSum=0.0;

double gFFTRe[];
double gFFTIm[];

datetime gLastBarTime = 0;

//-------------------- Utility: series-safe index --------------------
bool g_inputs_series = true;
int SrcIndex(const int shift,const int rates_total)
{
   if(g_inputs_series) return shift;
   return (rates_total-1-shift);
}

double GetPrice(const int shift,
                const int rates_total,
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[])
{
   int i = SrcIndex(shift, rates_total);
   if(i < 0) i = 0;
   if(i >= rates_total) i = rates_total-1;

   double o  = open[i];
   double h  = high[i];
   double l  = low[i];
   double c  = close[i];

   switch(InpAppliedPrice)
   {
      case PRICE_OPEN:     return o;
      case PRICE_HIGH:     return h;
      case PRICE_LOW:      return l;
      case PRICE_MEDIAN:   return (h + l) * 0.5;
      case PRICE_TYPICAL:  return (h + l + c) / 3.0;
      case PRICE_WEIGHTED: return (h + l + c + c) / 4.0;
      case PRICE_CLOSE:
      default:             return c;
   }
}

bool IsPowerOfTwo(const int n)
{
   if(n <= 0) return false;
   return ((n & (n-1)) == 0);
}

double Clamp(const double x,const double lo,const double hi)
{
   if(x < lo) return lo;
   if(x > hi) return hi;
   return x;
}

double WrapPi(double x)
{
   double twopi = 2.0 * M_PI;
   x = MathMod(x + M_PI, twopi);
   if(x < 0.0) x += twopi;
   return x - M_PI;
}

//-------------------- FFT (radix-2, iterativo) --------------------
void FFT(double &re[], double &im[], const int n, const bool inverse=false)
{
   // bit-reversal
   int j = 0;
   for(int i=1; i<n; i++)
   {
      int bit = n >> 1;
      for(; (j & bit) != 0; bit >>= 1)
         j ^= bit;
      j ^= bit;

      if(i < j)
      {
         double tmp = re[i]; re[i] = re[j]; re[j] = tmp;
         tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
   }

   for(int len=2; len<=n; len <<= 1)
   {
      double ang = 2.0 * M_PI / (double)len;
      if(!inverse) ang = -ang;
      double wlen_re = MathCos(ang);
      double wlen_im = MathSin(ang);

      for(int i=0; i<n; i += len)
      {
         double w_re = 1.0;
         double w_im = 0.0;
         int half = len >> 1;
         for(int k=0; k<half; k++)
         {
            int u = i + k;
            int v = u + half;

            double t_re = re[v]*w_re - im[v]*w_im;
            double t_im = re[v]*w_im + im[v]*w_re;

            double u_re = re[u];
            double u_im = im[u];

            re[u] = u_re + t_re;
            im[u] = u_im + t_im;
            re[v] = u_re - t_re;
            im[v] = u_im - t_im;

            double next_w_re = w_re*wlen_re - w_im*wlen_im;
            double next_w_im = w_re*wlen_im + w_im*wlen_re;
            w_re = next_w_re;
            w_im = next_w_im;
         }
      }
   }

   if(inverse)
   {
      for(int i=0; i<n; i++)
      {
         re[i] /= (double)n;
         im[i] /= (double)n;
      }
   }
}

//-------------------- STFT dominante (atributos) --------------------
// Retorna true se conseguiu medir (janela disponível). Tudo é causal.
bool STFTDominant(const int shift,
                  const int maxShiftCompute,
                  const double &resid[],
                  double prev_bin,
                  double &omega_meas,
                  double &bin_meas,
                  double &amp_meas,
                  double &phase_last,
                  double &snr,
                  double &quality)
{
   omega_meas = EMPTY_VALUE;
   bin_meas   = EMPTY_VALUE;
   amp_meas   = EMPTY_VALUE;
   phase_last = EMPTY_VALUE;
   snr        = EMPTY_VALUE;
   quality    = EMPTY_VALUE;

   if(gN < 8) return false;
   if(shift + gN - 1 > maxShiftCompute) return false;

   // mean/DC removal (ponderado pela janela)
   double mu = 0.0;
   double wsum = 0.0;
   if(InpSTFTRemoveMean)
   {
      for(int n=0; n<gN; n++)
      {
         int idx = shift + (gN - 1 - n);
         double x = resid[idx];
         if(x == EMPTY_VALUE) x = 0.0;
         double w = (InpUseHannWindow ? gWin[n] : 1.0);
         mu += x * w;
         wsum += w;
      }
      if(wsum > 1e-12) mu /= wsum;
   }

   // monta frame (oldest->newest) e FFT
   for(int n=0; n<gN; n++)
   {
      int idx = shift + (gN - 1 - n);
      double x = resid[idx];
      if(x == EMPTY_VALUE) x = 0.0;
      if(InpSTFTRemoveMean) x -= mu;
      double w = (InpUseHannWindow ? gWin[n] : 1.0);
      gFFTRe[n] = x * w;
      gFFTIm[n] = 0.0;
   }

   FFT(gFFTRe, gFFTIm, gN, false);

   // varre banda
   int k_low  = gKLow;
   int k_high = gKHigh;
   if(k_low < 1) k_low = 1;
   if(k_high > (gN/2 - 1)) k_high = gN/2 - 1;

   // Para interpolação segura (k-1 e k+1)
   int k_low_safe  = MathMax(2, k_low);
   int k_high_safe = MathMin(gN/2 - 2, k_high);
   if(k_low_safe > k_high_safe) return false;

   double sumP = 0.0;
   int    cntP = 0;

   // pico global
   int    k_global = -1;
   double p_global = -1.0;

   for(int k=k_low_safe; k<=k_high_safe; k++)
   {
      double re = gFFTRe[k];
      double im = gFFTIm[k];
      double p  = re*re + im*im;
      sumP += p;
      cntP++;
      if(p > p_global)
      {
         p_global = p;
         k_global = k;
      }
   }
   if(k_global < 0 || cntP < 3) return false;

   // pico local (continuidade)
   int    k_pick = k_global;
   double p_pick = p_global;

   if(InpPeakContinuity && prev_bin > 0.0)
   {
      int k_center = (int)MathRound(prev_bin);
      int kl = MathMax(k_low_safe,  k_center - InpPeakMaxBinJump);
      int kh = MathMin(k_high_safe, k_center + InpPeakMaxBinJump);

      if(kl <= kh)
      {
         int    k_local = -1;
         double p_local = -1.0;
         for(int k=kl; k<=kh; k++)
         {
            double re = gFFTRe[k];
            double im = gFFTIm[k];
            double p  = re*re + im*im;
            if(p > p_local)
            {
               p_local = p;
               k_local = k;
            }
         }

         if(k_local > 0)
         {
            if(p_global > p_local * InpPeakOverrideRatio)
            {
               k_pick = k_global;
               p_pick = p_global;
            }
            else
            {
               k_pick = k_local;
               p_pick = p_local;
            }
         }
      }
   }

   // SNR e qualidade
   double meanP = (sumP - p_pick) / (double)MathMax(1, cntP - 1);
   if(meanP <= 1e-30) meanP = 1e-30;
   snr = p_pick / meanP;
   quality = p_pick / MathMax(1e-30, sumP);

   // Refino sub-bin
   double delta = 0.0;
   double p_ref = p_pick;

   if(InpPeakRefinement != PEAK_REFINE_NONE)
   {
      int k = k_pick;
      // vizinhos
      double re_m1 = gFFTRe[k-1], im_m1 = gFFTIm[k-1];
      double re_0  = gFFTRe[k],   im_0  = gFFTIm[k];
      double re_p1 = gFFTRe[k+1], im_p1 = gFFTIm[k+1];

      double p_m1 = re_m1*re_m1 + im_m1*im_m1;
      double p_0  = re_0*re_0   + im_0*im_0;
      double p_p1 = re_p1*re_p1 + im_p1*im_p1;

      p_m1 = MathMax(p_m1, 1e-30);
      p_0  = MathMax(p_0,  1e-30);
      p_p1 = MathMax(p_p1, 1e-30);

      // coeficientes da parábola em log(p)
      double la = MathLog(p_m1);
      double lb = MathLog(p_0);
      double lc = MathLog(p_p1);
      double denom = (la - 2.0*lb + lc);

      if(InpPeakRefinement == PEAK_REFINE_LOG_PARABOLA)
      {
         if(MathAbs(denom) > 1e-12)
         {
            delta = 0.5*(la - lc) / denom;
            delta = Clamp(delta, -0.5, 0.5);
         }
      }
      else if(InpPeakRefinement == PEAK_REFINE_JACOBSEN)
      {
         // delta = Re{ (X[k-1] - X[k+1]) / (2X[k] - X[k-1] - X[k+1]) }
         double num_re = (re_m1 - re_p1);
         double num_im = (im_m1 - im_p1);
         double den_re = (2.0*re_0 - re_m1 - re_p1);
         double den_im = (2.0*im_0 - im_m1 - im_p1);
         double den2   = den_re*den_re + den_im*den_im;
         if(den2 > 1e-24)
         {
            delta = (num_re*den_re + num_im*den_im) / den2;
            delta = Clamp(delta, -0.5, 0.5);
         }
      }

      // avalia log-parábola no delta (se possível)
      if(MathAbs(denom) > 1e-12)
      {
         // f(-1)=la, f(0)=lb, f(+1)=lc. A:0.5*denom, B:0.5*(lc-la)
         double a = 0.5*denom;
         double b = 0.5*(lc - la);
         double logp = a*delta*delta + b*delta + lb;
         p_ref = MathExp(logp);
      }
      else
      {
         p_ref = p_0;
      }
   }

   bin_meas = (double)k_pick + delta;
   omega_meas = 2.0 * M_PI * bin_meas / (double)gN;

   double win_sum = (InpUseHannWindow ? gWinSum : (double)gN);
   if(win_sum <= 1e-12) win_sum = (double)gN;

   amp_meas = 2.0 * MathSqrt(MathMax(p_ref, 0.0)) / win_sum;

   // fase no "final" do frame: fase0 + omega*(N-1)
   double phase0 = MathArctan2(gFFTIm[k_pick], gFFTRe[k_pick]);
   phase_last = WrapPi(phase0 + omega_meas * (double)(gN - 1));

   return true;
}

//-------------------- OnInit --------------------
int OnInit()
{
   // validações
   if(!IsPowerOfTwo(InpSTFTWindow) || InpSTFTWindow < 32)
   {
      Print("Erro: InpSTFTWindow deve ser potência de 2 e >= 32. Valor atual: ", InpSTFTWindow);
      return INIT_FAILED;
   }
   if(InpSTFTMinPeriod < 2 || InpSTFTMaxPeriod < 2 || InpSTFTMinPeriod >= InpSTFTMaxPeriod)
   {
      Print("Erro: períodos STFT inválidos. Min deve ser < Max e ambos >= 2.");
      return INIT_FAILED;
   }

   gN = InpSTFTWindow;

   // banda em bins
   double k_low_f  = (double)gN / (double)InpSTFTMaxPeriod;
   double k_high_f = (double)gN / (double)InpSTFTMinPeriod;

   gKLow  = (int)MathFloor(k_low_f);
   gKHigh = (int)MathCeil(k_high_f);

   // evita DC e garante vizinhos
   gKLow  = MathMax(2, gKLow);
   gKHigh = MathMin(gN/2 - 2, gKHigh);

   if(gKLow > gKHigh)
   {
      Print("Erro: banda STFT inválida após discretização. Ajuste Min/MaxPeriod ou STFTWindow.");
      return INIT_FAILED;
   }

   gOmegaMin = 2.0 * M_PI / (double)InpSTFTMaxPeriod;
   gOmegaMax = 2.0 * M_PI / (double)InpSTFTMinPeriod;

   // janela Hann
   ArrayResize(gWin, gN);
   gWinSum = 0.0;
   for(int n=0; n<gN; n++)
   {
      double w = 1.0;
      if(InpUseHannWindow)
         w = 0.5 * (1.0 - MathCos(2.0*M_PI*(double)n/(double)(gN-1)));
      gWin[n] = w;
      gWinSum += w;
   }

   // FFT buffers
   ArrayResize(gFFTRe, gN);
   ArrayResize(gFFTIm, gN);

   // --- buffers plot/data ---
   SetIndexBuffer(PLOT_PRICE,     BufPrice,      INDICATOR_DATA);
   SetIndexBuffer(PLOT_GUIDE,     BufGuide,      INDICATOR_DATA);
   SetIndexBuffer(PLOT_FORECAST,  BufForecast,   INDICATOR_DATA);
   SetIndexBuffer(PLOT_BUY,       BufBuy,        INDICATOR_DATA);
   SetIndexBuffer(PLOT_SELL,      BufSell,       INDICATOR_DATA);

   SetIndexBuffer(PLOT_TREND,      BufTrend,      INDICATOR_DATA);
   SetIndexBuffer(PLOT_SLOPE,      BufSlope,      INDICATOR_DATA);
   SetIndexBuffer(PLOT_RESID,      BufResid,      INDICATOR_DATA);
   SetIndexBuffer(PLOT_CYCLE,      BufCycle,      INDICATOR_DATA);
   SetIndexBuffer(PLOT_CYCLE_FC,   BufCycleFc,    INDICATOR_DATA);
   SetIndexBuffer(PLOT_PERIOD_M,   BufPeriodMeas, INDICATOR_DATA);
   SetIndexBuffer(PLOT_PERIOD_F,   BufPeriodFilt, INDICATOR_DATA);
   SetIndexBuffer(PLOT_OMEGA_M,    BufOmegaMeas,  INDICATOR_DATA);
   SetIndexBuffer(PLOT_OMEGA_F,    BufOmegaFilt,  INDICATOR_DATA);
   SetIndexBuffer(PLOT_BIN_M,      BufBinMeas,    INDICATOR_DATA);
   SetIndexBuffer(PLOT_BIN_F,      BufBinFilt,    INDICATOR_DATA);
   SetIndexBuffer(PLOT_AMP_STFT,   BufAmpSTFT,    INDICATOR_DATA);
   SetIndexBuffer(PLOT_AMP_CYCLE,  BufAmpCycle,   INDICATOR_DATA);
   SetIndexBuffer(PLOT_PHASE_STFT, BufPhaseSTFT,  INDICATOR_DATA);
   SetIndexBuffer(PLOT_PHASE_CYCLE,BufPhaseCycle, INDICATOR_DATA);
   SetIndexBuffer(PLOT_PHASE_STFT_U, BufPhaseSTFTUnwrap, INDICATOR_DATA);
   SetIndexBuffer(PLOT_PHASE_CYCLE_U,BufPhaseCycleUnwrap,INDICATOR_DATA);
   SetIndexBuffer(PLOT_SNR,        BufSNR,        INDICATOR_DATA);
   SetIndexBuffer(PLOT_QUALITY,    BufQuality,    INDICATOR_DATA);
   SetIndexBuffer(PLOT_VOL,        BufVol2,       INDICATOR_DATA);
   SetIndexBuffer(PLOT_SIGNAL,     BufSignalState,INDICATOR_DATA);

   // --- buffers de cálculo ---
   int c0 = 26;
   SetIndexBuffer(c0+0, CalcTrendP00, INDICATOR_CALCULATIONS);
   SetIndexBuffer(c0+1, CalcTrendP01, INDICATOR_CALCULATIONS);
   SetIndexBuffer(c0+2, CalcTrendP11, INDICATOR_CALCULATIONS);
   SetIndexBuffer(c0+3, CalcOmegaP,   INDICATOR_CALCULATIONS);
   SetIndexBuffer(c0+4, CalcCycleP00, INDICATOR_CALCULATIONS);
   SetIndexBuffer(c0+5, CalcCycleP01, INDICATOR_CALCULATIONS);
   SetIndexBuffer(c0+6, CalcCycleP11, INDICATOR_CALCULATIONS);
   SetIndexBuffer(c0+7, CalcCycleQuad,INDICATOR_CALCULATIONS);

   // séries
   double *all_series[] = {BufPrice,BufGuide,BufForecast,BufBuy,BufSell,BufTrend,BufSlope,BufResid,BufCycle,BufCycleFc,
                           BufPeriodMeas,BufPeriodFilt,BufOmegaMeas,BufOmegaFilt,BufBinMeas,BufBinFilt,BufAmpSTFT,BufAmpCycle,
                           BufPhaseSTFT,BufPhaseCycle,BufPhaseSTFTUnwrap,BufPhaseCycleUnwrap,BufSNR,BufQuality,BufVol2,BufSignalState,
                           CalcTrendP00,CalcTrendP01,CalcTrendP11,CalcOmegaP,CalcCycleP00,CalcCycleP01,CalcCycleP11,CalcCycleQuad};
   for(int i=0;i<ArraySize(all_series);i++)
      ArraySetAsSeries(all_series[i], true);

   // Configuração de plots
   IndicatorSetInteger(INDICATOR_DIGITS, _Digits);

   // Labels
   PlotIndexSetString(PLOT_PRICE,    PLOT_LABEL, "Price");
   PlotIndexSetString(PLOT_GUIDE,    PLOT_LABEL, "Guide");
   PlotIndexSetString(PLOT_FORECAST, PLOT_LABEL, "Forecast");
   PlotIndexSetString(PLOT_BUY,      PLOT_LABEL, "Buy");
   PlotIndexSetString(PLOT_SELL,     PLOT_LABEL, "Sell");

   PlotIndexSetString(PLOT_TREND,      PLOT_LABEL, "Trend(Level)");
   PlotIndexSetString(PLOT_SLOPE,      PLOT_LABEL, "Trend(Slope)");
   PlotIndexSetString(PLOT_RESID,      PLOT_LABEL, "Residual");
   PlotIndexSetString(PLOT_CYCLE,      PLOT_LABEL, "Cycle(KF)");
   PlotIndexSetString(PLOT_CYCLE_FC,   PLOT_LABEL, "CycleForecast");
   PlotIndexSetString(PLOT_PERIOD_M,   PLOT_LABEL, "Period_Meas");
   PlotIndexSetString(PLOT_PERIOD_F,   PLOT_LABEL, "Period_Filt");
   PlotIndexSetString(PLOT_OMEGA_M,    PLOT_LABEL, "Omega_Meas");
   PlotIndexSetString(PLOT_OMEGA_F,    PLOT_LABEL, "Omega_Filt");
   PlotIndexSetString(PLOT_BIN_M,      PLOT_LABEL, "DomBin_Meas");
   PlotIndexSetString(PLOT_BIN_F,      PLOT_LABEL, "DomBin_Filt");
   PlotIndexSetString(PLOT_AMP_STFT,   PLOT_LABEL, "Amp_STFT");
   PlotIndexSetString(PLOT_AMP_CYCLE,  PLOT_LABEL, "Amp_Cycle");
   PlotIndexSetString(PLOT_PHASE_STFT, PLOT_LABEL, "Phase_STFT_Last");
   PlotIndexSetString(PLOT_PHASE_CYCLE,PLOT_LABEL, "Phase_Cycle");
   PlotIndexSetString(PLOT_PHASE_STFT_U, PLOT_LABEL, "Phase_STFT_Unwrap");
   PlotIndexSetString(PLOT_PHASE_CYCLE_U,PLOT_LABEL, "Phase_Cycle_Unwrap");
   PlotIndexSetString(PLOT_SNR,        PLOT_LABEL, "SNR");
   PlotIndexSetString(PLOT_QUALITY,    PLOT_LABEL, "Quality");
   PlotIndexSetString(PLOT_VOL,        PLOT_LABEL, "Vol2(EWMA)");
   PlotIndexSetString(PLOT_SIGNAL,     PLOT_LABEL, "SignalState");

   // Tipos
   PlotIndexSetInteger(PLOT_PRICE,    PLOT_DRAW_TYPE, DRAW_LINE);
   PlotIndexSetInteger(PLOT_GUIDE,    PLOT_DRAW_TYPE, DRAW_LINE);
   PlotIndexSetInteger(PLOT_FORECAST, PLOT_DRAW_TYPE, DRAW_LINE);
   PlotIndexSetInteger(PLOT_BUY,      PLOT_DRAW_TYPE, DRAW_ARROW);
   PlotIndexSetInteger(PLOT_SELL,     PLOT_DRAW_TYPE, DRAW_ARROW);

   // setas (Wingdings)
   PlotIndexSetInteger(PLOT_BUY,  PLOT_ARROW, 233);
   PlotIndexSetInteger(PLOT_SELL, PLOT_ARROW, 234);

   // Cores
   PlotIndexSetInteger(PLOT_PRICE,    PLOT_LINE_COLOR, 0, clrSilver);
   PlotIndexSetInteger(PLOT_GUIDE,    PLOT_LINE_COLOR, 0, clrLime);
   PlotIndexSetInteger(PLOT_FORECAST, PLOT_LINE_COLOR, 0, clrOrange);
   PlotIndexSetInteger(PLOT_BUY,      PLOT_LINE_COLOR, 0, clrDeepSkyBlue);
   PlotIndexSetInteger(PLOT_SELL,     PLOT_LINE_COLOR, 0, clrTomato);

   // Larguras
   PlotIndexSetInteger(PLOT_PRICE,    PLOT_LINE_WIDTH, 1);
   PlotIndexSetInteger(PLOT_GUIDE,    PLOT_LINE_WIDTH, 2);
   PlotIndexSetInteger(PLOT_FORECAST, PLOT_LINE_WIDTH, 1);
   PlotIndexSetInteger(PLOT_BUY,      PLOT_LINE_WIDTH, 1);
   PlotIndexSetInteger(PLOT_SELL,     PLOT_LINE_WIDTH, 1);

   // Diagnósticos: por padrão DRAW_NONE (não distorce escala)
   int diag_plots[] = {PLOT_TREND,PLOT_SLOPE,PLOT_RESID,PLOT_CYCLE,PLOT_CYCLE_FC,PLOT_PERIOD_M,PLOT_PERIOD_F,
                       PLOT_OMEGA_M,PLOT_OMEGA_F,PLOT_BIN_M,PLOT_BIN_F,PLOT_AMP_STFT,PLOT_AMP_CYCLE,PLOT_PHASE_STFT,
                       PLOT_PHASE_CYCLE,PLOT_PHASE_STFT_U,PLOT_PHASE_CYCLE_U,PLOT_SNR,PLOT_QUALITY,PLOT_VOL,PLOT_SIGNAL};

   for(int i=0;i<ArraySize(diag_plots);i++)
   {
      int p = diag_plots[i];
      PlotIndexSetInteger(p, PLOT_DRAW_TYPE, DRAW_NONE);
      PlotIndexSetDouble(p,  PLOT_EMPTY_VALUE, EMPTY_VALUE);
      PlotIndexSetInteger(p, PLOT_SHOW_DATA, (InpShowDiagnosticsInDataWindow ? true : false));
   }

   // Empty values
   for(int p=0;p<26;p++)
      PlotIndexSetDouble(p, PLOT_EMPTY_VALUE, EMPTY_VALUE);

   // Draw begin
   PlotIndexSetInteger(PLOT_PRICE,    PLOT_DRAW_BEGIN, 0);
   PlotIndexSetInteger(PLOT_GUIDE,    PLOT_DRAW_BEGIN, 0);
   PlotIndexSetInteger(PLOT_FORECAST, PLOT_DRAW_BEGIN, 0);

   string sn = StringFormat("Kalman+STFT DC Forecast (N=%d, P=[%d..%d], h=%d)", gN, InpSTFTMinPeriod, InpSTFTMaxPeriod, MathMax(1,InpForecastHorizon));
   IndicatorSetString(INDICATOR_SHORTNAME, sn);

   return(INIT_SUCCEEDED);
}

//-------------------- OnCalculate --------------------
int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &real_volume[],
                const int &spread[])
{
   g_inputs_series = ArrayGetAsSeries(time);

   if(rates_total < 10)
      return prev_calculated;

   // Novo bar?
   bool new_bar = false;
   {
      int i0 = SrcIndex(0, rates_total);
      datetime t0 = time[i0];
      if(t0 != gLastBarTime)
      {
         new_bar = true;
         gLastBarTime = t0;
      }
   }

   if(!InpRecalcOnEveryTick && !new_bar && prev_calculated>0)
      return prev_calculated;

   int maxShiftCompute = rates_total - 1;
   if(InpComputeBars > 0)
      maxShiftCompute = MathMin(maxShiftCompute, InpComputeBars - 1);

   bool stft_possible_for_current = (maxShiftCompute >= (gN - 1));

   // define quantas barras recalcular
   int startShift;
   if(prev_calculated <= 0)
   {
      startShift = maxShiftCompute;

      // inicializa barras fora do range
      for(int s=rates_total-1; s>maxShiftCompute; s--)
      {
         BufPrice[s] = BufGuide[s] = BufForecast[s] = EMPTY_VALUE;
         BufBuy[s]   = BufSell[s]  = EMPTY_VALUE;

         BufTrend[s] = BufSlope[s] = BufResid[s] = EMPTY_VALUE;
         BufCycle[s] = BufCycleFc[s] = EMPTY_VALUE;

         BufPeriodMeas[s] = BufPeriodFilt[s] = EMPTY_VALUE;
         BufOmegaMeas[s]  = BufOmegaFilt[s]  = EMPTY_VALUE;
         BufBinMeas[s]    = BufBinFilt[s]    = EMPTY_VALUE;
         BufAmpSTFT[s]    = BufAmpCycle[s]   = EMPTY_VALUE;
         BufPhaseSTFT[s]  = BufPhaseCycle[s] = EMPTY_VALUE;
         BufPhaseSTFTUnwrap[s] = BufPhaseCycleUnwrap[s] = EMPTY_VALUE;
         BufSNR[s]        = BufQuality[s]    = EMPTY_VALUE;
         BufVol2[s]       = BufSignalState[s]= EMPTY_VALUE;

         CalcTrendP00[s] = CalcTrendP01[s] = CalcTrendP11[s] = EMPTY_VALUE;
         CalcOmegaP[s]   = EMPTY_VALUE;
         CalcCycleP00[s] = CalcCycleP01[s] = CalcCycleP11[s] = EMPTY_VALUE;
         CalcCycleQuad[s]= EMPTY_VALUE;
      }
   }
   else
   {
      int newBars = rates_total - prev_calculated;
      if(newBars < 0) newBars = rates_total; // histórico mudou
      startShift = MathMin(maxShiftCompute, newBars + MathMax(0, InpRecalcOverlapBars));
   }

   // pré-cálculos
   double sigma_floor = InpVolFloorPoints * _Point;
   if(sigma_floor <= 0.0) sigma_floor = _Point;

   double rho = MathExp(-MathMax(0.0, InpCycleDamping));
   int h = MathMax(1, InpForecastHorizon);

   // loop (oldest -> newest): shift decresce
   for(int s=startShift; s>=0; s--)
   {
      // 1) preço
      double y = GetPrice(s, rates_total, open,high,low,close);
      BufPrice[s] = y;

      // 2) volatilidade EWMA (diferenças de preço)
      double diff = 0.0;
      if(s + 1 < rates_total && BufPrice[s+1] != EMPTY_VALUE)
         diff = y - BufPrice[s+1];

      double v2_prev;
      if(s == maxShiftCompute || (s+1 >= rates_total) || BufVol2[s+1] == EMPTY_VALUE)
         v2_prev = diff*diff;
      else
         v2_prev = BufVol2[s+1];

      double v2 = InpEWMALambda * v2_prev + (1.0 - InpEWMALambda) * diff*diff;
      BufVol2[s] = v2;

      double sigma = MathSqrt(MathMax(v2, 0.0));
      if(sigma < sigma_floor) sigma = sigma_floor;

      // 3) parâmetros Q/R adaptativos
      double R_trend = InpAdaptiveNoise ? (InpTrendR_VolMult*sigma)*(InpTrendR_VolMult*sigma) : (InpTrendR_VolMult*_Point)*(InpTrendR_VolMult*_Point);
      double Q_level = InpAdaptiveNoise ? (InpTrendQLevel_VolMult*sigma)*(InpTrendQLevel_VolMult*sigma) : 0.0;
      double Q_slope = InpAdaptiveNoise ? (InpTrendQSlope_VolMult*sigma)*(InpTrendQSlope_VolMult*sigma) : 0.0;

      // 4) Kalman tendência (estado: level, slope)
      double level_prev, slope_prev;
      double P00_prev, P01_prev, P11_prev;

      bool have_prev = (s+1 < rates_total && s < maxShiftCompute && BufTrend[s+1] != EMPTY_VALUE && CalcTrendP00[s+1] != EMPTY_VALUE);

      if(!have_prev)
      {
         level_prev = y;
         slope_prev = 0.0;
         P00_prev = 1e6;
         P01_prev = 0.0;
         P11_prev = 1e6;
      }
      else
      {
         level_prev = BufTrend[s+1];
         slope_prev = BufSlope[s+1];
         P00_prev   = CalcTrendP00[s+1];
         P01_prev   = CalcTrendP01[s+1];
         P11_prev   = CalcTrendP11[s+1];
      }

      // Predict (F = [[1,1],[0,1]])
      double level_pred = level_prev + slope_prev;
      double slope_pred = slope_prev;

      double P00p = P00_prev + P11_prev + 2.0*P01_prev + Q_level;
      double P01p = P01_prev + P11_prev;
      double P11p = P11_prev + Q_slope;

      // Update
      double innov = y - level_pred;
      double S = P00p + R_trend;
      if(S < 1e-30) S = 1e-30;

      // Gating robusto
      double maha2 = innov*innov / S;
      double R_eff = R_trend;
      if(maha2 > InpTrendGate)
      {
         double scale = maha2 / MathMax(1e-12, InpTrendGate);
         R_eff = R_trend * scale;
         S = P00p + R_eff;
         if(S < 1e-30) S = 1e-30;
      }

      double K0 = P00p / S;
      double K1 = P01p / S;

      double level = level_pred + K0 * innov;
      double slope = slope_pred + K1 * innov;

      // Joseph covariance
      double a00 = 1.0 - K0;
      double a10 = -K1;

      double P00 = a00*a00*P00p + R_eff*K0*K0;
      double P01 = a00*a10*P00p + a00*P01p + R_eff*K0*K1;
      double P11 = a10*a10*P00p + 2.0*a10*P01p + P11p + R_eff*K1*K1;

      BufTrend[s] = level;
      BufSlope[s] = slope;
      CalcTrendP00[s] = P00;
      CalcTrendP01[s] = P01;
      CalcTrendP11[s] = P11;

      // 5) resíduo
      double resid = y - level;
      BufResid[s] = resid;

      // 6) STFT -> omega_meas, bin, amp, fase, snr, qualidade
      double omega_meas, bin_meas, amp_stft, phase_stft_last, snr, quality;

      double prev_bin = EMPTY_VALUE;
      if(s+1 < rates_total && BufBinFilt[s+1] != EMPTY_VALUE)
         prev_bin = BufBinFilt[s+1];
      else if(s+1 < rates_total && BufOmegaFilt[s+1] != EMPTY_VALUE)
         prev_bin = (BufOmegaFilt[s+1] * (double)gN) / (2.0*M_PI);

      bool stft_ok = false;
      if(stft_possible_for_current)
         stft_ok = STFTDominant(s, maxShiftCompute, BufResid, prev_bin, omega_meas, bin_meas, amp_stft, phase_stft_last, snr, quality);

      if(!stft_ok)
      {
         omega_meas = bin_meas = amp_stft = phase_stft_last = snr = quality = EMPTY_VALUE;
      }

      BufOmegaMeas[s] = omega_meas;
      BufBinMeas[s]   = bin_meas;
      BufAmpSTFT[s]   = amp_stft;
      BufPhaseSTFT[s] = phase_stft_last;
      BufSNR[s]       = snr;
      BufQuality[s]   = quality;

      if(omega_meas != EMPTY_VALUE && omega_meas > 1e-12)
         BufPeriodMeas[s] = 2.0*M_PI / omega_meas;
      else
         BufPeriodMeas[s] = EMPTY_VALUE;

      // unwrapping STFT phase
      if(phase_stft_last != EMPTY_VALUE)
      {
         if(s+1 < rates_total && BufPhaseSTFTUnwrap[s+1] != EMPTY_VALUE && BufPhaseSTFT[s+1] != EMPTY_VALUE)
         {
            double dphi = WrapPi(phase_stft_last - BufPhaseSTFT[s+1]);
            BufPhaseSTFTUnwrap[s] = BufPhaseSTFTUnwrap[s+1] + dphi;
         }
         else
         {
            BufPhaseSTFTUnwrap[s] = phase_stft_last;
         }
      }
      else
      {
         BufPhaseSTFTUnwrap[s] = EMPTY_VALUE;
      }

      // 7) Kalman em omega (período "true")
      double omega_prev, Pomega_prev;
      bool have_omega_prev = (s+1 < rates_total && s < maxShiftCompute && BufOmegaFilt[s+1] != EMPTY_VALUE && CalcOmegaP[s+1] != EMPTY_VALUE);

      if(!have_omega_prev)
      {
         omega_prev = 2.0*M_PI / (0.5*(InpSTFTMinPeriod + InpSTFTMaxPeriod));
         omega_prev = Clamp(omega_prev, gOmegaMin, gOmegaMax);
         Pomega_prev = 1.0;
      }
      else
      {
         omega_prev = BufOmegaFilt[s+1];
         Pomega_prev = CalcOmegaP[s+1];
      }

      // predict
      double omega_pred = omega_prev;
      double Pomega_p   = Pomega_prev + MathMax(0.0, InpOmegaQ);

      // measurement noise adaptado por qualidade
      double Romega = InpOmegaRBase;
      if(quality != EMPTY_VALUE)
      {
         double q = Clamp(quality, 0.0, 1.0);
         Romega = InpOmegaRBase / (1.0 + InpOmegaQualityGain * q);
      }
      if(snr != EMPTY_VALUE && snr < InpMinSNR)
      {
         double factor = (InpMinSNR / MathMax(1e-6, snr));
         Romega *= (1.0 + factor*factor);
      }

      double omega_filt = omega_pred;
      double Pomega     = Pomega_p;

      if(omega_meas != EMPTY_VALUE)
      {
         double z = Clamp(omega_meas, gOmegaMin, gOmegaMax);

         double S_om = Pomega_p + Romega;
         if(S_om < 1e-30) S_om = 1e-30;

         double innov_om = z - omega_pred;
         double maha2_om = innov_om*innov_om / S_om;

         if(maha2_om <= InpOmegaGate)
         {
            double K = Pomega_p / S_om;
            omega_filt = omega_pred + K * innov_om;
            Pomega = (1.0 - K) * Pomega_p;
         }
         else
         {
            omega_filt = omega_pred;
            Pomega = Pomega_p + Romega;
         }
      }

      omega_filt = Clamp(omega_filt, gOmegaMin, gOmegaMax);

      BufOmegaFilt[s] = omega_filt;
      CalcOmegaP[s]   = Pomega;

      BufPeriodFilt[s] = 2.0*M_PI / omega_filt;
      BufBinFilt[s]    = (omega_filt * (double)gN) / (2.0*M_PI);

      // 8) Kalman oscilador no resíduo (estado [c,s])
      double c_prev, s_prev;
      double Pc00_prev, Pc01_prev, Pc11_prev;

      bool have_cycle_prev = (s+1 < rates_total && s < maxShiftCompute && BufCycle[s+1] != EMPTY_VALUE && CalcCycleP00[s+1] != EMPTY_VALUE && CalcCycleQuad[s+1] != EMPTY_VALUE);

      if(!have_cycle_prev)
      {
         c_prev = 0.0;
         s_prev = 0.0;
         Pc00_prev = 1e6;
         Pc01_prev = 0.0;
         Pc11_prev = 1e6;
      }
      else
      {
         c_prev = BufCycle[s+1];
         s_prev = CalcCycleQuad[s+1];
         Pc00_prev = CalcCycleP00[s+1];
         Pc01_prev = CalcCycleP01[s+1];
         Pc11_prev = CalcCycleP11[s+1];
      }

      double R_cycle = InpAdaptiveNoise ? (InpCycleR_VolMult*sigma)*(InpCycleR_VolMult*sigma) : (InpCycleR_VolMult*_Point)*(InpCycleR_VolMult*_Point);
      double Q_cycle = InpAdaptiveNoise ? (InpCycleQ_VolMult*sigma)*(InpCycleQ_VolMult*sigma) : 0.0;

      // matriz de transição (rotação)
      double cosw = MathCos(omega_filt);
      double sinw = MathSin(omega_filt);

      double a = rho*cosw;
      double b = -rho*sinw;
      double c = rho*sinw;
      double d = rho*cosw;

      // predict state
      double c_pred = a*c_prev + b*s_prev;
      double s_pred = c*c_prev + d*s_prev;

      // predict covariance: Pp = A P A' + QI
      double AP00 = a*Pc00_prev + b*Pc01_prev;
      double AP01 = a*Pc01_prev + b*Pc11_prev;
      double AP10 = c*Pc00_prev + d*Pc01_prev;
      double AP11 = c*Pc01_prev + d*Pc11_prev;

      double Pc00p = AP00*a + AP01*b + Q_cycle;
      double Pc01p = AP00*c + AP01*d;
      double Pc11p = AP10*c + AP11*d + Q_cycle;

      // update with z=resid, H=[1,0]
      double innov_c = resid - c_pred;
      double S_c = Pc00p + R_cycle;
      if(S_c < 1e-30) S_c = 1e-30;

      double maha2_c = innov_c*innov_c / S_c;
      double Rcy_eff = R_cycle;
      if(maha2_c > InpCycleGate)
      {
         double scale = maha2_c / MathMax(1e-12, InpCycleGate);
         Rcy_eff = R_cycle * scale;
         S_c = Pc00p + Rcy_eff;
         if(S_c < 1e-30) S_c = 1e-30;
      }

      double Kc0 = Pc00p / S_c;
      double Kc1 = Pc01p / S_c;

      double c_f = c_pred + Kc0 * innov_c;
      double s_f = s_pred + Kc1 * innov_c;

      // Joseph covariance
      double ac00 = 1.0 - Kc0;
      double ac10 = -Kc1;

      double Pc00 = ac00*ac00*Pc00p + Rcy_eff*Kc0*Kc0;
      double Pc01 = ac00*ac10*Pc00p + ac00*Pc01p + Rcy_eff*Kc0*Kc1;
      double Pc11 = ac10*ac10*Pc00p + 2.0*ac10*Pc01p + Pc11p + Rcy_eff*Kc1*Kc1;

      BufCycle[s] = c_f;
      CalcCycleQuad[s] = s_f;
      CalcCycleP00[s] = Pc00;
      CalcCycleP01[s] = Pc01;
      CalcCycleP11[s] = Pc11;

      // atributos do ciclo
      double amp_cycle = MathSqrt(c_f*c_f + s_f*s_f);
      double phase_cycle = MathArctan2(s_f, c_f);
      BufAmpCycle[s] = amp_cycle;
      BufPhaseCycle[s] = phase_cycle;

      // unwrapping ciclo
      if(s+1 < rates_total && BufPhaseCycleUnwrap[s+1] != EMPTY_VALUE && BufPhaseCycle[s+1] != EMPTY_VALUE)
      {
         double dphi = WrapPi(phase_cycle - BufPhaseCycle[s+1]);
         BufPhaseCycleUnwrap[s] = BufPhaseCycleUnwrap[s+1] + dphi;
      }
      else
      {
         BufPhaseCycleUnwrap[s] = phase_cycle;
      }

      // ciclo forecast h passos (omega constante no horizonte)
      double coshw = MathCos((double)h * omega_filt);
      double sinhw = MathSin((double)h * omega_filt);
      double rhoh = MathPow(rho, (double)h);
      double cycle_fc = rhoh * (c_f * coshw - s_f * sinhw);
      BufCycleFc[s] = cycle_fc;

      // 9) linha-guia e forecast
      double guide = level + c_f;
      BufGuide[s] = guide;

      double level_fc = level + slope * (double)h;
      double forecast = level_fc + (InpForecastIncludeCycle ? cycle_fc : 0.0);
      BufForecast[s] = forecast;

      // 10) sinal e setas
      double prev_state = 0.0;
      if(s+1 < rates_total && BufSignalState[s+1] != EMPTY_VALUE)
         prev_state = BufSignalState[s+1];

      double slopeGuide = 0.0;
      if(s+1 < rates_total && BufGuide[s+1] != EMPTY_VALUE)
         slopeGuide = guide - BufGuide[s+1];

      double thr = 0.0;
      if(InpSignalUseVol)
         thr = InpSignalThresholdMult * sigma;
      else
         thr = InpSignalAbsThresholdPoints * _Point;

      double thr_up = thr * (1.0 + MathMax(0.0, InpSignalHysteresis));
      double thr_dn = thr * (1.0 + MathMax(0.0, InpSignalHysteresis));

      double state = prev_state;
      if(prev_state >= 0.0)
      {
         if(slopeGuide < -thr_dn) state = -1.0;
         else if(slopeGuide > thr_up) state = +1.0;
      }
      else
      {
         if(slopeGuide > thr_up) state = +1.0;
         else if(slopeGuide < -thr_dn) state = -1.0;
      }

      BufSignalState[s] = state;

      BufBuy[s]  = EMPTY_VALUE;
      BufSell[s] = EMPTY_VALUE;

      if(InpEmitSignals)
      {
         if(prev_state <= 0.0 && state > 0.0)
            BufBuy[s] = guide;
         if(prev_state >= 0.0 && state < 0.0)
            BufSell[s] = guide;
      }

      // 11) dashboard (somente no shift 0)
      if(InpShowDashboard && s==0)
      {
         string msg;
         msg = StringFormat(
               "Kalman+STFT Dominant Cycle\n"+
               "Price: %.5f | Guide: %.5f | Forecast(%d): %.5f\n"+
               "Trend: level=%.5f slope=%.5f\n"+
               "Residual: %.5f | Cycle(KF): %.5f | AmpCycle: %.5f\n"+
               "STFT: bin=%.3f omega=%.5f period=%.2f | AmpSTFT=%.5f\n"+
               "OmegaFilt: %.5f periodTrue=%.2f | SNR=%.2f Q=%.3f\n"+
               "SignalState: %.0f",
               y, guide, h, forecast,
               level, slope,
               resid, c_f, amp_cycle,
               bin_meas, omega_meas, (omega_meas!=EMPTY_VALUE && omega_meas>1e-12 ? 2.0*M_PI/omega_meas : 0.0), amp_stft,
               omega_filt, 2.0*M_PI/omega_filt,
               (snr==EMPTY_VALUE?0.0:snr), (quality==EMPTY_VALUE?0.0:quality),
               state);
         Comment(msg);
      }
   }

   return rates_total;
}
