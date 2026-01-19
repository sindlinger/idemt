#include "SpectralCLBridge.h"

#include <vector>
#include <deque>
#include <unordered_map>
#include <complex>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <cmath>
#include <cstring>

namespace {

static const int kOutFields = 12;
static const int kQueueMax = 4;
static const int kRingMax = 256;

struct Job {
  int64_t key = 0;
  int64_t bar_time = 0;
  std::vector<double> price;
  std::vector<double> wave;
  int window_min = 0;
  int window_max = 0;
  int nfft = 0;
  int detrend = 0;
  double min_period = 0.0;
  double max_period = 0.0;
  int flags = 0;
};

struct Result {
  int64_t time = 0;
  int64_t seq = 0;
  double out[kOutFields];
};

struct Context {
  std::deque<Result> ring;
  int64_t seq = 0;
  uint64_t jobs_ok = 0;
  uint64_t jobs_drop = 0;
  double last_ms = 0.0;
};

std::mutex g_mu;
std::condition_variable g_cv;
std::deque<Job> g_jobs;
std::unordered_map<int64_t, Context> g_ctx;
std::thread g_worker;
bool g_worker_started = false;
bool g_stop = false;

static void start_worker();

static int next_pow2(int n) {
  int p = 1;
  while (p < n && p < (1<<30)) p <<= 1;
  return p;
}

static void detrend_series(std::vector<double>& x, int detrend_type) {
  int n = (int)x.size();
  if (n <= 1) return;
  if (detrend_type == 1) {
    double mean = 0.0;
    for (double v : x) mean += v;
    mean /= n;
    for (double &v : x) v -= mean;
  } else if (detrend_type == 2) {
    // linear detrend
    double sx = 0.0, sxx = 0.0, sy = 0.0, sxy = 0.0;
    for (int i=0;i<n;i++) {
      double t = (double)i;
      sx += t;
      sxx += t*t;
      sy += x[i];
      sxy += t*x[i];
    }
    double denom = (n*sxx - sx*sx);
    if (denom == 0.0) return;
    double a = (n*sxy - sx*sy) / denom;
    double b = (sy - a*sx) / n;
    for (int i=0;i<n;i++) {
      double t = (double)i;
      x[i] -= (a*t + b);
    }
  }
}

static void apply_window(std::vector<double>& x, const char* window) {
  int n = (int)x.size();
  if (n <= 1) return;
  std::string w = window ? window : "";
  for (auto &c : w) c = (char)tolower(c);
  if (w.empty() || w == "rect" || w == "boxcar") return;
  for (int i=0;i<n;i++) {
    double a = 1.0;
    double t = (double)i / (double)(n-1);
    if (w == "hann" || w == "hanning") {
      a = 0.5 - 0.5 * cos(2.0 * M_PI * t);
    } else if (w == "hamming") {
      a = 0.54 - 0.46 * cos(2.0 * M_PI * t);
    } else if (w == "blackman") {
      a = 0.42 - 0.5 * cos(2.0 * M_PI * t) + 0.08 * cos(4.0 * M_PI * t);
    }
    x[i] *= a;
  }
}

static void fft_radix2(std::vector<std::complex<double>>& a) {
  int n = (int)a.size();
  int j = 0;
  for (int i=1;i<n;i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(a[i], a[j]);
  }
  for (int len=2; len<=n; len<<=1) {
    double ang = -2.0 * M_PI / len;
    std::complex<double> wlen(cos(ang), sin(ang));
    for (int i=0;i<n;i+=len) {
      std::complex<double> w(1.0, 0.0);
      for (int j=0;j<len/2;j++) {
        std::complex<double> u = a[i+j];
        std::complex<double> v = a[i+j+len/2] * w;
        a[i+j] = u + v;
        a[i+j+len/2] = u - v;
        w *= wlen;
      }
    }
  }
}

static void compute_periodogram(const std::vector<double>& x_in, double fs, const char* window,
                                int nfft, int detrend_type, int return_onesided,
                                std::vector<double>& freqs, std::vector<double>& pxx,
                                double& dom_period, double& dom_phase, double min_period, double max_period,
                                double& dom_global)
{
  std::vector<double> x = x_in;
  detrend_series(x, detrend_type);
  apply_window(x, window);

  int n = (int)x.size();
  int nfft_eff = (nfft > 0 ? nfft : n);
  if (nfft_eff < n) nfft_eff = n;
  nfft_eff = next_pow2(nfft_eff);

  std::vector<std::complex<double>> a(nfft_eff);
  for (int i=0;i<n;i++) a[i] = std::complex<double>(x[i], 0.0);
  for (int i=n;i<nfft_eff;i++) a[i] = std::complex<double>(0.0, 0.0);

  fft_radix2(a);

  int nfreq = return_onesided ? (nfft_eff/2 + 1) : nfft_eff;
  freqs.assign(nfreq, 0.0);
  pxx.assign(nfreq, 0.0);

  for (int k=0;k<nfreq;k++) {
    double re = a[k].real();
    double im = a[k].imag();
    double mag2 = re*re + im*im;
    pxx[k] = mag2;
    freqs[k] = fs * (double)k / (double)nfft_eff;
  }

  dom_period = 0.0;
  dom_phase = 0.0;
  dom_global = 0.0;
  double best_pow_local = -1.0;
  double best_pow_global = -1.0;
  int best_k_local = -1;
  int best_k_global = -1;

  for (int k=1;k<nfreq;k++) {
    double f = freqs[k];
    if (f <= 0.0) continue;
    double p = fs / f;
    if (p >= 2.0) {
      if (pxx[k] > best_pow_global) { best_pow_global = pxx[k]; best_k_global = k; }
    }
    if (p >= min_period && p <= max_period) {
      if (pxx[k] > best_pow_local) { best_pow_local = pxx[k]; best_k_local = k; }
    }
  }

  if (best_k_local > 0) {
    dom_period = fs / freqs[best_k_local];
    dom_phase = atan2(a[best_k_local].imag(), a[best_k_local].real());
  }
  if (best_k_global > 0) {
    dom_global = fs / freqs[best_k_global];
  }
}

static void compute_stft(const std::vector<double>& x_in, double fs, const char* window,
                         int nperseg, int noverlap, int nfft,
                         int detrend_type, int return_onesided,
                         std::vector<double>& freqs, std::vector<double>& t,
                         std::vector<double>& zre, std::vector<double>& zim)
{
  std::vector<double> x = x_in;
  detrend_series(x, detrend_type);

  int n = (int)x.size();
  if (nperseg <= 0) nperseg = n;
  if (noverlap < 0) noverlap = nperseg/2;
  if (noverlap >= nperseg) noverlap = nperseg - 1;
  int step = nperseg - noverlap;
  if (step <= 0) return;

  int nfft_eff = (nfft > 0 ? nfft : nperseg);
  if (nfft_eff < nperseg) nfft_eff = nperseg;
  nfft_eff = next_pow2(nfft_eff);

  int nfreq = return_onesided ? (nfft_eff/2 + 1) : nfft_eff;
  int nseg = (n - noverlap) / step;
  if (nseg <= 0) return;

  freqs.assign(nfreq, 0.0);
  for (int k=0;k<nfreq;k++) freqs[k] = fs * (double)k / (double)nfft_eff;

  t.assign(nseg, 0.0);
  zre.assign(nfreq * nseg, 0.0);
  zim.assign(nfreq * nseg, 0.0);

  std::vector<double> seg(nperseg);
  for (int s=0;s<nseg;s++) {
    int start = s * step;
    for (int i=0;i<nperseg;i++) seg[i] = x[start + i];
    apply_window(seg, window);

    std::vector<std::complex<double>> a(nfft_eff);
    for (int i=0;i<nperseg;i++) a[i] = std::complex<double>(seg[i], 0.0);
    for (int i=nperseg;i<nfft_eff;i++) a[i] = std::complex<double>(0.0, 0.0);

    fft_radix2(a);

    for (int k=0;k<nfreq;k++) {
      int idx = k * nseg + s;
      zre[idx] = a[k].real();
      zim[idx] = a[k].imag();
    }
    t[s] = (double)(start + nperseg/2) / fs;
  }
}

static void compute_job(const Job& job, Result& out)
{
  out.time = job.bar_time;
  out.seq = 0;
  for (int i=0;i<kOutFields;i++) out.out[i] = 0.0;

  int N = (int)std::min(job.price.size(), job.wave.size());
  if (N <= 0) return;
  int W = std::min(job.window_max, N);
  if (W < job.window_min) return;

  std::vector<double> price(job.price.begin(), job.price.begin() + W);
  std::vector<double> wave(job.wave.begin(), job.wave.begin() + W);

  std::vector<double> fP, pP;
  std::vector<double> fW, pW;

  double perP = 0.0, phP = 0.0, perPG = 0.0;
  double perW = 0.0, phW = 0.0, perWG = 0.0;

  compute_periodogram(price, 1.0, "hann", job.nfft, job.detrend, 1, fP, pP,
                      perP, phP, job.min_period, job.max_period, perPG);
  compute_periodogram(wave, 1.0, "hann", job.nfft, job.detrend, 1, fW, pW,
                      perW, phW, job.min_period, job.max_period, perWG);

  double perSub = 0.0;
  if (perP > 0.0) perSub = perP * 0.5;

  double phase_diff = fabs(phP - phW);
  while (phase_diff > M_PI) phase_diff = fabs(phase_diff - 2.0 * M_PI);
  double syncPct = (perP > 0.0 && perW > 0.0) ? (100.0 * (1.0 - phase_diff / M_PI)) : 0.0;
  if (syncPct < 0.0) syncPct = 0.0;
  if (syncPct > 100.0) syncPct = 100.0;
  double dSync = 100.0 - syncPct;

  double progP = (phP >= 0.0 ? (phP / (2.0 * M_PI)) * 100.0 : 0.0);
  double progW = (phW >= 0.0 ? (phW / (2.0 * M_PI)) * 100.0 : 0.0);
  if (progP < 0.0) progP = 0.0;
  if (progW < 0.0) progW = 0.0;

  int syncb = (int)fabs((perP > 0.0 ? perP : 0.0) - (perW > 0.0 ? perW : 0.0));

  out.out[0] = perP;
  out.out[1] = perPG;
  out.out[2] = perW;
  out.out[3] = perWG;
  out.out[4] = perSub;
  out.out[5] = syncPct;
  out.out[6] = dSync;
  out.out[7] = progP;
  out.out[8] = progW;
  out.out[9] = (double)syncb;
  out.out[10] = phP;
  out.out[11] = 0.0;
}

static void worker_loop() {
  while (true) {
    Job job;
    {
      std::unique_lock<std::mutex> lk(g_mu);
      g_cv.wait(lk, []{ return g_stop || !g_jobs.empty(); });
      if (g_stop) return;
      job = std::move(g_jobs.front());
      g_jobs.pop_front();
    }

    auto t0 = std::chrono::high_resolution_clock::now();
    Result res;
    compute_job(job, res);
    auto t1 = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

    std::lock_guard<std::mutex> lk(g_mu);
    auto &ctx = g_ctx[job.key];
    ctx.seq++;
    res.seq = ctx.seq;
    ctx.last_ms = ms;
    ctx.jobs_ok++;

    if (ctx.ring.size() >= kRingMax) ctx.ring.pop_back();
    ctx.ring.push_front(res);
  }
}

static void start_worker() {
  if (g_worker_started) return;
  g_worker_started = true;
  g_worker = std::thread(worker_loop);
  g_worker.detach();
}

} // namespace

