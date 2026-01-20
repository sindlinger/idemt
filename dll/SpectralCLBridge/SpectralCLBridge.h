#pragma once

#include <stdint.h>

#if defined(_WIN32)
  #define SCL_EXPORT extern "C" __declspec(dllexport)
#else
  #define SCL_EXPORT extern "C"
#endif

SCL_EXPORT int SCL_Submit(int64_t key,
                          int64_t bar_time,
                          const double* price, int price_len,
                          const double* wave, int wave_len,
                          int window_min, int window_max,
                          int nfft, int detrend,
                          double min_period, double max_period,
                          int flags);

SCL_EXPORT int SCL_TryGetLatest(int64_t key,
                               double* out, int out_len,
                               int64_t* out_time, int64_t* out_seq);

SCL_EXPORT int SCL_TryGetByTime(int64_t key,
                               int64_t bar_time,
                               double* out, int out_len,
                               int64_t* out_seq);

SCL_EXPORT int SCL_TryGetAtIndex(int64_t key,
                                int idx,
                                double* out, int out_len,
                                int64_t* out_time, int64_t* out_seq);

SCL_EXPORT int SCL_GetStats(int64_t key, double* out, int out_len);

// Config via DLL (indicador -> service)
SCL_EXPORT int SCL_SetChart(int64_t key, int64_t chart_id);
SCL_EXPORT int SCL_TryGetChart(int64_t key, int64_t* chart_id, int64_t* seq);

SCL_EXPORT int SCL_Shutdown();

SCL_EXPORT int SCL_Periodogram(const double* x, int x_len, double fs, const char* window, int nfft,
                               int detrend_type, int return_onesided, const char* scaling,
                               double* freqs, int freqs_len, double* pxx, int pxx_len);

SCL_EXPORT int SCL_STFT(const double* x, int x_len, double fs, const char* window,
                        int nperseg, int noverlap, int nfft,
                        int detrend_type, int return_onesided, const char* scaling,
                        double* freqs, int freqs_len, double* t, int t_len,
                        double* zre, int zre_len, double* zim, int zim_len);
