# TelnetMT Services

Esta pasta contém os serviços MQL5 usados para orquestrar o MetaTrader via TCP.

## Estrutura
- `telnetmt/Services/TelnetMT_SocketTelnetService.mq5`  
  Serviço TCP principal (entrada). Usa handlers em `TelnetMT_ServiceHandlers.mqh`.
- `telnetmt/Services/TelnetMT_ServiceHandlers.mqh`  
  Dispatcher de comandos (PING, OPEN_CHART, ATTACH_IND_FULL, etc).
- `telnetmt/Services/TelnetMT_SocketBridge.mqh`  
  Utilidades de socket/bridge.
- `telnetmt/Services/TelnetMT_OficialTelnetServiceBootstrap.mq5`  
  Bootstrap via arquivo `MQL5/Files/bootstrap_request.txt`.

## Observações importantes
- **Encoding**: `.mq5` no repositório estão em UTF‑16 LE. O arquivo em
  `MQL5/Services/TelnetMT_SocketTelnetService.mq5` (instalado) está em UTF‑8.
  A diferença atual é só o *BOM* e os `#include` (ver diff abaixo).
- **Includes**: o arquivo instalado usa:
  - `#include "TelnetMT\\Services\\TelnetMT_SocketBridge.mqh"`
  - `#include "TelnetMT\\Services\\TelnetMT_Mql5Diag.mqh"`
  - `#include "TelnetMT\\Services\\TelnetMT_ServiceHandlers.mqh"`

  O arquivo do repositório usa includes locais (sem o prefixo `TelnetMT\\Services\\`).
  Isso só afeta **onde** o MetaEditor espera encontrar os `.mqh` ao compilar.

## Sobre o comando "compile"
Atualmente **não existe** `COMPILE` no `TelnetMT_ServiceHandlers.mqh`.
O fluxo de compile no projeto está no **CLI `cmdmt`**, que usa `metaeditor64.exe`
ou um `compilePath` configurado.

Se você quer `compile` via TelnetMT, precisamos **adicionar um handler** novo
no dispatcher (ex.: `COMPILE`) e decidir a estratégia (ex.: criar arquivo de
request, chamar MetaEditor externamente, ou delegar ao `cmdmt`).

## Diff rápido do serviço (instalado vs repo)
Diferença observada:
```
// repo
#include "TelnetMT_SocketBridge.mqh"
#include "TelnetMT_Mql5Diag.mqh"
#include "TelnetMT_ServiceHandlers.mqh"

// instalado
#include "TelnetMT\\Services\\TelnetMT_SocketBridge.mqh"
#include "TelnetMT\\Services\\TelnetMT_Mql5Diag.mqh"
#include "TelnetMT\\Services\\TelnetMT_ServiceHandlers.mqh"
```
E o arquivo do repo está em UTF‑16 LE, enquanto o instalado está em UTF‑8.
