# cmdmt — resumo do que foi implementado

Este documento descreve **apenas** o que foi implementado/alterado no CLI `cmdmt` nesta rodada.

## Escopo entregue
- **Defaults inteligentes**: comandos tentam usar `defaults.context.symbol/tf/sub` sempre que possivel.
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
cmdmt indicador ZigZag
cmdmt expert run MyEA
cmdmt expert test MyEA
cmdmt examples expert run
```

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

