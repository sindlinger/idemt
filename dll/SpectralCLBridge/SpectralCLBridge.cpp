#include "SpectralCLBridge.h"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include <CL/cl.h>
#include <vector>
#include <deque>
#include <unordered_map>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <cmath>
#include <cstring>
#include <string>
#include <algorithm>

namespace {

static const int kOutFields = 12;
// Fila maior para evitar perda quando o indicador demorar a consumir.
static const int kQueueMax = 256;
static const int kRingMax = 4096;
static constexpr double kPi = 3.1415926535897932384626433832795;

struct CDouble2 {
  double x;
  double y;
};

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

struct Config {
  int64_t chart_id = 0;
  int64_t seq = 0;
};

static std::mutex g_mu;
static std::condition_variable g_cv;
static std::deque<Job> g_jobs;
static std::unordered_map<int64_t, Context> g_ctx;
static std::unordered_map<int64_t, Config> g_cfg;
static std::thread g_worker;
static bool g_worker_started = false;
static bool g_stop = false;

static const char* kSpectralKernelSrc = R"CLC(
#pragma OPENCL EXTENSION cl_khr_fp64 : enable
#ifndef M_PI
#define M_PI 3.1415926535897932384626433832795
#endif

double bessel_i0(double x){
  double ax=fabs(x);
  if(ax<3.75){ double y=x/3.75; y*=y; return 1.0 + y*(3.5156229 + y*(3.0899424 + y*(1.2067492 + y*(0.2659732 + y*(0.0360768 + y*0.0045813))))); }
  double y=3.75/ax; return (exp(ax)/sqrt(ax))*(0.39894228 + y*(0.01328592 + y*(0.00225319 + y*(-0.00157565 + y*(0.00916281 + y*(-0.02057706 + y*(0.02635537 + y*(-0.01647633 + y*0.00392377))))))));
}

__kernel void win_core(int type, int M, int sym, __global const double* params, int ncoeff,
  __global const double* coeffs, __global double* out){
  int i=get_global_id(0); if(i>=M) return;
  double N=(double)M; double w=0.0; double hlf=(N-1.0)/2.0;
  if(type==0){ w=1.0; }
  else if(type==1){ w=1.0 - fabs((i-hlf)/((N+1.0)/2.0)); }
  else if(type==2){ double x=fabs((i-hlf)/(hlf+1.0)); if(x<=0.5) w=1.0-6.0*x*x+6.0*x*x*x; else if(x<=1.0) w=2.0*pow(1.0-x,3.0); else w=0.0; }
  else if(type==3){ double x=fabs((i-hlf)/hlf); w=(1.0-x)*cos(M_PI*x) + (1.0/M_PI)*sin(M_PI*x); }
  else if(type==4){ double ang=2.0*M_PI*i/(N-1.0); w=0.42-0.5*cos(ang)+0.08*cos(2.0*ang); }
  else if(type==5){ double ang=2.0*M_PI*i/(N-1.0); w=0.355768-0.487396*cos(ang)+0.144232*cos(2.0*ang)-0.012604*cos(3.0*ang); }
  else if(type==6){ double ang=2.0*M_PI*i/(N-1.0); w=0.35875-0.48829*cos(ang)+0.14128*cos(2.0*ang)-0.01168*cos(3.0*ang); }
  else if(type==7){ double ang=2.0*M_PI*i/(N-1.0); w=1.0-1.93*cos(ang)+1.29*cos(2.0*ang)-0.388*cos(3.0*ang)+0.0322*cos(4.0*ang); }
  else if(type==8){ w=1.0 - fabs((i-hlf)/hlf); }
  else if(type==9){ double ang=2.0*M_PI*i/(N-1.0); w=0.5-0.5*cos(ang); }
  else if(type==10){ double alpha=params[0]; if(alpha<=0.0) w=1.0; else if(alpha>=1.0){ double ang=2.0*M_PI*i/(N-1.0); w=0.5-0.5*cos(ang);} else { double edge=alpha*(N-1.0)/2.0; if(i<edge){ double ang=M_PI*(2.0*i/alpha/(N-1.0)-1.0); w=0.5*(1.0+cos(ang)); } else if(i<=(N-1.0)*(1.0-alpha/2.0)) w=1.0; else { double ang=M_PI*(2.0*i/alpha/(N-1.0)-2.0/alpha+1.0); w=0.5*(1.0+cos(ang)); }} }
  else if(type==11){ double x=fabs((i-hlf)/hlf); w=0.62-0.48*x+0.38*cos(M_PI*x); }
  else if(type==12){ double alpha=params[0]; double ang=2.0*M_PI*i/(N-1.0); w=alpha-(1.0-alpha)*cos(ang); }
  else if(type==13){ double ang=2.0*M_PI*i/(N-1.0); w=0.54-0.46*cos(ang); }
  else if(type==14){ double beta=params[0]; double r=2.0*i/(N-1.0)-1.0; w=bessel_i0(beta*sqrt(1.0-r*r))/bessel_i0(beta); }
  else if(type==15){ double std=params[0]; double x=(i-hlf)/std; w=exp(-0.5*x*x); }
  else if(type==16){ double p=params[0]; double sig=params[1]; double x=fabs((i-hlf)/sig); w=exp(-0.5*pow(x,2.0*p)); }
  else if(type==17){ w=sin(M_PI/N*(i+0.5)); }
  else if(type==18){ double tau=params[0]; double center=params[1]; if(center<0.0) center=(N-1.0)/2.0; w=exp(-fabs(i-center)/tau); }
  else if(type==19){ double delta=2.0*M_PI/(N-1.0); double fac=-M_PI + delta*i; double temp=0.0; for(int k=0;k<ncoeff;k++){ temp += coeffs[k]*cos((double)k*fac);} w=temp; }
  else if(type==21){ double norm=params[0]; double mod_pi=2.0*M_PI/N; double temp=mod_pi*(i - N/2.0 + 0.5); double dot=0.0; for(int k=1;k<=ncoeff;k++){ dot += coeffs[k-1]*cos(temp*(double)k);} double val=1.0 + 2.0*dot; if(norm>0.5){ double temp2=mod_pi*(((N-1.0)/2.0) - N/2.0 + 0.5); double dot2=0.0; for(int k=1;k<=ncoeff;k++){ dot2 += coeffs[k-1]*cos(temp2*(double)k);} double scale=1.0/(1.0+2.0*dot2); val*=scale; } w=val; }
  out[i]=w; }

inline uint bitrev(uint x, uint bits){
  uint y=0; for(uint i=0;i<bits;i++){ y=(y<<1) | (x & 1); x>>=1; } return y; }

__kernel void bit_reverse(__global const double2* in, __global double2* out, int N, int bits){
  int i=get_global_id(0); if(i>=N) return; uint r=bitrev((uint)i,(uint)bits); out[r]=in[i]; }

__kernel void bit_reverse_batch(__global const double2* in, __global double2* out, int N, int bits){
  int gid=get_global_id(0); int seg=gid / N; int i=gid - seg*N; if(i>=N) return;
  uint r=bitrev((uint)i,(uint)bits); out[seg*N + r]=in[seg*N + i]; }

__kernel void fft_stage(__global const double2* in, __global double2* out, int N, int m, int inverse){
  int i=get_global_id(0); int hlf=m>>1; int total=N>>1; if(i>=total) return;
  int j=i%hlf; int block=i/hlf; int k=block*m + j;
  double angle = (inverse? 2.0 : -2.0) * M_PI * (double)j / (double)m;
  double c=cos(angle); double s=sin(angle);
  double2 a=in[k]; double2 b=in[k+hlf];
  double2 t = (double2)(b.x*c - b.y*s, b.x*s + b.y*c);
  out[k] = (double2)(a.x + t.x, a.y + t.y);
  out[k+hlf] = (double2)(a.x - t.x, a.y - t.y);
}

__kernel void fft_stage_batch(__global const double2* in, __global double2* out, int N, int m, int inverse){
  int gid=get_global_id(0); int hlf=m>>1; int total=N>>1; int seg=gid / total; int i=gid - seg*total; if(i>=total) return;
  int j=i%hlf; int block=i/hlf; int k=block*m + j; int base=seg*N;
  double angle = (inverse? 2.0 : -2.0) * M_PI * (double)j / (double)m;
  double c=cos(angle); double s=sin(angle);
  double2 a=in[base + k]; double2 b=in[base + k + hlf];
  double2 t = (double2)(b.x*c - b.y*s, b.x*s + b.y*c);
  out[base + k] = (double2)(a.x + t.x, a.y + t.y);
  out[base + k + hlf] = (double2)(a.x - t.x, a.y - t.y);
}

__kernel void fft_scale(__global double2* data, int N, double invN){
  int i=get_global_id(0); if(i>=N) return; data[i].x*=invN; data[i].y*=invN; }

__kernel void fft_scale_batch(__global double2* data, int N, double invN){
  int gid=get_global_id(0); int i=gid; if(i>=N) return; data[i].x*=invN; data[i].y*=invN; }

__kernel void dft_complex(__global const double2* in, __global double2* out, int N, int inverse){
  int k=get_global_id(0); if(k>=N) return; double sign = (inverse!=0)? 1.0 : -1.0;
  double2 sum=(double2)(0.0,0.0);
  for(int n=0;n<N;n++){
    double ang = sign * 2.0 * M_PI * ((double)k * (double)n) / (double)N;
    double c=cos(ang); double s=sin(ang);
    double2 v=in[n]; sum.x += v.x*c - v.y*s; sum.y += v.x*s + v.y*c;
  }
  if(inverse!=0){ sum.x/= (double)N; sum.y/=(double)N; }
  out[k]=sum; }

inline double ext_val(__global const double* x, int N, int nedge, int btype, int ext_valid, int idx){
  if(idx<0 || idx>=ext_valid) return 0.0;
  if(btype==0 || nedge<=0) return x[idx];
  if(idx>=nedge && idx<nedge+N) return x[idx-nedge];
  if(idx<nedge){ int src=nedge-idx; if(src<0) src=0; if(src>=N) src=N-1;
    if(btype==1) return x[src]; if(btype==2) return 2.0*x[0]-x[src]; if(btype==3) return x[0]; return 0.0; }
  int i=idx-(nedge+N); int src=N-2-i; if(src<0) src=0; if(src>=N) src=N-1;
  if(btype==1) return x[src]; if(btype==2) return 2.0*x[N-1]-x[src]; if(btype==3) return x[N-1]; return 0.0; }

__kernel void load_real_segment(__global const double* x, __global const double* win, __global double2* out,
  int xlen, int start, int nperseg, int nfft, int btype, int nedge, int ext_valid){
  int i=get_global_id(0); if(i>=nfft) return; double v=0.0;
  if(i<nperseg){ int idx=start+i; v = ext_val(x,xlen,nedge,btype,ext_valid,idx) * win[i]; }
  out[i]=(double2)(v,0.0); }

__kernel void load_real_segment_batch(__global const double* x, __global const double* win, __global double2* out,
  int xlen, int start0, int step, int nperseg, int nfft, int btype, int nedge, int ext_valid){
  int gid=get_global_id(0); int seg=gid / nfft; int i=gid - seg*nfft; double v=0.0;
  int start = start0 + seg*step;
  if(i<nperseg){ int idx=start+i; v = ext_val(x,xlen,nedge,btype,ext_valid,idx) * win[i]; }
  out[seg*nfft + i]=(double2)(v,0.0); }

__kernel void load_real_segment_detrend(__global const double* x, __global const double* win, __global const double* sumout,
  int xlen, int start, int nperseg, int nfft, int detrend_type, double sum_i, double sum_i2, int btype, int nedge, int ext_valid, __global double2* out){
  int i=get_global_id(0); if(i>=nfft) return; double v=0.0;
  if(i<nperseg){ int idx=start+i; double xi=ext_val(x,xlen,nedge,btype,ext_valid,idx);
    if(detrend_type==1){ double mean = sumout[0]/(double)nperseg; xi = xi - mean; }
    else if(detrend_type==2){ double n=(double)nperseg; double denom = n*sum_i2 - sum_i*sum_i; double m=0.0;
      if(denom!=0.0) m=(n*sumout[1] - sum_i*sumout[0])/denom; double b=(sumout[0]-m*sum_i)/n; xi = xi - (m*(double)i + b); }
    v = xi*win[i]; } out[i]=(double2)(v,0.0); }

__kernel void load_real_segment_detrend_batch(__global const double* x, __global const double* win, __global const double* sumout,
  int xlen, int start0, int step, int nperseg, int nfft, int detrend_type, double sum_i, double sum_i2, int btype, int nedge, int ext_valid, __global double2* out){
  int gid=get_global_id(0); int seg=gid / nfft; int i=gid - seg*nfft; double v=0.0; int start=start0 + seg*step;
  if(i<nperseg){ int idx=start+i; double xi=ext_val(x,xlen,nedge,btype,ext_valid,idx);
    double s0=sumout[2*seg]; double s1=sumout[2*seg+1];
    if(detrend_type==1){ double mean = s0/(double)nperseg; xi = xi - mean; }
    else if(detrend_type==2){ double n=(double)nperseg; double denom = n*sum_i2 - sum_i*sum_i; double m=0.0;
      if(denom!=0.0) m=(n*s1 - sum_i*s0)/denom; double b=(s0-m*sum_i)/n; xi = xi - (m*(double)i + b); }
    v = xi*win[i]; } out[seg*nfft + i]=(double2)(v,0.0); }

__kernel void pack_segments(__global const double2* in, int nseg, int nfft, int nfreq, __global double2* out){
  int gid=get_global_id(0); int total=nseg*nfreq; if(gid>=total) return; int s=gid/nfreq; int k=gid - s*nfreq;
  out[gid]=in[s*nfft + k]; }

)CLC";

