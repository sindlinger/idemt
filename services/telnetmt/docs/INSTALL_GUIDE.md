# cmdmt — Install + Defaults (Quick Guide)

## O que mudou (resumo)
- **Prefixo padrão** do install agora é `TelnetMT_` (não precisa passar `--name-prefix`).
- **`--name`** é o único parâmetro obrigatório quando você quer nomear a interface/pasta do usuário.
- **SYMBOL/TF não são obrigatórios** em comandos como `chart open`, `indicator attach` etc.
  - Se não houver `defaults.context` no config, o cmdmt usa **EURUSD/M5**.

---

## 1) Build + instalação global (Windows)
No PowerShell:
```
cd C:\git\mt5ide\services\telnetmt\cmdmt
npm run build
npm install -g .
```

Se o `cmdmt` abrir VSCode/Electron ou der warning de opção desconhecida, corrija o shim:
```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\git\mt5ide\services\telnetmt\cmdmt\tools\fix-cmdmt-shim.ps1
```

---

## 2) Install (sem prefixo manual)
**Default (prefixo `TelnetMT_`):**
```
cmdmt install "C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\<HASH>"
```
Vai criar:
- `MQL5\Services\TelnetMT_Services`
- `MQL5\Experts\TelnetMT_Experts`
- `MQL5\Scripts\TelnetMT_Scripts`

**Com nome da interface do usuário (pasta única):**
```
cmdmt install "C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\<HASH>" --name MinhaInterface
```
Cria:
- `MQL5\Services\MinhaInterface`
- `MQL5\Experts\MinhaInterface`
- `MQL5\Scripts\MinhaInterface`

**WebRequest allowlist (opcional):**
```
cmdmt install "C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\<HASH>" \
  --web http://127.0.0.1:9090 --web http://localhost:9090 --web http://host.docker.internal:9090
```

---

## 3) Defaults de SYMBOL/TF
O cmdmt usa nesta ordem:
1. `defaults.context` do `~/.cmdmt/config.json`
2. fallback automático: **EURUSD/M5**

Exemplo de config:
```
{
  "defaults": {
    "context": { "symbol": "EURUSD", "tf": "M5", "sub": 1 }
  }
}
```

---

## 4) Exemplos (sem parâmetros obrigatórios)
```
open
chart open
indicator attach ZigZag
indicator attach \\Examples\\zigzag
indicator attach EURUSD H1 ZigZag
```

> O **nome do indicador/expert é obrigatório**. O resto é opcional.

---

## 5) Observações WSL
- O `install` tenta usar PowerShell via pseudo‑TTY no WSL.
- Para desligar isso:
```
CMDMT_INSTALL_TTY=0 cmdmt install "C:\Users\...\Terminal\<HASH>"
```
