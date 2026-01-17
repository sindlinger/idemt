# TelnetMT + cmdmt — Install (WSL/Windows)

Este guia cobre **instalacao offline** do TelnetMT no MT5 e **uso online** via `cmdmt`.

## Requisitos
- MT5 instalado.
- Repo em: `C:\git\mt5ide\services\telnetmt` (ou ajuste o caminho).
- Node.js >= 20 (para `cmdmt`).

## 1) Install OFFLINE (junctions + ini)
Este passo **nao precisa** do MT5 aberto. Ele apenas cria junctions e ajusta `.ini`.

No WSL:
```
node /mnt/c/git/mt5ide/services/telnetmt/cmdmt/dist/index.js install \
  /mnt/c/Users/pichau/AppData/Roaming/MetaQuotes/Terminal/5A55C0E97D87E9624F10296888E21801 \
  --repo /mnt/c/git/mt5ide/services/telnetmt
```

O comando cria junctions:
- `MQL5/Services/TelnetMT_Services`
- `MQL5/Experts/TelnetMT_Experts`
- `MQL5/Scripts/TelnetMT_Scripts`

E ajusta:
- `common.ini` -> `AllowDllImport=1`, `AllowLiveTrading=1`
- `terminal.ini` -> WebRequest (se usar `--web`)

### Se o WSL nao mostrar as junctions
Crie manualmente no PowerShell:
```
New-Item -ItemType Junction -Path "C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\5A55C0E97D87E9624F10296888E21801\MQL5\Services\TelnetMT_Services" -Target "C:\git\mt5ide\services\telnetmt\Services"
New-Item -ItemType Junction -Path "C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\5A55C0E97D87E9624F10296888E21801\MQL5\Experts\TelnetMT_Experts" -Target "C:\git\mt5ide\services\telnetmt\Experts"
New-Item -ItemType Junction -Path "C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\5A55C0E97D87E9624F10296888E21801\MQL5\Scripts\TelnetMT_Scripts" -Target "C:\git\mt5ide\services\telnetmt\Scripts"
```

## 2) Instalar `cmdmt` global (WSL)
```
cd /mnt/c/git/mt5ide/services/telnetmt/cmdmt
npm link
```

Depois disso:
```
cmdmt --help
```

## 3) Usar ONLINE (precisa MT5 aberto)
Agora sim o MT5 precisa estar **aberto** com o service rodando.

No MT5:
1. Abra o MT5.
2. Navigator -> **Services** -> rode `TelnetMT_SocketTelnetService`.

No WSL:
```
cmdmt ping
```
Resposta esperada: `OK`.

## Notas
- `install` e `install_junctions.bat` sao **offline**. Nao conectam ao MT5.
- `cmdmt ping`, `cmdmt indicador`, `cmdmt expert` sao **online** (precisam do service ativo).