struct CLState {
  cl_context ctx = nullptr;
  cl_device_id dev = nullptr;
  cl_command_queue queue = nullptr;
  cl_program prog = nullptr;
  cl_kernel k_win_core = nullptr;
  cl_kernel k_bitrev = nullptr;
  cl_kernel k_bitrev_b = nullptr;
  cl_kernel k_stage = nullptr;
  cl_kernel k_stage_b = nullptr;
  cl_kernel k_scale = nullptr;
  cl_kernel k_scale_b = nullptr;
  cl_kernel k_dft = nullptr;
  cl_kernel k_load_seg = nullptr;
  cl_kernel k_load_seg_b = nullptr;
  cl_kernel k_load_det = nullptr;
  cl_kernel k_load_det_b = nullptr;
  cl_kernel k_pack = nullptr;
  bool ready = false;
};

static CLState g_cl;
static std::mutex g_cl_mu;

static int next_pow2(int n) {
  int p = 1;
  while (p < n && p < (1 << 30)) p <<= 1;
  return p;
}

static bool is_pow2(int n) {
  return (n > 0) && ((n & (n - 1)) == 0);
}

static int ilog2_int(int n) {
  int bits = 0;
  while ((1 << bits) < n) bits++;
  return bits;
}

static bool cl_has_fp64(cl_device_id dev) {
  size_t sz = 0;
  if (clGetDeviceInfo(dev, CL_DEVICE_EXTENSIONS, 0, nullptr, &sz) != CL_SUCCESS) return false;
  std::string exts(sz, '\0');
  if (clGetDeviceInfo(dev, CL_DEVICE_EXTENSIONS, sz, exts.data(), nullptr) != CL_SUCCESS) return false;
  return (exts.find("cl_khr_fp64") != std::string::npos);
}

