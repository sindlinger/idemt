Você é o Codex CLI executando neste repositório. Siga rigorosamente as instruções de AGENTS.md.

META: Entregar o MVP completo descrito em AGENTS.md, de ponta a ponta, com Electron + Monaco + Codex Sidebar + Compile (MetaEditor CLI) + Run Test (terminal /config [Tester]) + coleta de logs + Report HTML Viewer.

Regras absolutas:
- Não embutir MetaEditor/MetaTrader via hacks (sem hooking/injeção).
- Renderer sem NodeIntegration; usar preload + IPC seguro.
- TypeScript em todo o projeto.
- Caminhos do MetaTrader sempre configuráveis via UI (Settings).
- “Evidence-first”: quando lidar com compile/test, sempre usar logs/diagnósticos/reports gerados de verdade.

EXECUÇÃO (não pare no meio):
- Você deve ir até o final do MVP. Se algo for incerto (paths, MT4 vs MT5, etc.), implemente tela de configuração e defaults seguros. Não faça perguntas ao usuário; assuma e siga.

ENTREGÁVEIS OBRIGATÓRIOS NO REPO:
- docs/PROGRESS.md com checklist e status atualizado.
- README.md com: pré-requisitos, setup, como configurar paths, como compilar, como rodar tester, e como usar o Codex panel.
- Estrutura de pastas clara:
  - src/main (Electron main + services)
  - src/preload (expor window.api)
  - src/renderer (UI)
  - src/shared (tipos, contrato IPC, utilitários comuns)

ARQUITETURA — Contrato IPC (obrigatório criar em src/shared/ipc.ts):
Defina:
1) Tipos:
- WorkspaceNode (file/dir, path, name, children?)
- OpenFile { path, content, version, language }
- Diagnostic { filePath, line, column, severity, message, source? }
- CodexRunRequest { userMessage, activeFilePath?, selection?, contextBundle? }
- CodexEvent (events do JSONL + eventos internos)
- CodexRunStatus { running, startedAt, endedAt?, exitCode? }
- BuildRequest { filePath }
- BuildResult { success, diagnostics, rawLogPath?, rawOutput? }
- TestRequest { expertPath, symbol, timeframe, fromDate, toDate, deposit?, reportPath? }
- TestStatus { running, phase, lastLogLines, reportReady? }

2) Canais/eventos:
- workspace:selected
- workspace:tree
- file:open
- file:save
- file:changed (watcher)
- codex:run:start
- codex:run:event
- codex:run:done
- codex:run:cancel
- build:start
- build:result
- test:start
- test:status
- test:done
- logs:append (para Output/Terminal/Tester)
- settings:get / settings:set

UI — Layout obrigatório:
- Sidebar esquerda: File Tree + botão “Open Workspace”.
- Centro: Monaco com abas (tabs).
- Sidebar direita: “Codex” (chat + timeline + Review/diff).
- Bottom panel (toggle Ctrl+J): tabs “Terminal”, “Problems”, “Output”, “Report”.
- Botões/ações: Save (Ctrl+S), Compile, Run Test.

COMPORTAMENTO — Editor e arquivos:
- Suportar extensões: .mq4 .mq5 .mqh.
- Criar linguagem Monaco “mql” com tokenização mínima (keywords comuns, comments, strings, numbers).
- Abas: abrir múltiplos arquivos; indicador de modificado; ao trocar aba, não perder estado.
- Ao receber file:changed (externo), se arquivo estiver aberto:
  - atualizar conteúdo automaticamente, mas registrar snapshot do conteúdo anterior e gerar diff,
  - destacar linhas alteradas (Monaco decorations),
  - mostrar no painel Codex/Review opções “Accept” e “Revert”.

CODEX — Integração (obrigatório):
- Implementar em src/main/services/CodexService.ts usando `child_process.spawn` para rodar Codex CLI.
- Usar `codex exec` em modo não interativo.
- PROMPT deve ser enviado via stdin (PROMPT = '-') para suportar contexto grande.
- Consumir stdout e stderr:
  - stdout: modo texto (por padrão) ou JSONL se você optar por `--json`.
  - manter logs em `logs/codex/*.log` (criar pasta logs).
