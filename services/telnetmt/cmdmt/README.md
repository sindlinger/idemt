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
Se nenhum `--config`/`CMDMT_CONFIG` for fornecido, o CLI tenta um config local
`cmdmt.config.json` (no diretório atual ou no diretório do cmdmt). Caso não exista,
usa `~/.cmdmt/config.json`. Ordem de resolucao:
1) flags do CLI
2) variaveis de ambiente
3) config (top-level)
4) profile
5) defaults

Se algum valor obrigatorio estiver ausente (ex: host, symbol, runner), o CLI retorna erro com instrucao.
Se `envPath` estiver definido no config, esse arquivo `.env` eh carregado antes de aplicar variaveis.

### Exemplo de config
```json
{
  "envPath": "C:\\\\git\\\\mt5ide\\\\.env",
  "transport": { "host": "127.0.0.1", "port": 9090, "timeoutMs": 3000 },
  "testerTransport": { "hosts": ["127.0.0.1"], "port": 9091 },
  "baseTpl": "Base.tpl",
  "defaults": {
    "context": { "symbol": "EURUSD", "tf": "M5", "sub": 1 },
    "tester": {
      "artifactsDir": "cmdmt-artifacts",
      "reportDir": "reports",
      "allowOpen": false,
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
  "runner": "active",
  "testerRunner": "sandbox"
}
```

### Variaveis de ambiente
- `CMDMT_CONFIG`: caminho do config JSON
- `CMDMT_ENV`: caminho do arquivo `.env` (se nao informado, tenta `./.env` e `~/.cmdmt/.env`)
- `*.env.<profile>` e `*.env.<runner>` (ex.: `~/.cmdmt/.env.sandbox`) sobrescrevem o `.env` base, mas nao sobrescrevem variaveis ja exportadas
- `CMDMT_PROFILE`: profile ativo
- `CMDMT_RUNNER`: runner ativo
- `CMDMT_TEST_RUNNER`: runner para `expert run/test` (sandbox)
- `CMDMT_TEST_HOST` / `CMDMT_TEST_HOSTS` / `CMDMT_TEST_PORT` / `CMDMT_TEST_TIMEOUT`
- `CMDMT_MIRROR_FROM` (opcional; usado pelo install via flag)
- `CMDMT_SYMBOL`: symbol default
- `CMDMT_TF`: timeframe default
- `CMDMT_SUB`: subwindow default
- `CMDMT_BASE_TPL`: template base do `expert run`
- `CMDMT_HOST` / `CMDMT_HOSTS`
- `CMDMT_PORT` / `CMDMT_TIMEOUT`
- `CMDMT_MT5_PATH` / `CMDMT_MT5_DATA`
- `CMDMT_COMPILE`: caminho do script/exe de compile
- `CMDMT_LOGIN` / `CMDMT_PASSWORD` / `CMDMT_SERVER` (login do MT5 sandbox)
- `MT5_LOGIN` / `MT5_PASSWORD` / `MT5_SERVER` (alias para as variáveis acima)
- `CMDMT_SYNC_COMMON` (true/false) para escrever login/srv em common.ini

### Tester
- `tester.allowOpen`: permite rodar mesmo com MT5 aberto no mesmo data path (usa logs do terminal aberto)

### Flags principais
- `--config <path>`
- `--profile <name>`
- `--runner <id>`
- `--test-runner <id>`
- `--test-host <host>`
- `--test-hosts <a,b>`
- `--test-port <port>`
- `--test-timeout <ms>`
- `--symbol <symbol>`
- `--tf <tf>`
- `--sub <n>`
- `--base-tpl <tpl>`
- `--visual` / `--no-visual` (override do modo visual do tester)
- `--win WxH` (tamanho da janela, ex: `1400x900`)
- `--pos X,Y` (posicao da janela, ex: `100,40`)
- `--fullscreen` / `--no-fullscreen`
- `--keep-open` (nao fecha o terminal sandbox e nao encerra ao final do tester)
- `--host <host>` / `--hosts <a,b>`
- `--mt5-path <path>` / `--mt5-data <path>`
- `--compile-path <path>`
- `--mirror-from <MT5_DATA>` (espelha MQL5 do fonte via junction)
- `--mirror-dirs <a,b,c>` (dirs dentro de MQL5 a espelhar; default: Indicators,Experts,Include,Libraries,Files,Profiles,Presets,Services,Scripts)
- `--sync-common` / `--no-sync-common` (install: escreve Login/Password/Server no `config/common.ini`)

## Comandos
### Basicos
```bash
cmdmt ping
cmdmt help
cmdmt watch
cmdmt add
cmdmt rm
cmdmt inspect
cmdmt log
cmdmt compile
```
Obs: `.cmd` nao eh suportado como compilePath. Use `MetaEditor64.exe`, `mt5-compile.exe` ou `.bat`.
Quando usar `mt5-compile.exe`, o `cmdmt` tenta preencher `MT5_HOME` automaticamente a partir do runner (`metaeditorPath`/`terminalPath`) se a variavel nao estiver definida.
Se voce informar apenas `CMDMT_MT5_PATH`, o `cmdmt` tenta inferir o `dataPath` lendo `origin.txt` em `AppData\\Roaming\\MetaQuotes\\Terminal`. Se falhar, informe `CMDMT_MT5_DATA` ou defina `runners.<id>.dataPath` no config.