static bool cl_select_gpu(cl_device_id &out_dev) {
  cl_uint nplat = 0;
  if (clGetPlatformIDs(0, nullptr, &nplat) != CL_SUCCESS || nplat == 0) return false;
  std::vector<cl_platform_id> plats(nplat);
  if (clGetPlatformIDs(nplat, plats.data(), nullptr) != CL_SUCCESS) return false;
  for (cl_platform_id plat : plats) {
    cl_uint ndev = 0;
    if (clGetDeviceIDs(plat, CL_DEVICE_TYPE_GPU, 0, nullptr, &ndev) != CL_SUCCESS || ndev == 0) continue;
    std::vector<cl_device_id> devs(ndev);
    if (clGetDeviceIDs(plat, CL_DEVICE_TYPE_GPU, ndev, devs.data(), nullptr) != CL_SUCCESS) continue;
    for (cl_device_id dev : devs) {
      if (cl_has_fp64(dev)) { out_dev = dev; return true; }
    }
  }
  return false;
}

static void cl_release() {
  if (g_cl.k_pack) clReleaseKernel(g_cl.k_pack);
  if (g_cl.k_load_det_b) clReleaseKernel(g_cl.k_load_det_b);
  if (g_cl.k_load_det) clReleaseKernel(g_cl.k_load_det);
  if (g_cl.k_load_seg_b) clReleaseKernel(g_cl.k_load_seg_b);
  if (g_cl.k_load_seg) clReleaseKernel(g_cl.k_load_seg);
  if (g_cl.k_scale_b) clReleaseKernel(g_cl.k_scale_b);
  if (g_cl.k_scale) clReleaseKernel(g_cl.k_scale);
  if (g_cl.k_dft) clReleaseKernel(g_cl.k_dft);
  if (g_cl.k_stage_b) clReleaseKernel(g_cl.k_stage_b);
  if (g_cl.k_stage) clReleaseKernel(g_cl.k_stage);
  if (g_cl.k_bitrev_b) clReleaseKernel(g_cl.k_bitrev_b);
  if (g_cl.k_bitrev) clReleaseKernel(g_cl.k_bitrev);
  if (g_cl.k_win_core) clReleaseKernel(g_cl.k_win_core);
  if (g_cl.prog) clReleaseProgram(g_cl.prog);
  if (g_cl.queue) clReleaseCommandQueue(g_cl.queue);
  if (g_cl.ctx) clReleaseContext(g_cl.ctx);
  g_cl = CLState();
}

struct CLGuard {
  ~CLGuard() { cl_release(); }
};
static CLGuard g_cl_guard;

static bool cl_init() {
  std::lock_guard<std::mutex> lk(g_cl_mu);
  if (g_cl.ready) return true;

  cl_device_id dev = nullptr;
  if (!cl_select_gpu(dev)) return false;

  cl_int err = CL_SUCCESS;
  cl_context ctx = clCreateContext(nullptr, 1, &dev, nullptr, nullptr, &err);
  if (err != CL_SUCCESS || !ctx) return false;

  cl_command_queue queue = clCreateCommandQueue(ctx, dev, 0, &err);
  if (err != CL_SUCCESS || !queue) { clReleaseContext(ctx); return false; }

  const char* src = kSpectralKernelSrc;
  size_t len = std::strlen(kSpectralKernelSrc);
  cl_program prog = clCreateProgramWithSource(ctx, 1, &src, &len, &err);
  if (err != CL_SUCCESS || !prog) { clReleaseCommandQueue(queue); clReleaseContext(ctx); return false; }

  err = clBuildProgram(prog, 1, &dev, nullptr, nullptr, nullptr);
  if (err != CL_SUCCESS) {
    clReleaseProgram(prog);
    clReleaseCommandQueue(queue);
    clReleaseContext(ctx);
    return false;
  }

  auto make_kernel = [&](const char* name) -> cl_kernel {
    cl_kernel k = clCreateKernel(prog, name, &err);
    if (err != CL_SUCCESS) return nullptr;
    return k;
  };

  g_cl.ctx = ctx;
  g_cl.dev = dev;
  g_cl.queue = queue;
  g_cl.prog = prog;
  g_cl.k_win_core = make_kernel("win_core");
  g_cl.k_bitrev = make_kernel("bit_reverse");
  g_cl.k_bitrev_b = make_kernel("bit_reverse_batch");
  g_cl.k_stage = make_kernel("fft_stage");
  g_cl.k_stage_b = make_kernel("fft_stage_batch");
  g_cl.k_scale = make_kernel("fft_scale");
  g_cl.k_scale_b = make_kernel("fft_scale_batch");
  g_cl.k_dft = make_kernel("dft_complex");
  g_cl.k_load_seg = make_kernel("load_real_segment");
  g_cl.k_load_seg_b = make_kernel("load_real_segment_batch");
  g_cl.k_load_det = make_kernel("load_real_segment_detrend");
  g_cl.k_load_det_b = make_kernel("load_real_segment_detrend_batch");
  g_cl.k_pack = make_kernel("pack_segments");

  if (!g_cl.k_win_core || !g_cl.k_bitrev || !g_cl.k_bitrev_b || !g_cl.k_stage || !g_cl.k_stage_b ||
      !g_cl.k_scale || !g_cl.k_scale_b || !g_cl.k_dft || !g_cl.k_load_seg || !g_cl.k_load_seg_b ||
      !g_cl.k_load_det || !g_cl.k_load_det_b || !g_cl.k_pack) {
    cl_release();
    return false;
  }

  g_cl.ready = true;
  return true;
}

static bool cl_run_kernel(cl_kernel k, size_t global) {
  if (clEnqueueNDRangeKernel(g_cl.queue, k, 1, nullptr, &global, nullptr, 0, nullptr, nullptr) != CL_SUCCESS) return false;
  return (clFinish(g_cl.queue) == CL_SUCCESS);
}

static bool cl_write(cl_mem buf, const void* data, size_t bytes) {
  return (clEnqueueWriteBuffer(g_cl.queue, buf, CL_TRUE, 0, bytes, data, 0, nullptr, nullptr) == CL_SUCCESS);
}

static bool cl_read(cl_mem buf, void* data, size_t bytes) {
  return (clEnqueueReadBuffer(g_cl.queue, buf, CL_TRUE, 0, bytes, data, 0, nullptr, nullptr) == CL_SUCCESS);
}

static double acosh_d(double x) {
  return std::log(x + std::sqrt(x * x - 1.0));
}

static double cosh_d(double x) {
  return 0.5 * (std::exp(x) + std::exp(-x));
}

static void to_lower(std::string &s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c){ return (char)std::tolower(c); });
}

struct WindowSpec {
  int type = 9;
  std::vector<double> params;
  std::vector<double> coeffs;
  bool use_cheb = false;
  bool use_taylor = false;
  int taylor_nbar = 4;
  double taylor_sll = 30.0;
  bool taylor_norm = true;
  double cheb_at = 100.0;
};

static WindowSpec window_spec_from_name(const std::string& name) {
  WindowSpec spec;
  std::string n = name;
  to_lower(n);

  if (n == "boxcar" || n == "box" || n == "ones" || n == "rect" || n == "rectangular") spec.type = 0;
  else if (n == "triang" || n == "triangle" || n == "tri") spec.type = 1;
  else if (n == "parzen" || n == "parz" || n == "par") spec.type = 2;
  else if (n == "bohman" || n == "bman" || n == "bmn") spec.type = 3;
  else if (n == "blackman" || n == "black" || n == "blk") spec.type = 4;
  else if (n == "blackmanharris" || n == "blackharr" || n == "bkh") spec.type = 6;
  else if (n == "nuttall" || n == "nutl" || n == "nut") spec.type = 5;
  else if (n == "flattop" || n == "flat" || n == "flt") spec.type = 7;
  else if (n == "bartlett" || n == "bart" || n == "brt") spec.type = 8;
  else if (n == "hann" || n == "hanning" || n == "han") spec.type = 9;
  else if (n == "hamming" || n == "hamm" || n == "ham") spec.type = 13;
  else if (n == "barthann" || n == "brthan" || n == "bth") spec.type = 11;
  else if (n == "cosine" || n == "halfcosine") spec.type = 17;
  else if (n == "tukey" || n == "tuk") { spec.type = 10; spec.params = {0.5}; }
  else if (n == "kaiser" || n == "ksr") { spec.type = 14; spec.params = {0.0}; }
  else if (n == "gaussian" || n == "gauss" || n == "gss") { spec.type = 15; spec.params = {1.0}; }
  else if (n == "general_gaussian" || n == "general gaussian" || n == "general gauss" || n == "general_gauss" || n == "ggs") { spec.type = 16; spec.params = {1.0, 1.0}; }
  else if (n == "general_cosine" || n == "general cosine") { spec.type = 19; }
  else if (n == "general_hamming") { spec.type = 12; spec.params = {0.54}; }
  else if (n == "exponential" || n == "poisson") { spec.type = 18; spec.params = {1.0, -1.0}; }
  else if (n == "chebwin" || n == "cheb") { spec.use_cheb = true; spec.cheb_at = 100.0; }
  else if (n == "taylor") { spec.use_taylor = true; spec.taylor_nbar = 4; spec.taylor_sll = 30.0; spec.taylor_norm = true; }
  else { spec.type = 9; }

  return spec;
}

