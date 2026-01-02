# MetaTrader Sidecar IDE (Electron) — Instruções para agentes

## Objetivo
Construir um aplicativo Electron que funcione como IDE/sidecar para MQL4/MQL5 com:
- Monaco Editor (abas, numeração, highlight MQL).
- Sidebar de árvore de arquivos do workspace.
- Painel inferior (toggle Ctrl+J): Terminal (xterm), Problems (diagnósticos), Output/Logs.
- Sidebar do Codex (chat + timeline), com aplicação de mudanças por diff e destaque de linhas alteradas.
- Compile via MetaEditor CLI (caminho configurável) + parsing para Problems clicáveis.
- Run Test (MT5 Strategy Tester) via terminal /config + [Tester] ini, com coleta de logs e report HTML.

## Regras obrigatórias
- TypeScript em tudo.
- Renderer com ContextIsolation ON e NodeIntegration OFF.
- IPC somente via preload (expor `window.api` com funções e eventos).
- Nada de hooking/injeção/“embed” do MetaEditor/MetaTrader dentro do app.
- “Evidence-first”: decisões do agente devem ser baseadas em logs/diagnósticos/report reais.
- Paths do MetaTrader (terminal/metaeditor/workspace) sempre configuráveis pelo usuário (UI de Settings).

## Stack sugerida (pode ajustar se justificar)
- Electron + Vite + React + TypeScript.
- Zustand (ou equivalente) para estado.
- Monaco via `monaco-editor` (ou wrapper React).
- xterm.js para terminal.
- chokidar para watcher.
- Persistência de config em JSON no `app.getPath("userData")` (ou `electron-store`, se preferir).

## Qualidade e entrega
- Commits pequenos e frequentes.
- Criar `docs/PROGRESS.md` com checklist e ir marcando conforme implementa.
- Sempre deixar `npm run dev` funcionando.
- Antes de concluir: `npm run typecheck` e `npm run build` devem passar (ou documentar a exceção).

## MVP — Definição de pronto
1) Abrir workspace (selecionar pasta) e listar árvore de arquivos.
2) Abrir arquivos em abas no Monaco, editar, salvar, e indicar “dirty”.
3) Sidebar Codex: enviar prompt, receber streaming, exibir timeline e resultado final.
4) Quando o Codex alterar arquivos, o editor reflete em tempo real e mostra diff + opções Accept/Revert.
5) Botão Compile: chama MetaEditor CLI, parseia log, mostra Problems clicáveis.
6) Botão Run Test (EA): gera ini do tester, executa terminal com /config, acompanha logs e abre report HTML.
7) README com setup, configuração de paths e fluxo completo.

