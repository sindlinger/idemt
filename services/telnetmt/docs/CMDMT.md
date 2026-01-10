# cmdmt — resumo do que foi implementado

Este documento descreve **apenas** o que foi implementado/alterado no CLI `cmdmt` nesta rodada.

## Escopo entregue
- **Defaults inteligentes**: comandos tentam usar `defaults.context.symbol/tf/sub` sempre que possivel.
- **`install`**: injeta junctions do TelnetMT e sincroniza `common.ini` (DLL/Live) + `terminal.ini` (WebRequest) no MT5 Data Folder informado.
- **`expert run` => fluxo tester completo**: resolve EA, compila `.mq5` se preciso, cria `tester.tpl`,
  gera `.set` + `.ini`, sincroniza `common.ini` (login/servidor/barras) e executa `/config`.
- **`expert test`**: roda tester sem gerar template (para cenarios avancados).
- **Examples completos**: `cmdmt examples <comando> [subcomando]` lista exemplos de todos subcomandos.
- **Header com versao**: faixa azul mostra `cmdmt vX.Y.Z`.

## Arquitetura (alto nivel)
```
cmdmt/index.ts
  └─ resolve config (layers)
  └─ dispatch (tokens)
      ├─ send -> transport.ts (socket)
      └─ test -> tester.ts (Strategy Tester)
```

## Mapa rapido dos modulos
- `config.ts`:
  - camadas: CLI > ENV > config > profile > defaults
  - runners, baseTpl, tester params, paths WSL/Windows
- `dispatch.ts`:
  - defaults por contexto
  - `install` injeta junctions + ini allowlist
  - `expert run` = tester end-to-end
  - `examples` aceita `<comando> <subcomando>`
- `tester.ts`:
  - resolve EA (busca em `MQL5/Experts`)
  - compila `.mq5` via MetaEditor (quando necessario)
  - gera `tester.tpl` + `.set` + `.ini`
  - sincroniza `common.ini` (login/servidor/barras)
  - executa terminal `/config`
- `template.ts`:
  - cria template local usando base template (UTF-16/UTF-8)

## Defaults obrigatorios (minimo recomendado)
Para permitir comandos com **1 parametro** (ex.: `cmdmt indicador ZigZag`, `cmdmt expert run MyEA`):
```json
{
  "defaults": {
    "context": { "symbol": "EURUSD", "tf": "M5", "sub": 1 },
    "tester": { "login": 123, "password": "x", "server": "MetaQuotes-Demo" }
  },
  "baseTpl": "Default.tpl"
}
```

## Exemplos principais
```
cmdmt install C:\Users\...\MetaQuotes\Terminal\<HASH>          (prefixo padrão TelnetMT_)
cmdmt install C:\...\Terminal\<HASH> --name MinhaInterface
cmdmt install C:\...\Terminal\<HASH> --name-prefix TelnetMT_
cmdmt install C:\...\Terminal\<HASH> --web https://example.com --web http://localhost:9090
cmdmt indicador ZigZag
cmdmt expert run MyEA
cmdmt expert test MyEA
cmdmt examples expert run
```
**Defaults:** quando SYMBOL/TF não são informados, o cmdmt usa `defaults.context` do config; se não houver, cai em `EURUSD/M5`.

## Shim do cmdmt (Windows)
Se o `cmdmt` abrir VSCode/Electron ou mostrar warning de opções desconhecidas, o `.cmd` do npm
pode estar chamando o `.js` direto (associação errada). Corrija com:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\git\mt5ide\services\telnetmt\cmdmt\tools\fix-cmdmt-shim.ps1
```

## Fluxo do install
1) cria junctions:
   - **default** (sem `--name`):  
     `MQL5\Services\TelnetMT_Services` -> `services/telnetmt/Services`  
     `MQL5\Experts\TelnetMT_Experts`  -> `services/telnetmt/Experts`  
     `MQL5\Scripts\TelnetMT_Scripts`  -> `services/telnetmt/Scripts`
   - com `--name MinhaInterface`:  
     `MQL5\Services\MinhaInterface` / `Experts` / `Scripts`
2) `common.ini`: `AllowDllImport=1`, `AllowLiveTrading=1` (padrão; pode desativar com `--no-allow-dll/--no-allow-live`)
3) `terminal.ini`: adiciona URLs em `[WebRequest]` quando `--web` é usado
4) No WSL, o install tenta rodar o PowerShell via pseudo‑TTY (`script`) para evitar travas.  
   Para desligar isso: `CMDMT_INSTALL_TTY=0 cmdmt install ...`

## Fluxo do tester (run)
1) resolve EA (nome/path)
2) compila `.mq5` via `metaeditorPath` (se necessario)
3) cria `tester.tpl`
4) gera `.set` em `MQL5/Profiles/Tester`
5) gera `.ini` e executa `/config`
6) copia report/logs para `artifactsDir`

## Testes executados nesta rodada
- `npm run typecheck` (cmdmt)
- `npm run build` (cmdmt)