static bool fft_execute_single(const std::vector<CDouble2>& in, std::vector<CDouble2>& out) {
  if (!cl_init()) return false;
  int N = (int)in.size();
  if (N <= 0) return false;

  cl_int err = CL_SUCCESS;
  cl_mem memA = clCreateBuffer(g_cl.ctx, CL_MEM_READ_WRITE, sizeof(CDouble2) * N, nullptr, &err);
  if (err != CL_SUCCESS || !memA) return false;
  cl_mem memB = clCreateBuffer(g_cl.ctx, CL_MEM_READ_WRITE, sizeof(CDouble2) * N, nullptr, &err);
  if (err != CL_SUCCESS || !memB) { clReleaseMemObject(memA); return false; }

  bool ok = cl_write(memA, in.data(), sizeof(CDouble2) * N);
  if (!ok) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }

  if (!is_pow2(N)) {
    int inverse = 0;
    clSetKernelArg(g_cl.k_dft, 0, sizeof(cl_mem), &memA);
    clSetKernelArg(g_cl.k_dft, 1, sizeof(cl_mem), &memB);
    clSetKernelArg(g_cl.k_dft, 2, sizeof(int), &N);
    clSetKernelArg(g_cl.k_dft, 3, sizeof(int), &inverse);
    ok = cl_run_kernel(g_cl.k_dft, (size_t)N);
    if (!ok) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }
    out.resize(N);
    ok = cl_read(memB, out.data(), sizeof(CDouble2) * N);
  } else {
    int bits = ilog2_int(N);
    clSetKernelArg(g_cl.k_bitrev, 0, sizeof(cl_mem), &memA);
    clSetKernelArg(g_cl.k_bitrev, 1, sizeof(cl_mem), &memB);
    clSetKernelArg(g_cl.k_bitrev, 2, sizeof(int), &N);
    clSetKernelArg(g_cl.k_bitrev, 3, sizeof(int), &bits);
    ok = cl_run_kernel(g_cl.k_bitrev, (size_t)N);
    if (!ok) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }

    cl_mem src = memB;
    cl_mem dst = memA;
    for (int m = 2; m <= N; m <<= 1) {
      clSetKernelArg(g_cl.k_stage, 0, sizeof(cl_mem), &src);
      clSetKernelArg(g_cl.k_stage, 1, sizeof(cl_mem), &dst);
      clSetKernelArg(g_cl.k_stage, 2, sizeof(int), &N);
      clSetKernelArg(g_cl.k_stage, 3, sizeof(int), &m);
      int inverse = 0;
      clSetKernelArg(g_cl.k_stage, 4, sizeof(int), &inverse);
      size_t global = (size_t)(N / 2);
      ok = cl_run_kernel(g_cl.k_stage, global);
      if (!ok) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }
      std::swap(src, dst);
    }

    out.resize(N);
    ok = cl_read(src, out.data(), sizeof(CDouble2) * N);
  }
  clReleaseMemObject(memB);
  clReleaseMemObject(memA);
  return ok;
}

