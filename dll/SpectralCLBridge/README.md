# SpectralCLBridge DLL

DLL 64-bit para uso no MT5/MQL5 (SpectraLib).

Exports (C ABI):
- SCL_Submit
- SCL_TryGetLatest
- SCL_TryGetByTime
- SCL_TryGetAtIndex
- SCL_GetStats
- SCL_Periodogram
- SCL_STFT

Layout STFT:
- Zre/Zim sao vetores 1D em ordem freq-major:
  idx = freq_index * nseg + seg_index

Observacao:
- Estrutura pronta para GPU/OpenCL.
- O compute atual e implementacao CPU simples (referencia).
- Trocar a funcao ComputePeriodogram/ComputeSTFT por OpenCL.

Build sugerido (CMake):
- cmake -S . -B build -A x64
- cmake --build build --config Release

Copie a DLL final para MQL5\\Libraries.