int SCL_Submit(int64_t key,
               int64_t bar_time,
               const double* price, int price_len,
               const double* wave, int wave_len,
               int window_min, int window_max,
               int nfft, int detrend,
               double min_period, double max_period,
               int flags)
{
  if (!price || !wave || price_len <= 0 || wave_len <= 0) return 0;
  Job job;
  job.key = key;
  job.bar_time = bar_time;
  job.price.assign(price, price + price_len);
  job.wave.assign(wave, wave + wave_len);
  job.window_min = window_min;
  job.window_max = window_max;
  job.nfft = nfft;
  job.detrend = detrend;
  job.min_period = min_period;
  job.max_period = max_period;
  job.flags = flags;

  start_worker();

  std::lock_guard<std::mutex> lk(g_mu);
  if ((int)g_jobs.size() >= kQueueMax) {
    g_jobs.pop_front();
    g_ctx[key].jobs_drop++;
  }
  g_jobs.push_back(std::move(job));
  g_cv.notify_one();
  return 1;
}

int SCL_TryGetLatest(int64_t key, double* out, int out_len, int64_t* out_time, int64_t* out_seq) {
  if (!out || out_len < kOutFields) return 0;
  std::lock_guard<std::mutex> lk(g_mu);
  auto it = g_ctx.find(key);
  if (it == g_ctx.end() || it->second.ring.empty()) return 0;
  const Result &r = it->second.ring.front();
  std::memcpy(out, r.out, sizeof(double) * kOutFields);
  if (out_time) *out_time = r.time;
  if (out_seq) *out_seq = r.seq;
  return 1;
}