static bool window_generate_gpu(const std::string& name, int M, bool fftbins, std::vector<double>& out) {
  if (!cl_init()) return false;
  if (M <= 0) { out.clear(); return false; }

  WindowSpec spec = window_spec_from_name(name);
  if (spec.use_cheb) {
    int Mx = fftbins ? (M + 1) : M;
    bool trunc = fftbins;
    double order = (double)(Mx - 1);
    double beta = cosh_d((1.0 / order) * acosh_d(std::pow(10.0, std::fabs(spec.cheb_at) / 20.0)));
    double npi = kPi / (double)Mx;
    bool odd = ((Mx & 1) != 0);

    std::vector<CDouble2> p(Mx);
    for (int i = 0; i < Mx; i++) {
      double x = beta * std::cos((double)i * npi);
      double real = 0.0;
      if (x > 1.0) real = cosh_d(order * acosh_d(x));
      else if (x < -1.0) real = (odd ? 1.0 : -1.0) * cosh_d(order * acosh_d(-x));
      else real = std::cos(order * std::acos(x));
      if (odd) {
        p[i] = {real, 0.0};
      } else {
        double ang = (double)i * npi;
        p[i] = {real * std::cos(ang), real * std::sin(ang)};
      }
    }

    std::vector<CDouble2> spec_fft;
    if (!fft_execute_single(p, spec_fft)) return false;

    std::vector<double> wfull(Mx);
    for (int i = 0; i < Mx; i++) wfull[i] = spec_fft[i].x;

    std::vector<double> w(Mx);
    if (odd) {
      int n = (Mx + 1) / 2;
      int idx = 0;
      for (int i = n - 1; i >= 1; i--) w[idx++] = wfull[i];
      for (int i = 0; i < n; i++) w[idx++] = wfull[i];
    } else {
      int n = Mx / 2 + 1;
      int idx = 0;
      for (int i = n - 1; i >= 1; i--) w[idx++] = wfull[i];
      for (int i = 1; i < n; i++) w[idx++] = wfull[i];
    }

    double wmax = 0.0;
    for (int i = 0; i < Mx; i++) if (w[i] > wmax) wmax = w[i];
    if (wmax == 0.0) wmax = 1.0;
    for (int i = 0; i < Mx; i++) w[i] /= wmax;

    if (trunc) {
      out.assign(w.begin(), w.begin() + M);
    } else {
      out = w;
    }
    return true;
  }

  if (spec.use_taylor) {
    int nbar = spec.taylor_nbar;
    double sll = spec.taylor_sll;
    bool norm = spec.taylor_norm;
    if (nbar < 1) nbar = 1;
    int Mx = fftbins ? (M + 1) : M;
    bool trunc = fftbins;

    double B = std::pow(10.0, sll / 20.0);
    double A = acosh_d(B) / kPi;
    double s2 = (double)(nbar * nbar) / (A * A + (nbar - 0.5) * (nbar - 0.5));
    int mcount = nbar - 1;
    std::vector<double> Fm(mcount);
    for (int mi = 0; mi < mcount; mi++) {
      double m = mi + 1;
      double numer_sign = (mi % 2 == 0) ? 1.0 : -1.0;
      double numer = 1.0;
      for (int k = 0; k < mcount; k++) {
        double mk = k + 1;
        double term = 1.0 - (m * m) / (s2 * (A * A + (mk - 0.5) * (mk - 0.5)));
        numer *= term;
      }
      double denom = 1.0;
      for (int k = 0; k < mi; k++) {
        double mk = k + 1;
        denom *= (1.0 - (m * m) / (mk * mk));
      }
      for (int k = mi + 1; k < mcount; k++) {
        double mk = k + 1;
        denom *= (1.0 - (m * m) / (mk * mk));
      }
      Fm[mi] = numer_sign * numer / (2.0 * denom);
    }

    spec.type = 21;
    spec.params = {norm ? 1.0 : 0.0};
    spec.coeffs = Fm;

    int Mout = Mx;
    int nparams = (int)spec.params.size();
    int ncoeff = (int)spec.coeffs.size();
    size_t params_bytes = (size_t)std::max(1, nparams) * sizeof(double);
    size_t coeff_bytes = (size_t)std::max(1, ncoeff) * sizeof(double);

    cl_int err = CL_SUCCESS;
    cl_mem memParams = clCreateBuffer(g_cl.ctx, CL_MEM_READ_ONLY, params_bytes, nullptr, &err);
    if (err != CL_SUCCESS) return false;
    cl_mem memCoeffs = clCreateBuffer(g_cl.ctx, CL_MEM_READ_ONLY, coeff_bytes, nullptr, &err);
    if (err != CL_SUCCESS) { clReleaseMemObject(memParams); return false; }
    cl_mem memOut = clCreateBuffer(g_cl.ctx, CL_MEM_WRITE_ONLY, (size_t)Mout * sizeof(double), nullptr, &err);
    if (err != CL_SUCCESS) { clReleaseMemObject(memCoeffs); clReleaseMemObject(memParams); return false; }

    if (nparams > 0) cl_write(memParams, spec.params.data(), (size_t)nparams * sizeof(double));
    if (ncoeff > 0) cl_write(memCoeffs, spec.coeffs.data(), (size_t)ncoeff * sizeof(double));

    clSetKernelArg(g_cl.k_win_core, 0, sizeof(int), &spec.type);
    clSetKernelArg(g_cl.k_win_core, 1, sizeof(int), &Mout);
    int sym = fftbins ? 0 : 1;
    clSetKernelArg(g_cl.k_win_core, 2, sizeof(int), &sym);
    clSetKernelArg(g_cl.k_win_core, 3, sizeof(cl_mem), &memParams);
    clSetKernelArg(g_cl.k_win_core, 4, sizeof(int), &ncoeff);
    clSetKernelArg(g_cl.k_win_core, 5, sizeof(cl_mem), &memCoeffs);
    clSetKernelArg(g_cl.k_win_core, 6, sizeof(cl_mem), &memOut);

    bool ok = cl_run_kernel(g_cl.k_win_core, (size_t)Mout);
    std::vector<double> tmp(Mout);
    if (ok) ok = cl_read(memOut, tmp.data(), (size_t)Mout * sizeof(double));

    clReleaseMemObject(memOut);
    clReleaseMemObject(memCoeffs);
    clReleaseMemObject(memParams);

    if (!ok) return false;
    if (trunc) out.assign(tmp.begin(), tmp.begin() + M);
    else out = tmp;
    return true;
  }

  int Mout = fftbins ? (M + 1) : M;
  bool trunc = fftbins;
  int nparams = (int)spec.params.size();
  int ncoeff = (int)spec.coeffs.size();
  size_t params_bytes = (size_t)std::max(1, nparams) * sizeof(double);
  size_t coeff_bytes = (size_t)std::max(1, ncoeff) * sizeof(double);

  cl_int err = CL_SUCCESS;
  cl_mem memParams = clCreateBuffer(g_cl.ctx, CL_MEM_READ_ONLY, params_bytes, nullptr, &err);
  if (err != CL_SUCCESS) return false;
  cl_mem memCoeffs = clCreateBuffer(g_cl.ctx, CL_MEM_READ_ONLY, coeff_bytes, nullptr, &err);
  if (err != CL_SUCCESS) { clReleaseMemObject(memParams); return false; }
  cl_mem memOut = clCreateBuffer(g_cl.ctx, CL_MEM_WRITE_ONLY, (size_t)Mout * sizeof(double), nullptr, &err);
  if (err != CL_SUCCESS) { clReleaseMemObject(memCoeffs); clReleaseMemObject(memParams); return false; }

  if (nparams > 0) cl_write(memParams, spec.params.data(), (size_t)nparams * sizeof(double));
  if (ncoeff > 0) cl_write(memCoeffs, spec.coeffs.data(), (size_t)ncoeff * sizeof(double));

  clSetKernelArg(g_cl.k_win_core, 0, sizeof(int), &spec.type);
  clSetKernelArg(g_cl.k_win_core, 1, sizeof(int), &Mout);
  int sym = fftbins ? 0 : 1;
  clSetKernelArg(g_cl.k_win_core, 2, sizeof(int), &sym);
  clSetKernelArg(g_cl.k_win_core, 3, sizeof(cl_mem), &memParams);
  clSetKernelArg(g_cl.k_win_core, 4, sizeof(int), &ncoeff);
  clSetKernelArg(g_cl.k_win_core, 5, sizeof(cl_mem), &memCoeffs);
  clSetKernelArg(g_cl.k_win_core, 6, sizeof(cl_mem), &memOut);

  bool ok = cl_run_kernel(g_cl.k_win_core, (size_t)Mout);
  std::vector<double> tmp(Mout);
  if (ok) ok = cl_read(memOut, tmp.data(), (size_t)Mout * sizeof(double));

  clReleaseMemObject(memOut);
  clReleaseMemObject(memCoeffs);
  clReleaseMemObject(memParams);

  if (!ok) return false;
  if (trunc) out.assign(tmp.begin(), tmp.begin() + M);
  else out = tmp;
  return true;
}

static bool fft_execute_batch(cl_mem input, cl_mem tmp, int N, int nseg, cl_mem &out_final) {
  int bits = ilog2_int(N);

  if (nseg == 1) {
    clSetKernelArg(g_cl.k_bitrev, 0, sizeof(cl_mem), &input);
    clSetKernelArg(g_cl.k_bitrev, 1, sizeof(cl_mem), &tmp);
    clSetKernelArg(g_cl.k_bitrev, 2, sizeof(int), &N);
    clSetKernelArg(g_cl.k_bitrev, 3, sizeof(int), &bits);
    if (!cl_run_kernel(g_cl.k_bitrev, (size_t)N)) return false;

    cl_mem src = tmp;
    cl_mem dst = input;
    for (int m = 2; m <= N; m <<= 1) {
      clSetKernelArg(g_cl.k_stage, 0, sizeof(cl_mem), &src);
      clSetKernelArg(g_cl.k_stage, 1, sizeof(cl_mem), &dst);
      clSetKernelArg(g_cl.k_stage, 2, sizeof(int), &N);
      clSetKernelArg(g_cl.k_stage, 3, sizeof(int), &m);
      int inverse = 0;
      clSetKernelArg(g_cl.k_stage, 4, sizeof(int), &inverse);
      size_t global = (size_t)(N / 2);
      if (!cl_run_kernel(g_cl.k_stage, global)) return false;
      std::swap(src, dst);
    }
    out_final = src;
    return true;
  }

  size_t total = (size_t)nseg * (size_t)N;
  clSetKernelArg(g_cl.k_bitrev_b, 0, sizeof(cl_mem), &input);
  clSetKernelArg(g_cl.k_bitrev_b, 1, sizeof(cl_mem), &tmp);
  clSetKernelArg(g_cl.k_bitrev_b, 2, sizeof(int), &N);
  clSetKernelArg(g_cl.k_bitrev_b, 3, sizeof(int), &bits);
  if (!cl_run_kernel(g_cl.k_bitrev_b, total)) return false;

  cl_mem src = tmp;
  cl_mem dst = input;
  size_t stage_global = (size_t)nseg * (size_t)(N / 2);
  for (int m = 2; m <= N; m <<= 1) {
    clSetKernelArg(g_cl.k_stage_b, 0, sizeof(cl_mem), &src);
    clSetKernelArg(g_cl.k_stage_b, 1, sizeof(cl_mem), &dst);
    clSetKernelArg(g_cl.k_stage_b, 2, sizeof(int), &N);
    clSetKernelArg(g_cl.k_stage_b, 3, sizeof(int), &m);
    int inverse = 0;
    clSetKernelArg(g_cl.k_stage_b, 4, sizeof(int), &inverse);
    if (!cl_run_kernel(g_cl.k_stage_b, stage_global)) return false;
    std::swap(src, dst);
  }
  out_final = src;
  return true;
}