- ContextBuilder:
  - Construir automaticamente contexto com:
    1) conteúdo do arquivo ativo,
    2) seleção (se existir),
    3) últimos diagnostics do build,
    4) últimos logs do tester/build,
    5) lista de arquivos relevantes (top N por proximidade do arquivo ativo).
  - Limitar tamanho (ex.: últimos 200-400 linhas de logs, e truncar arquivos grandes).

- Fluxo de review:
  - Antes de rodar Codex, capture `git status --porcelain` e/ou snapshot do(s) arquivo(s) aberto(s).
  - Depois do run, detecte arquivos alterados (git ou watcher), e gere diffs por arquivo.
  - UI deve permitir aplicar/reverter (reverter = gravar o snapshot “antes”).

BUILD/COMPILE — MetaEditor CLI:
- Criar Settings para:
  - metaeditorPath (ex.: metaeditor64.exe)
- BuildService:
  - Rodar compile com `/compile:"<arquivo>"` e `/log`.
  - Encontrar o .log gerado e parsear em diagnostics (regex tolerante).
  - Emitir build:result com lista de diagnostics.
- Problems panel:
  - Clique em um diagnostic navega para arquivo/linha/coluna no Monaco.

TESTER — MT5 Strategy Tester (MVP para MT5):
- Criar Settings para:
  - terminalPath (ex.: terminal64.exe)
  - mtDataDir/workspaceRoot (pasta onde ficam MQL5, Logs, Tester etc.)
  - reportsDir (opcional; default `reports/` no repo)
- TestService:
  1) Gerar um ini de config com [Tester] para o Expert selecionado (EA).
  2) Executar terminal com `/config:"<ini>"`.
  3) Acompanhar execução:
     - ler logs do tester (se possível) ou pelo menos monitorar a finalização do processo.
     - coletar “últimas linhas” para mostrar no painel Output.
  4) Quando o report HTML existir, marcar `reportReady` e abrir em “Report” tab (webview/iframe controlado pelo app).
  5) Salvar artefatos do run em uma pasta `runs/<timestamp>/`:
     - ini usado
     - report.html
     - logs coletados

TERMINAL (painel inferior):
- Implementar um terminal real com xterm.js no renderer e node-pty no main.
- No Windows, default shell: powershell.exe.
- Em mac/linux, default: bash.
- Expor API via IPC para:
  - spawn session
  - write input
  - receive output
  - resize

SETTINGS UI:
- Tela/modal acessível no menu (ou botão) para configurar paths:
  - workspaceRoot
  - metaeditorPath
  - terminalPath
  - (opcional) codexPath (default “codex” no PATH)
- Persistir settings em JSON no userData.
- Validar paths (existem? executável?).

DOCS:
- README.md com:
  - instalação deps
  - como rodar dev/build
  - como configurar paths do MetaTrader
  - fluxo: abrir arquivo -> pedir mudança ao Codex -> review diff -> salvar -> compile -> run test -> abrir report

CHECKLIST:
- Crie docs/PROGRESS.md e atualize constantemente. Não finalize sem marcar os itens do MVP como concluídos.

Ordem sugerida de implementação (siga, mas ajuste se travar):
1) Scaffold Electron+Vite+React+TS (dev/build rodando).
2) Contrato IPC + preload + main básico.
3) Workspace picker + file tree + open/save.
4) Monaco editor + tabs + mql highlight.
5) Watcher + external change handling + decorations + diff view.
6) Codex sidebar UI + CodexService (rodar `codex exec`).
7) BuildService (MetaEditor compile) + Problems UI.
8) TestService (terminal /config + [Tester]) + Report viewer.
9) Terminal panel (node-pty + xterm).
10) Polimento + README + PROGRESS + scripts.

Agora execute. Faça commits pequenos por etapa. Ao final, garanta que `npm run dev` funciona e que o build não está quebrado.