### Install (sandbox)
Atualiza `config/common.ini` e `config/terminal.ini` no MT5 data folder informado.
```bash
cmdmt install "C:\\Users\\pichau\\AppData\\Roaming\\MetaQuotes\\Terminal\\SEU_HASH" --allow-dll --allow-live --sync-common
cmdmt install "C:\\Users\\pichau\\AppData\\Roaming\\MetaQuotes\\Terminal\\SEU_HASH" --mirror-from "C:\\Users\\pichau\\AppData\\Roaming\\MetaQuotes\\Terminal\\OUTRO_HASH"
```

### Indicador (add/rm)
```bash
cmdmt add -i EURUSD H1 ZigZag
cmdmt add -i EURUSD H1 "Bulls Power"
cmdmt add -i EURUSD H1 ZigZag --buffers 10 --log 50 --shot
cmdmt rm -i EURUSD H1 ZigZag
```

### Data import (CSV -> simbolo custom)
```bash
cmdmt data import rates "C:\\Users\\pichau\\Documents\\EURUSD_H1_200809101700_202510212200.csv" EURUSD_H1_CSV H1
cmdmt data import ticks "C:\\Users\\pichau\\Documents\\BTCUSD_Ticks_2024.01.01_2024.12.31.csv" BTCUSD_TICKS_2024 --digits 1
```

Flags de relatorio pos-attach (nao enviados ao MT5):
- `--report` / `--no-report`
- `--buffers 10` (quantos valores por buffer)
- `--log 50` (linhas do log)
- `--shot` / `--no-shot` (salva screenshot)
- `--shotname meu.png` (nome do arquivo)
Obs: coloque as flags antes de `--params`.

Exemplos:
```bash
cmdmt add -i EURUSD H1 ZigZag --buffers 10 --log 50
cmdmt add -i EURUSD H1 ZigZag --shot --shotname zigzag.png
cmdmt add -i EURUSD H1 ZigZag --report --params depth=12 deviation=5 backstep=3
```

### Indicador completo
```bash
cmdmt add -i EURUSD M5 ZigZag sub=1 --params depth=12 deviation=5 backstep=3
```

### Watch (atalho de nome)
```bash
cmdmt watch -i ZigZag
cmdmt add sub=1 --params depth=12 deviation=5 backstep=3
cmdmt rm sub=1
cmdmt watch clear
```

### Inspect (informacoes de indicador/expert)
```bash
cmdmt inspect -i total
cmdmt inspect -i get ZigZag sub=1
cmdmt inspect -e find MyEA
```

### Hotkeys
```bash
cmdmt hotkey list
cmdmt hotkey set ALT+1=MEU_COMANDO
cmdmt hotkey del ALT+1
cmdmt hotkey clear
```


### Validar parsing de --params (sem MT5)
```bash
npm run validate-params
```

### Expert no tester (OneShot via `run`)
```bash
cmdmt expert run M5 MyEA base.tpl --params lots=0.1
cmdmt expert run MyEA
cmdmt expert run EURUSD H1 MyEA --visual --win 1400x900 --pos 100,40
cmdmt expert run EURUSD H1 MyEA --csv-rates "C:\\Users\\pichau\\Documents\\EURUSD_H1_200809101700_202510212200.csv"
cmdmt expert run BTCUSD H1 MyEA --csv-ticks "C:\\Users\\pichau\\Documents\\BTCUSD_Ticks_2024.01.01_2024.12.31.csv" --csv-digits 1
```
Resolve o Expert (compila se existir `.mq5` via `metaeditorPath`), gera `tester.tpl` em `MQL5/Profiles/Templates`,
atualiza `common.ini` (login/servidor/barras) se configurado e executa o tester via `/config`.
Se `baseTpl` nao for informado, tenta usar `Default.tpl` automaticamente (se existir).
`expert run` usa modo visual por padrao (pode desabilitar com `--no-visual`).
Se `testerRunner` estiver definido, o `expert run/test` usa esse runner (ideal para sandbox).

Flags CSV (opcional, antes de `--params`):
- `--csv-rates <arquivo>` / `--csv-ticks <arquivo>`
- `--csv-symbol <SIMBOLO>` (default: symbol do run)
- `--csv-tf <TF>` (default: TF do run, apenas rates)
- `--csv-base <SIMBOLO_BASE>`
- `--csv-digits <N>` (ticks)
- `--csv-spread <N>`, `--csv-tz <N>`, `--csv-sep <;>`
- `--csv-recreate`, `--csv-common`

Se o sandbox estiver fechado, o `expert run/test` abre o terminal do sandbox minimizado para importar o CSV,
depois fecha e segue com o tester normalmente.

### Expert no tester
```bash
cmdmt expert test M5 MyEA --params lots=0.1
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
- WSL: `cmdmt/shims/cmdmt`

## Notas sobre paths (WSL/Windows)
- Se estiver em WSL, `terminalPath` e `dataPath` podem ser informados como `C:\\...`.
- O CLI converte caminhos quando necessario para `/config`.