static bool load_segments(const std::vector<double>& x, const std::vector<double>& win,
                          int start0, int step, int nperseg, int nfft, int detrend_type,
                          cl_mem out, int nseg) {
  int xlen = (int)x.size();
  int btype = 0;
  int nedge = 0;
  int ext_valid = xlen;

  cl_int err = CL_SUCCESS;
  cl_mem memX = clCreateBuffer(g_cl.ctx, CL_MEM_READ_ONLY, sizeof(double) * x.size(), nullptr, &err);
  if (err != CL_SUCCESS) return false;
  cl_mem memW = clCreateBuffer(g_cl.ctx, CL_MEM_READ_ONLY, sizeof(double) * win.size(), nullptr, &err);
  if (err != CL_SUCCESS) { clReleaseMemObject(memX); return false; }

  if (!cl_write(memX, x.data(), sizeof(double) * x.size())) { clReleaseMemObject(memW); clReleaseMemObject(memX); return false; }
  if (!cl_write(memW, win.data(), sizeof(double) * win.size())) { clReleaseMemObject(memW); clReleaseMemObject(memX); return false; }

  bool ok = true;
  if (detrend_type == 0) {
    if (nseg == 1) {
      clSetKernelArg(g_cl.k_load_seg, 0, sizeof(cl_mem), &memX);
      clSetKernelArg(g_cl.k_load_seg, 1, sizeof(cl_mem), &memW);
      clSetKernelArg(g_cl.k_load_seg, 2, sizeof(cl_mem), &out);
      clSetKernelArg(g_cl.k_load_seg, 3, sizeof(int), &xlen);
      clSetKernelArg(g_cl.k_load_seg, 4, sizeof(int), &start0);
      clSetKernelArg(g_cl.k_load_seg, 5, sizeof(int), &nperseg);
      clSetKernelArg(g_cl.k_load_seg, 6, sizeof(int), &nfft);
      clSetKernelArg(g_cl.k_load_seg, 7, sizeof(int), &btype);
      clSetKernelArg(g_cl.k_load_seg, 8, sizeof(int), &nedge);
      clSetKernelArg(g_cl.k_load_seg, 9, sizeof(int), &ext_valid);
      ok = cl_run_kernel(g_cl.k_load_seg, (size_t)nfft);
    } else {
      clSetKernelArg(g_cl.k_load_seg_b, 0, sizeof(cl_mem), &memX);
      clSetKernelArg(g_cl.k_load_seg_b, 1, sizeof(cl_mem), &memW);
      clSetKernelArg(g_cl.k_load_seg_b, 2, sizeof(cl_mem), &out);
      clSetKernelArg(g_cl.k_load_seg_b, 3, sizeof(int), &xlen);
      clSetKernelArg(g_cl.k_load_seg_b, 4, sizeof(int), &start0);
      clSetKernelArg(g_cl.k_load_seg_b, 5, sizeof(int), &step);
      clSetKernelArg(g_cl.k_load_seg_b, 6, sizeof(int), &nperseg);
      clSetKernelArg(g_cl.k_load_seg_b, 7, sizeof(int), &nfft);
      clSetKernelArg(g_cl.k_load_seg_b, 8, sizeof(int), &btype);
      clSetKernelArg(g_cl.k_load_seg_b, 9, sizeof(int), &nedge);
      clSetKernelArg(g_cl.k_load_seg_b, 10, sizeof(int), &ext_valid);
      ok = cl_run_kernel(g_cl.k_load_seg_b, (size_t)nseg * (size_t)nfft);
    }
  } else {
    double sum_i = (double)(nperseg - 1) * (double)nperseg / 2.0;
    double sum_i2 = (double)(nperseg - 1) * (double)nperseg * (double)(2 * nperseg - 1) / 6.0;
    std::vector<double> sumout(2 * nseg, 0.0);
    for (int s = 0; s < nseg; s++) {
      int start = start0 + s * step;
      double sumx = 0.0;
      double sumix = 0.0;
      for (int i = 0; i < nperseg; i++) {
        int idx = start + i;
        if (idx < 0 || idx >= xlen) continue;
        double v = x[idx];
        sumx += v;
        sumix += v * (double)i;
      }
      sumout[2 * s] = sumx;
      sumout[2 * s + 1] = sumix;
    }

    cl_mem memS = clCreateBuffer(g_cl.ctx, CL_MEM_READ_ONLY, sizeof(double) * sumout.size(), nullptr, &err);
    if (err != CL_SUCCESS) { clReleaseMemObject(memW); clReleaseMemObject(memX); return false; }
    if (!cl_write(memS, sumout.data(), sizeof(double) * sumout.size())) { clReleaseMemObject(memS); clReleaseMemObject(memW); clReleaseMemObject(memX); return false; }

    if (nseg == 1) {
      clSetKernelArg(g_cl.k_load_det, 0, sizeof(cl_mem), &memX);
      clSetKernelArg(g_cl.k_load_det, 1, sizeof(cl_mem), &memW);
      clSetKernelArg(g_cl.k_load_det, 2, sizeof(cl_mem), &memS);
      clSetKernelArg(g_cl.k_load_det, 3, sizeof(int), &xlen);
      clSetKernelArg(g_cl.k_load_det, 4, sizeof(int), &start0);
      clSetKernelArg(g_cl.k_load_det, 5, sizeof(int), &nperseg);
      clSetKernelArg(g_cl.k_load_det, 6, sizeof(int), &nfft);
      clSetKernelArg(g_cl.k_load_det, 7, sizeof(int), &detrend_type);
      clSetKernelArg(g_cl.k_load_det, 8, sizeof(double), &sum_i);
      clSetKernelArg(g_cl.k_load_det, 9, sizeof(double), &sum_i2);
      clSetKernelArg(g_cl.k_load_det, 10, sizeof(int), &btype);
      clSetKernelArg(g_cl.k_load_det, 11, sizeof(int), &nedge);
      clSetKernelArg(g_cl.k_load_det, 12, sizeof(int), &ext_valid);
      clSetKernelArg(g_cl.k_load_det, 13, sizeof(cl_mem), &out);
      ok = cl_run_kernel(g_cl.k_load_det, (size_t)nfft);
    } else {
      clSetKernelArg(g_cl.k_load_det_b, 0, sizeof(cl_mem), &memX);
      clSetKernelArg(g_cl.k_load_det_b, 1, sizeof(cl_mem), &memW);
      clSetKernelArg(g_cl.k_load_det_b, 2, sizeof(cl_mem), &memS);
      clSetKernelArg(g_cl.k_load_det_b, 3, sizeof(int), &xlen);
      clSetKernelArg(g_cl.k_load_det_b, 4, sizeof(int), &start0);
      clSetKernelArg(g_cl.k_load_det_b, 5, sizeof(int), &step);
      clSetKernelArg(g_cl.k_load_det_b, 6, sizeof(int), &nperseg);
      clSetKernelArg(g_cl.k_load_det_b, 7, sizeof(int), &nfft);
      clSetKernelArg(g_cl.k_load_det_b, 8, sizeof(int), &detrend_type);
      clSetKernelArg(g_cl.k_load_det_b, 9, sizeof(double), &sum_i);
      clSetKernelArg(g_cl.k_load_det_b, 10, sizeof(double), &sum_i2);
      clSetKernelArg(g_cl.k_load_det_b, 11, sizeof(int), &btype);
      clSetKernelArg(g_cl.k_load_det_b, 12, sizeof(int), &nedge);
      clSetKernelArg(g_cl.k_load_det_b, 13, sizeof(int), &ext_valid);
      clSetKernelArg(g_cl.k_load_det_b, 14, sizeof(cl_mem), &out);
      ok = cl_run_kernel(g_cl.k_load_det_b, (size_t)nseg * (size_t)nfft);
    }

    clReleaseMemObject(memS);
  }

  clReleaseMemObject(memW);
  clReleaseMemObject(memX);
  return ok;
}