int SCL_TryGetByTime(int64_t key, int64_t bar_time, double* out, int out_len, int64_t* out_seq) {
  if (!out || out_len < kOutFields) return 0;
  std::lock_guard<std::mutex> lk(g_mu);
  auto it = g_ctx.find(key);
  if (it == g_ctx.end()) return 0;
  for (const Result &r : it->second.ring) {
    if (r.time == bar_time) {
      std::memcpy(out, r.out, sizeof(double) * kOutFields);
      if (out_seq) *out_seq = r.seq;
      return 1;
    }
  }
  return 0;
}

int SCL_TryGetAtIndex(int64_t key, int idx, double* out, int out_len, int64_t* out_time, int64_t* out_seq) {
  if (!out || out_len < kOutFields) return 0;
  if (idx < 0) return 0;
  std::lock_guard<std::mutex> lk(g_mu);
  auto it = g_ctx.find(key);
  if (it == g_ctx.end()) return 0;
  if (idx >= (int)it->second.ring.size()) return 0;
  const Result &r = it->second.ring[idx];
  std::memcpy(out, r.out, sizeof(double) * kOutFields);
  if (out_time) *out_time = r.time;
  if (out_seq) *out_seq = r.seq;
  return 1;
}

int SCL_GetStats(int64_t key, double* out, int out_len) {
  if (!out || out_len < 4) return 0;
  std::lock_guard<std::mutex> lk(g_mu);
  auto it = g_ctx.find(key);
  if (it == g_ctx.end()) return 0;
  out[0] = (double)it->second.jobs_ok;
  out[1] = (double)it->second.jobs_drop;
  out[2] = it->second.last_ms;
  out[3] = (double)it->second.ring.size();
  return 1;
}

