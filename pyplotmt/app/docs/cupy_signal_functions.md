# CuPy Signal Functions (Notas)

Este arquivo guarda as funcoes que voce pediu para referencia rapida.

## cupyx.scipy.signal.periodogram

Assinatura:
```
cupyx.scipy.signal.periodogram(x, fs=1.0, window='boxcar', nfft=None,
                               detrend='constant', return_onesided=True,
                               scaling='density', axis=-1)
```

Resumo:
- Estima densidade/potencia espectral (PSD) via periodograma.
- Retorna frequencias `f` e potencia `Pxx`.
- Parametros importantes: `fs`, `window`, `nfft`, `detrend`, `scaling`.

## cupyx.scipy.signal.sosfiltfilt

Assinatura:
```
cupyx.scipy.signal.sosfiltfilt(sos, x, axis=-1, padtype='odd', padlen=None)
```

Resumo:
- Filtra ida e volta (zero-phase) usando secoes de 2a ordem.
- `sos` tem shape (n_sections, 6).
- `padtype/padlen` controlam como a borda e extendida.

## cupyx.scipy.signal.savgol_filter

Assinatura:
```
cupyx.scipy.signal.savgol_filter(x, window_length, polyorder, deriv=0,
                                 delta=1.0, axis=-1, mode='interp', cval=0.0)
```

Resumo:
- Filtro Savitzky-Golay 1D.
- Parametros chave: `window_length`, `polyorder`, `deriv`, `mode`.