static bool gpu_periodogram(const std::vector<double>& x, double fs, const std::string& window, int nfft,
                            int detrend_type, bool onesided, const std::string& scaling,
                            std::vector<double>& freqs, std::vector<double>& pxx,
                            std::vector<CDouble2>& spec_out) {
  if (!cl_init()) return false;
  int N = (int)x.size();
  if (N <= 0) return false;

  int nperseg = (nfft > 0 ? std::min(nfft, N) : N);
  if (nperseg <= 0) return false;
  int nfft_eff = (nfft > 0 ? nfft : nperseg);
  if (nfft_eff < nperseg) nfft_eff = nperseg;
  nfft_eff = next_pow2(nfft_eff);

  std::vector<double> win;
  if (!window_generate_gpu(window, nperseg, true, win)) return false;

  double wsum = 0.0;
  double winpow = 0.0;
  for (double v : win) { wsum += v; winpow += v * v; }

  cl_int err = CL_SUCCESS;
  cl_mem memA = clCreateBuffer(g_cl.ctx, CL_MEM_READ_WRITE, sizeof(CDouble2) * nfft_eff, nullptr, &err);
  if (err != CL_SUCCESS) return false;
  cl_mem memB = clCreateBuffer(g_cl.ctx, CL_MEM_READ_WRITE, sizeof(CDouble2) * nfft_eff, nullptr, &err);
  if (err != CL_SUCCESS) { clReleaseMemObject(memA); return false; }

  bool ok = load_segments(x, win, 0, nperseg, nperseg, nfft_eff, detrend_type, memA, 1);
  if (!ok) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }

  cl_mem memFinal = nullptr;
  ok = fft_execute_batch(memA, memB, nfft_eff, 1, memFinal);
  if (!ok) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }

  int scaling_mode = 0;
  std::string sc = scaling; to_lower(sc);
  if (sc == "density") scaling_mode = 1;
  else if (sc == "spectrum") scaling_mode = 2;

  if (scaling_mode != 0) {
    double scale = 1.0;
    if (scaling_mode == 1) { if (winpow > 0.0) scale = std::sqrt(1.0 / (fs * winpow)); }
    else if (scaling_mode == 2) { if (wsum != 0.0) scale = 1.0 / wsum; }
    if (scale != 1.0) {
      clSetKernelArg(g_cl.k_scale, 0, sizeof(cl_mem), &memFinal);
      clSetKernelArg(g_cl.k_scale, 1, sizeof(int), &nfft_eff);
      clSetKernelArg(g_cl.k_scale, 2, sizeof(double), &scale);
      ok = cl_run_kernel(g_cl.k_scale, (size_t)nfft_eff);
      if (!ok) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }
    }
  }

  spec_out.resize(nfft_eff);
  ok = cl_read(memFinal, spec_out.data(), sizeof(CDouble2) * nfft_eff);
  clReleaseMemObject(memB);
  clReleaseMemObject(memA);
  if (!ok) return false;

  int nfreq = onesided ? (nfft_eff / 2 + 1) : nfft_eff;
  freqs.assign(nfreq, 0.0);
  pxx.assign(nfreq, 0.0);

  for (int k = 0; k < nfreq; k++) {
    double f;
    if (onesided) {
      f = (double)k * fs / (double)nfft_eff;
    } else {
      int kk = (k <= nfft_eff / 2) ? k : (k - nfft_eff);
      f = (double)kk * fs / (double)nfft_eff;
    }
    freqs[k] = f;

    double re = spec_out[k].x;
    double im = spec_out[k].y;
    double mag2 = re * re + im * im;
    pxx[k] = mag2;
  }

  if (onesided) {
    int last = ((nfft_eff % 2) != 0) ? (nfreq - 1) : (nfreq - 2);
    for (int k = 1; k <= last; k++) pxx[k] *= 2.0;
  }

  return true;
}

static bool gpu_stft(const std::vector<double>& x, double fs, const std::string& window, int nperseg, int noverlap, int nfft,
                     int detrend_type, bool onesided, const std::string& scaling,
                     std::vector<double>& freqs, std::vector<double>& t,
                     std::vector<double>& zre, std::vector<double>& zim) {
  if (!cl_init()) return false;
  int N = (int)x.size();
  if (N <= 0) return false;

  if (nperseg <= 0) nperseg = N;
  if (nperseg > N) nperseg = N;
  if (noverlap < 0) noverlap = nperseg / 2;
  if (noverlap >= nperseg) noverlap = nperseg - 1;
  int step = nperseg - noverlap;
  if (step <= 0) return false;
  int nseg = (N - noverlap) / step;
  if (nseg <= 0) return false;

  int nfft_eff = (nfft > 0 ? nfft : nperseg);
  if (nfft_eff < nperseg) nfft_eff = nperseg;
  nfft_eff = next_pow2(nfft_eff);

  int nfreq = onesided ? (nfft_eff / 2 + 1) : nfft_eff;

  std::vector<double> win;
  if (!window_generate_gpu(window, nperseg, true, win)) return false;

  double wsum = 0.0;
  double winpow = 0.0;
  for (double v : win) { wsum += v; winpow += v * v; }

  cl_int err = CL_SUCCESS;
  size_t total = (size_t)nseg * (size_t)nfft_eff;
  cl_mem memA = clCreateBuffer(g_cl.ctx, CL_MEM_READ_WRITE, sizeof(CDouble2) * total, nullptr, &err);
  if (err != CL_SUCCESS) return false;
  cl_mem memB = clCreateBuffer(g_cl.ctx, CL_MEM_READ_WRITE, sizeof(CDouble2) * total, nullptr, &err);
  if (err != CL_SUCCESS) { clReleaseMemObject(memA); return false; }

  bool ok = load_segments(x, win, 0, step, nperseg, nfft_eff, detrend_type, memA, nseg);
  if (!ok) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }

  cl_mem memFinal = nullptr;
  ok = fft_execute_batch(memA, memB, nfft_eff, nseg, memFinal);
  if (!ok) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }

  int scaling_mode = 0;
  std::string sc = scaling; to_lower(sc);
  if (sc == "density") scaling_mode = 1;
  else if (sc == "spectrum") scaling_mode = 2;

  if (scaling_mode != 0) {
    double scale = 1.0;
    if (scaling_mode == 1) { if (winpow > 0.0) scale = std::sqrt(1.0 / (fs * winpow)); }
    else if (scaling_mode == 2) { if (wsum != 0.0) scale = 1.0 / wsum; }
    if (scale != 1.0) {
      int totalN = (int)total;
      clSetKernelArg(g_cl.k_scale_b, 0, sizeof(cl_mem), &memFinal);
      clSetKernelArg(g_cl.k_scale_b, 1, sizeof(int), &totalN);
      clSetKernelArg(g_cl.k_scale_b, 2, sizeof(double), &scale);
      ok = cl_run_kernel(g_cl.k_scale_b, total);
      if (!ok) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }
    }
  }

  cl_mem memPack = clCreateBuffer(g_cl.ctx, CL_MEM_READ_WRITE, sizeof(CDouble2) * (size_t)nseg * (size_t)nfreq, nullptr, &err);
  if (err != CL_SUCCESS) { clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }
  clSetKernelArg(g_cl.k_pack, 0, sizeof(cl_mem), &memFinal);
  clSetKernelArg(g_cl.k_pack, 1, sizeof(int), &nseg);
  clSetKernelArg(g_cl.k_pack, 2, sizeof(int), &nfft_eff);
  clSetKernelArg(g_cl.k_pack, 3, sizeof(int), &nfreq);
  clSetKernelArg(g_cl.k_pack, 4, sizeof(cl_mem), &memPack);
  ok = cl_run_kernel(g_cl.k_pack, (size_t)nseg * (size_t)nfreq);
  if (!ok) { clReleaseMemObject(memPack); clReleaseMemObject(memB); clReleaseMemObject(memA); return false; }

  std::vector<CDouble2> pack((size_t)nseg * (size_t)nfreq);
  ok = cl_read(memPack, pack.data(), sizeof(CDouble2) * pack.size());

  clReleaseMemObject(memPack);
  clReleaseMemObject(memB);
  clReleaseMemObject(memA);
  if (!ok) return false;

  freqs.resize(nfreq);
  for (int k = 0; k < nfreq; k++) freqs[k] = (double)k * fs / (double)nfft_eff;

  t.resize(nseg);
  for (int s = 0; s < nseg; s++) t[s] = ((double)(s * step) + (double)nperseg / 2.0) / fs;

  zre.assign((size_t)nfreq * (size_t)nseg, 0.0);
  zim.assign((size_t)nfreq * (size_t)nseg, 0.0);
  for (int s = 0; s < nseg; s++) {
    for (int k = 0; k < nfreq; k++) {
      int src = s * nfreq + k;
      int dst = k * nseg + s;
      zre[dst] = pack[src].x;
      zim[dst] = pack[src].y;
    }
  }

  return true;
}

