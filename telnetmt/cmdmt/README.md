# cmdmt (TelnetMT CLI)

CLI para controlar o servico TelnetMT via socket e rodar Strategy Tester com configuracao deterministica.

## Requisitos
- Node.js >= 20
- MT5 instalado (terminal) e data path configurado

## Instalacao rapida
```bash
cd cmdmt
npm install
npm run build
```

## Execucao
```bash
node dist/index.js ping
npm run dev -- ping
```

## Configuracao
Por padrao o CLI busca `~/.cmdmt/config.json`. Ordem de resolucao:
1) flags do CLI
2) variaveis de ambiente
3) config (top-level)
4) profile
5) defaults

Se algum valor obrigatorio estiver ausente (ex: host, symbol, runner), o CLI retorna erro com instrucao.

### Exemplo de config
```json
{
  "transport": { "host": "127.0.0.1", "port": 9090, "timeoutMs": 3000 },
  "baseTpl": "Base.tpl",
  "defaults": {
    "context": { "symbol": "EURUSD", "tf": "M5", "sub": 1 },
    "tester": {
      "artifactsDir": "cmdmt-artifacts",
      "reportDir": "reports",
      "login": 1234567890,
      "password": "SENHA",
      "server": "MetaQuotes-Demo",
      "syncCommon": true,
      "maxBars": 100000000
    }
  },
  "profiles": {
    "dev": { "runner": "active" }
  },
  "runners": {
    "active": {
      "terminalPath": "C:\\Program Files\\MetaTrader 5\\terminal64.exe",
      "dataPath": "C:\\Users\\me\\AppData\\Roaming\\MetaQuotes\\Terminal\\HASH",
      "portable": false
    }
  },
  "runner": "active"
}
```

### Variaveis de ambiente
- `CMDMT_CONFIG`: caminho do config JSON
- `CMDMT_PROFILE`: profile ativo
- `CMDMT_RUNNER`: runner ativo
- `CMDMT_SYMBOL`: symbol default
- `CMDMT_TF`: timeframe default
- `CMDMT_SUB`: subwindow default
- `CMDMT_BASE_TPL`: template base do `expert run`
- `CMDMT_HOST` / `CMDMT_HOSTS`
- `CMDMT_PORT` / `CMDMT_TIMEOUT`
- `CMDMT_MT5_PATH` / `CMDMT_MT5_DATA`

### Flags principais
- `--config <path>`
- `--profile <name>`
- `--runner <id>`
- `--symbol <symbol>`
- `--tf <tf>`
- `--sub <n>`
- `--base-tpl <tpl>`
- `--host <host>` / `--hosts <a,b>`
- `--mt5-path <path>` / `--mt5-data <path>`

## Comandos
### Basicos
```bash
cmdmt ping
cmdmt help
```

### Indicador (com defaults)
```bash
cmdmt indicador M5 ZigZag sub=1 depth=12 deviation=5 backstep=3
cmdmt indicador ZigZag
```

### Indicador completo (compatibilidade)
```bash
cmdmt indicator attach EURUSD M5 ZigZag sub=1 depth=12 deviation=5 backstep=3
```

### Expert no tester (OneShot via `run`)
```bash
cmdmt expert run M5 MyEA base.tpl lots=0.1
cmdmt expert run MyEA
```
Resolve o Expert (compila se existir `.mq5` via `metaeditorPath`), gera `tester.tpl` em `MQL5/Profiles/Templates`,
atualiza `common.ini` (login/servidor/barras) se configurado e executa o tester via `/config`.
Se `baseTpl` nao for informado, tenta usar `Default.tpl` automaticamente (se existir).

### Expert no tester
```bash
cmdmt expert test M5 MyEA lots=0.1
```
Gera `.set` em `MQL5/Profiles/Tester`, cria `.ini` e executa o terminal com `/config`. Logs e report sao copiados para a pasta de artefatos.

## Tester (Strategy Tester)
- `.set` vai para `MQL5/Profiles/Tester`
- `.ini` e copias ficam em `artifactsDir`
- `Report` usa `reportDir` (relativo ao data path)
 - Se o terminal ja estiver aberto com o mesmo data path, feche a instancia e rode novamente.
 - Se aparecer "account is not specified", defina `tester.login`, `tester.password` e `tester.server` no config.
 - Se quiser garantir barras, use `tester.maxBars` (e opcionalmente `tester.maxBarsInChart`) + `tester.syncCommon`.

## Shims/aliases
Copie ou adicione ao PATH:
- WSL: `cmdmt/shims/cmdmt` e `cmdmt/shims/indicador`
- Windows: `cmdmt/shims/cmdmt.cmd` e `cmdmt/shims/indicador.cmd`

O alias `indicador` usa `CMDMT_INVOKE_AS=indicador` para simplificar a sintaxe.

## Notas sobre paths (WSL/Windows)
- Se estiver em WSL, `terminalPath` e `dataPath` podem ser informados como `C:\\...`.
- O CLI converte caminhos quando necessario para `/config`.