int SCL_Periodogram(const double* x, int x_len, double fs, const char* window, int nfft,
                    int detrend_type, int return_onesided, const char* scaling,
                    double* freqs, int freqs_len, double* pxx, int pxx_len)
{
  if (!x || x_len <= 0) return 0;
  std::vector<double> xin(x, x + x_len);
  std::vector<double> f, p;
  double dp = 0.0, ph = 0.0, dg = 0.0;
  compute_periodogram(xin, fs, window, nfft, detrend_type, return_onesided, f, p, dp, ph, 2.0, (double)x_len/2.0, dg);
  if ((int)f.size() > freqs_len || (int)p.size() > pxx_len) return 0;
  for (size_t i=0;i<f.size();i++) freqs[i] = f[i];
  for (size_t i=0;i<p.size();i++) pxx[i] = p[i];
  return 1;
}

int SCL_STFT(const double* x, int x_len, double fs, const char* window,
             int nperseg, int noverlap, int nfft,
             int detrend_type, int return_onesided, const char* scaling,
             double* freqs, int freqs_len, double* t, int t_len,
             double* zre, int zre_len, double* zim, int zim_len)
{
  if (!x || x_len <= 0) return 0;
  std::vector<double> xin(x, x + x_len);
  std::vector<double> f, tt, zr, zi;
  compute_stft(xin, fs, window, nperseg, noverlap, nfft, detrend_type, return_onesided, f, tt, zr, zi);
  if ((int)f.size() > freqs_len || (int)tt.size() > t_len) return 0;
  if ((int)zr.size() > zre_len || (int)zi.size() > zim_len) return 0;
  for (size_t i=0;i<f.size();i++) freqs[i] = f[i];
  for (size_t i=0;i<tt.size();i++) t[i] = tt[i];
  for (size_t i=0;i<zr.size();i++) zre[i] = zr[i];
  for (size_t i=0;i<zi.size();i++) zim[i] = zi[i];
  return 1;
}