static void compute_job(const Job& job, Result& out) {
  out.time = job.bar_time;
  out.seq = 0;
  for (int i = 0; i < kOutFields; i++) out.out[i] = 0.0;

  int N = (int)std::min(job.price.size(), job.wave.size());
  if (N <= 0) return;
  int W = std::min(job.window_max, N);
  if (W < job.window_min) return;

  std::vector<double> price(job.price.begin(), job.price.begin() + W);
  std::vector<double> wave(job.wave.begin(), job.wave.begin() + W);

  std::vector<double> fP, pP;
  std::vector<double> fW, pW;
  std::vector<CDouble2> sP, sW;

  if (!gpu_periodogram(price, 1.0, "hann", job.nfft, job.detrend, true, "density", fP, pP, sP)) return;
  if (!gpu_periodogram(wave, 1.0, "hann", job.nfft, job.detrend, true, "density", fW, pW, sW)) return;

  double perP = 0.0, phP = 0.0, perPG = 0.0;
  double perW = 0.0, phW = 0.0, perWG = 0.0;

  double best_pow_local = -1.0;
  double best_pow_global = -1.0;
  int best_k_local = -1;
  int best_k_global = -1;

  for (int k = 1; k < (int)fP.size(); k++) {
    double f = fP[k];
    if (f <= 0.0) continue;
    double p = 1.0 / f;
    if (p >= 2.0 && pP[k] > best_pow_global) { best_pow_global = pP[k]; best_k_global = k; }
    if (p >= job.min_period && p <= job.max_period && pP[k] > best_pow_local) { best_pow_local = pP[k]; best_k_local = k; }
  }
  if (best_k_local > 0) {
    perP = 1.0 / fP[best_k_local];
    phP = std::atan2(sP[best_k_local].y, sP[best_k_local].x);
  }
  if (best_k_global > 0) perPG = 1.0 / fP[best_k_global];

  best_pow_local = -1.0;
  best_pow_global = -1.0;
  best_k_local = -1;
  best_k_global = -1;
  for (int k = 1; k < (int)fW.size(); k++) {
    double f = fW[k];
    if (f <= 0.0) continue;
    double p = 1.0 / f;
    if (p >= 2.0 && pW[k] > best_pow_global) { best_pow_global = pW[k]; best_k_global = k; }
    if (p >= job.min_period && p <= job.max_period && pW[k] > best_pow_local) { best_pow_local = pW[k]; best_k_local = k; }
  }
  if (best_k_local > 0) {
    perW = 1.0 / fW[best_k_local];
    phW = std::atan2(sW[best_k_local].y, sW[best_k_local].x);
  }
  if (best_k_global > 0) perWG = 1.0 / fW[best_k_global];

  double perSub = 0.0;
  if (perP > 0.0) perSub = perP * 0.5;

  double phase_diff = std::fabs(phP - phW);
  while (phase_diff > kPi) phase_diff = std::fabs(phase_diff - 2.0 * kPi);
  double syncPct = (perP > 0.0 && perW > 0.0) ? (100.0 * (1.0 - phase_diff / kPi)) : 0.0;
  if (syncPct < 0.0) syncPct = 0.0;
  if (syncPct > 100.0) syncPct = 100.0;
  double dSync = 100.0 - syncPct;

  double progP = (phP >= 0.0 ? (phP / (2.0 * kPi)) * 100.0 : 0.0);
  double progW = (phW >= 0.0 ? (phW / (2.0 * kPi)) * 100.0 : 0.0);
  if (progP < 0.0) progP = 0.0;
  if (progW < 0.0) progW = 0.0;

  int syncb = (int)std::fabs((perP > 0.0 ? perP : 0.0) - (perW > 0.0 ? perW : 0.0));

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
}

} // namespace

static void shutdown_worker() {
  {
    std::lock_guard<std::mutex> lk(g_mu);
    g_stop = true;
  }
  g_cv.notify_all();
  if (g_worker.joinable()) g_worker.join();
}

SCL_EXPORT int SCL_Shutdown() {
  shutdown_worker();
  {
    std::lock_guard<std::mutex> lk(g_mu);
    g_jobs.clear();
    g_ctx.clear();
  }
  cl_release();
  return 1;
}

#if defined(_WIN32)
BOOL APIENTRY DllMain(HMODULE hModule, DWORD  ul_reason_for_call, LPVOID lpReserved) {
  (void)hModule;
  (void)lpReserved;
  switch (ul_reason_for_call) {
    case DLL_PROCESS_DETACH:
      SCL_Shutdown();
      break;
    default:
      break;
  }
  return TRUE;
}
#endif

int SCL_Submit(int64_t key,
               int64_t bar_time,
               const double* price, int price_len,
               const double* wave, int wave_len,
               int window_min, int window_max,
               int nfft, int detrend,
               double min_period, double max_period,
               int flags)
{
  if (g_stop) return 0;
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

int SCL_SetChart(int64_t key, int64_t chart_id) {
  std::lock_guard<std::mutex> lk(g_mu);
  Config &cfg = g_cfg[key];
  cfg.chart_id = chart_id;
  cfg.seq++;
  return 1;
}

int SCL_TryGetChart(int64_t key, int64_t* chart_id, int64_t* seq) {
  if (!chart_id || !seq) return 0;
  std::lock_guard<std::mutex> lk(g_mu);
  auto it = g_cfg.find(key);
  if (it == g_cfg.end()) return 0;
  *chart_id = it->second.chart_id;
  *seq = it->second.seq;
  return 1;
}

int SCL_Periodogram(const double* x, int x_len, double fs, const char* window, int nfft,
                    int detrend_type, int return_onesided, const char* scaling,
                    double* freqs, int freqs_len, double* pxx, int pxx_len)
{
  if (!x || x_len <= 0 || !freqs || !pxx) return 0;
  std::vector<double> xin(x, x + x_len);
  std::vector<double> f, p;
  std::vector<CDouble2> spec;
  std::string win = window ? window : "hann";
  std::string sc = scaling ? scaling : "density";
  if (!gpu_periodogram(xin, fs, win, nfft, detrend_type, return_onesided != 0, sc, f, p, spec)) return 0;
  if ((int)f.size() > freqs_len || (int)p.size() > pxx_len) return 0;
  for (size_t i = 0; i < f.size(); i++) freqs[i] = f[i];
  for (size_t i = 0; i < p.size(); i++) pxx[i] = p[i];
  return 1;
}

int SCL_STFT(const double* x, int x_len, double fs, const char* window,
             int nperseg, int noverlap, int nfft,
             int detrend_type, int return_onesided, const char* scaling,
             double* freqs, int freqs_len, double* t, int t_len,
             double* zre, int zre_len, double* zim, int zim_len)
{
  if (!x || x_len <= 0 || !freqs || !t || !zre || !zim) return 0;
  std::vector<double> xin(x, x + x_len);
  std::vector<double> f, tt, zr, zi;
  std::string win = window ? window : "hann";
  std::string sc = scaling ? scaling : "density";
  if (!gpu_stft(xin, fs, win, nperseg, noverlap, nfft, detrend_type, return_onesided != 0, sc, f, tt, zr, zi)) return 0;
  if ((int)f.size() > freqs_len || (int)tt.size() > t_len) return 0;
  if ((int)zr.size() > zre_len || (int)zi.size() > zim_len) return 0;
  for (size_t i = 0; i < f.size(); i++) freqs[i] = f[i];
  for (size_t i = 0; i < tt.size(); i++) t[i] = tt[i];
  for (size_t i = 0; i < zr.size(); i++) zre[i] = zr[i];
  for (size_t i = 0; i < zi.size(); i++) zim[i] = zi[i];
  return 1;
}
