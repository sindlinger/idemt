# PyPlot-MT

Hub único para múltiplos canais (um indicador por subjanela), com plugins agnósticos (sem DLL).

## Visão geral
- **Hub** conecta à DLL e roteia dados para plugins Python.
- **Plugins** só implementam lógica (sem DLL).
- **Indicadores MQL5** apenas fazem plot + ponte de dados.

## Estrutura
```
src/pyshared_hub/
  pyshared_hub.py          # hub
  PyShared_hub_ui.py       # UI (tray + logs)
  hub_config.py            # canais (plugins)
  pyshared_client_base.py  # ponte DLL
  pyshared_wizard.py       # facade (wizard/generators)
  config/                  # defaults (paths)
  generators/              # plugin/indicator templates
  wizard/                  # wizard UI
  plugins/                 # exemplos (fisher, vroc_fft_spike)
assets/
  pyplot-mt.ico / pyplot-mt.svg
dist/
  PyPlot-MT.exe / PyPlot-MT.pyz
installer/wix/
  PyMTPlot.wxs
build_install.cmd
```

## Requisitos
- Python do MetaTrader (ex.: `C:\mql\Python3.12\venv\Scripts\python.exe`)
- PySide6 instalado nesse Python:
  ```
  C:\mql\Python3.12\venv\Scripts\python.exe -m pip install PySide6
  ```
- WiX v3.11 (candle.exe / light.exe)

## Instalação (usuário final)
Use o instalador diretamente:
```
C:\mql\pyshared-hub\installer\wix\PyPlot-MT.msi
```

## Setup rápido (dev)
Gera `pyshared_config.json`, copia a DLL e cria um indicador bridge no MT5:
```
node C:\git\mt5ide\pyplotmt\tools\pypmt-install.mjs --data "C:\Users\<user>\AppData\Roaming\MetaQuotes\Terminal\<HASH>"
```
Opcional:
```
--name MinhaInterface   (pasta em MQL5\Indicators)
--channel FISHER        (canal padrão do indicador gerado)
```
Se `--channel` não for passado, o script tenta usar o **primeiro canal** de `hub_config.py` (ex.: `FISHER`).

### DLL versionada
A DLL usada no install vem de:
```
<repo>\dll\PyShared_v2.dll
```
Manifesto:
```
<repo>\dll\PyShared_v2.manifest.json
```
Para usar uma DLL alternativa na instalacao (sem alterar o repo), defina:
```
PYPLOT_DLL_SRC=C:\caminho\PyShared_v2.dll
```

## Build do instalador (dev)
Execute:
```
C:\mql\pyshared-hub\build_install.cmd
```

Isso:
1) gera `PyPlot-MT.pyz`
2) compila `PyPlot-MT.exe`
3) gera `PyPlot-MT.msi`
4) abre o MSI

## Configurar Python usado pelo PyPlot-MT
Arquivo:
```
C:\Program Files\PyPlot-MT\pymtplot_python_path.txt
```
Coloque o caminho do `python.exe` (MetaTrader).

## Configurar DLL (pyshared_config.json)
O hub lê `pyshared_config.json` em:
```
%APPDATA%\MetaQuotes\Terminal\<HASH>\MQL5\Files\pyshared_config.json
```
Exemplo mínimo:
```
{
  "dll_path": "C:\\Users\\<user>\\AppData\\Roaming\\MetaQuotes\\Terminal\\<HASH>\\MQL5\\Libraries\\PyShared_v2.dll",
  "channel": "MAIN",
  "capacity_mb": 8
}
```

## UI (PyPlot-MT Hub)
Funcionalidades:
- **Connect/Disconnect** (toggle)
- **DLL path** exposto + botão de refresh
- **Logs com cores** por canal
- **Clique direito** em plugin:
  - Enable/Disable
  - Remove
  - Open Plugin File
  - Restart Hub
  - Disconnect Hub
  - New Plugin / Add Existing Plugin

Status da linha:
- verde = connected
- cinza = disconnected
- escuro = disabled

## Wizard (New Plugin)
Cria **plugin + indicador** automaticamente (base v7, 1 buffer):
1) Nome do plugin
2) Nome do canal
3) Nº de buffers (1..8)
4) Tipo de plot (Line/Histogram/Arrow)
5) Pasta do plugin (.py)
6) Pasta do indicador (.mq5)

Saídas:
- `plugins/<nome>.py` (esqueleto de Plugin)
- `<Indicators>/<nome>.mq5` (ponte + plot)
- adiciona o canal em `hub_config.py`

## Contrato de saída do plugin
O indicador aceita:
1) **1 buffer**: `return np.array([...])`
2) **N buffers concatenados**:
   - retorne `np.concatenate([buf1, buf2, ...])`
   - cada `buf` tem tamanho `n` (barras)
   - total = `n * buffers`

Opcional (para inputs do indicador):
- `process_meta(meta, ts)` recebe pacote META (sid=900) com parâmetros do indicador.

## WaveForm v2 (12 ciclos)
- Plugin: `src/pyshared_hub/plugins/fft_waveform_v2.py`
- Indicador bridge: `src/pyshared_hub/templates/PyPlotMT_WaveForm12_v1.mq5`
- Saída padrão: 12 buffers concatenados (C1..C12)
- Opção `sum_cycles`: retorna 1 buffer (soma dos 12)

## hub_config.py
Formato:
```
CHANNELS = [
  {"name": "FISHER", "plugin": "plugins.fisher", "params": {...}},
  {"name": "PIKE", "plugin": "C:\\\\mql\\\\pyshared-hub\\\\plugins\\\\pike.py", "params": {}},
]
```

Campos úteis:
- `disabled: True` para não iniciar o canal

## Build manual (Windows)
```
python -m zipapp .\src\pyshared_hub -o .\dist\PyPlot-MT.pyz
& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /t:winexe /out:"C:\mql\pyshared-hub\dist\PyPlot-MT.exe" /r:"System.Windows.Forms.dll" /r:"System.Drawing.dll" "C:\mql\pyshared-hub\launcher\PyMTPlotLauncher.cs"
```

## MSI
```
& "C:\Program Files (x86)\WiX Toolset v3.11\bin\candle.exe" -nologo -out C:\mql\pyshared-hub\installer\wix\PyPlot-MT.wixobj C:\mql\pyshared-hub\installer\wix\PyMTPlot.wxs
& "C:\Program Files (x86)\WiX Toolset v3.11\bin\light.exe"  -nologo -ext WixUIExtension -out C:\mql\pyshared-hub\installer\wix\PyPlot-MT.msi C:\mql\pyshared-hub\installer\wix\PyPlot-MT.wixobj
```

## Próximos passos
- Modularização extra (separar `ui/`, `wizard/`, `generators/`)
- Gerador de plugin com templates customizados por indicador
- Wizard com tipo de plot por buffer
