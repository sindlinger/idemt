# Project Map (PyPlot-MT / PyShared Hub)

## Visao geral
- Nome do projeto/indicador: PyPlot-MT Hub + Indicadores MQL5 (bridge)
- Objetivo: Conectar indicadores MQL5 (bridge) a plugins Python via DLL (PyShared_v2) usando canais por subjanela.
- Saidas principais (plots/objetos): Buffers de indicador (1..N) retornados pelo plugin Python.

## Arvore de arquivos
- `src/pyshared_hub/pyshared_hub.py` (orquestrador do hub)
- `src/pyshared_hub/PyShared_hub_ui.py` (UI PySide6)
- `src/pyshared_hub/pyshared_client_base.py` (ponte DLL)
- `src/pyshared_hub/generators/indicator_generator.py` (template indicador bridge)
- `src/pyshared_hub/templates/PyPlotMT_Bridge_v7.mq5` (MQL bridge 1 buffer)
- `src/pyshared_hub/plugins/*.py` (plugins Python)
- `hub_config.py` (mapeia canais -> plugins)
- Indicadores MQL5 (MT5): `%APPDATA%\MetaQuotes\Terminal\<HASH>\MQL5\Indicators\...`

## Fluxo de dados (pipeline)
1. Feed (MQL5): preço/volume -> DLL (stream 0, sid=100/101)
2. Meta (MQL5): parâmetros -> DLL (stream 0, sid=900)
3. Hub (Python): lê stream 0, chama plugin
4. Plugin (Python): processa série e retorna buffers
5. Hub (Python): escreve stream 1 (sid=201/202)
6. Indicator bridge (MQL5): lê stream 1 e plota buffers

## Modulos (contratos)
- `pyshared_hub.py`:
  - Responsabilidade: loop por canal, process_full/update, encaminhar META
  - Inputs: stream 0 (FULL/UPDATE/META)
  - Outputs: stream 1 (FULL/UPDATE)
- `pyshared_client_base.py`:
  - Responsabilidade: PB_Init/Read/Write
  - Inputs: dll_path + channel
  - Outputs: arrays doubles + timestamps
- Plugins:
  - API publica: `process_meta(meta, ts)`, `process_full(series, ts)`, `process_update(series, ts)`
  - Outputs: np.ndarray (1 buffer ou buffers concatenados)
- Indicador bridge:
  - Inputs: Channel, SendBars, parâmetros do indicador
  - Outputs: buffers plotados

## Modos e flags importantes
- `SendBars`, `InputTF`, `SendOnlyOnNewBar`, `InpUpdateOnTick`
- META v2 (sid=900) com parâmetros do indicador
- Plugins com `update_returns_full` (retorna full no update)

## Assumptions (o que esta "estavel")
- Stream 0/1 e sids 100/101/900/201/202 são estáveis
- Plugins retornam série em modo "series" (index 0 = barra mais recente)
- `hub_config.py` é fonte de verdade para canais ativos
