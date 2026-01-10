# MetaTrader Sidecar IDE (Electron) - Instrucoes para agentes

## Objetivo
Construir um aplicativo Electron que funcione como IDE/sidecar para MQL4/MQL5 com:
- Monaco Editor (abas, numeracao, highlight MQL).
- Sidebar de arvore de arquivos do workspace.
- Painel inferior (toggle Ctrl+J): Terminal (xterm), Problems (diagnosticos), Output/Logs.
- Sidebar do Codex (chat + timeline), com aplicacao de mudancas por diff e destaque de linhas alteradas.
- Compile via MetaEditor CLI (caminho configuravel) + parsing para Problems clicaveis.
- Run Test (MT5 Strategy Tester) via terminal /config + [Tester] ini, com coleta de logs e report HTML.

## Regras obrigatorias
- TypeScript em tudo.
- Renderer com ContextIsolation ON e NodeIntegration OFF.
- IPC somente via preload (expor `window.api` com funcoes e eventos).
- Nada de hooking/injecao/"embed" do MetaEditor/MetaTrader dentro do app.
- "Evidence-first": decisoes do agente devem ser baseadas em logs/diagnosticos/report reais.
- Paths do MetaTrader (terminal/metaeditor/workspace) sempre configuraveis pelo usuario (UI de Settings).

## Stack sugerida (pode ajustar se justificar)
- Electron + Vite + React + TypeScript.
- Zustand (ou equivalente) para estado.
- Monaco via `monaco-editor` (ou wrapper React).
- xterm.js para terminal.
- chokidar para watcher.
- Persistencia de config em JSON no `app.getPath("userData")` (ou `electron-store`, se preferir).

## Qualidade e entrega
- Commits pequenos e frequentes.
- Criar `docs/PROGRESS.md` com checklist e ir marcando conforme implementa.
- Sempre deixar `npm run dev` funcionando.
- Antes de concluir: `npm run typecheck` e `npm run build` devem passar (ou documentar a excecao).

## MVP - Definicao de pronto
1) Abrir workspace (selecionar pasta) e listar arvore de arquivos.
2) Abrir arquivos em abas no Monaco, editar, salvar, e indicar "dirty".
3) Sidebar Codex: enviar prompt, receber streaming, exibir timeline e resultado final.
4) Quando o Codex alterar arquivos, o editor reflete em tempo real e mostra diff + opcoes Accept/Revert.
5) Botao Compile: chama MetaEditor CLI, parseia log, mostra Problems clicaveis.
6) Botao Run Test (EA): gera ini do tester, executa terminal com /config, acompanha logs e abre report HTML.
7) README com setup, configuracao de paths e fluxo completo.

## Skills
These skills are discovered at startup from multiple local sources. Each entry includes a name, description, and file path so you can open the source for full instructions.
- cli-node-ts-pro: Professional Node.js + TypeScript CLI creation and refactor skill. Use for building, structuring, or professionalizing CLIs in Node/TS: command design, flags and help text, errors and exit codes, JSON output, config layering, prompts, logging, tests, and npm packaging. (file: /home/chanfle/.codex/skills/cli-node-ts-pro/SKILL.md)
- gh-address-comments: Help address review/issue comments on the open GitHub PR for the current branch using gh CLI; verify gh auth first and prompt the user to authenticate if not logged in. (file: /home/chanfle/.codex/skills/gh-address-comments/SKILL.md)
- gh-fix-ci: Inspect GitHub PR checks with gh, pull failing GitHub Actions logs, summarize failure context, then create a fix plan and implement after user approval. Use when a user asks to debug or fix failing PR CI/CD checks on GitHub Actions and wants a plan + code changes; for external checks (e.g., Buildkite), only report the details URL and mark them out of scope. (file: /home/chanfle/.codex/skills/gh-fix-ci/SKILL.md)
- github-finance-frequency-cpp: Integrar repositorios GitHub de C/C++ para analise de frequencia no mercado financeiro (FFT, STFT, wavelets, PSD, Lomb-Scargle), incluindo selecao de repositorio, checagem de licenca/dependencias, estrategia de vendor ou submodule e atualizacao de build (Makefile/CMake), com wrapper e exemplo/teste. Priorizar implementar dentro do repositorio atual mantendo estrutura e build existentes; evitar criar projetos paralelos ou refatoracoes amplas sem pedido explicito. Use quando o usuario pedir para importar ou avaliar repositorios GitHub para analise de frequencia em projetos C/C++ financeiros (especialmente este repo LAWA-lite/FLENS-lite). (file: /home/chanfle/.codex/skills/github-finance-frequency-cpp/SKILL.md)
- mql5-cupy-gpu-bridge: Integrate MQL5 indicators/EAs with Python + CuPy GPU via TCP sockets or WebSockets, including MT5 Python API setup and data exchange patterns. (file: /home/chanfle/.codex/skills/mql5-cupy-gpu-bridge/SKILL.md)
- mql5-modular-architecture: Modularizar e refatorar indicadores/Experts MQL5 (MetaTrader 5) em arquitetura orientada a objetos e modulos .mqh, separando calculo de visualizacao, centralizando pipelines e gerindo estado de subjanela/overlay. Use quando o usuario pedir organizacao de projetos MQL5, criacao de classes/modulos reutilizaveis (ex.: clock, wave, fase, magnitude), ou quando fornecer apenas parte do codigo e precisar de um Project Map para contexto. (file: /home/chanfle/.codex/skills/mql5-modular-architecture/SKILL.md)
- notion-knowledge-capture: Capture conversations and decisions into structured Notion pages; use when turning chats/notes into wiki entries, how-tos, decisions, or FAQs with proper linking. (file: /home/chanfle/.codex/skills/notion-knowledge-capture/SKILL.md)
- notion-meeting-intelligence: Prepare meeting materials with Notion context and Codex research; use when gathering context, drafting agendas/pre-reads, and tailoring materials to attendees. (file: /home/chanfle/.codex/skills/notion-meeting-intelligence/SKILL.md)
- notion-research-documentation: Research across Notion and synthesize into structured documentation; use when gathering info from multiple Notion sources to produce briefs, comparisons, or reports with citations. (file: /home/chanfle/.codex/skills/notion-research-documentation/SKILL.md)
- notion-spec-to-implementation: Turn Notion specs into implementation plans, tasks, and progress tracking; use when implementing PRDs/feature specs and creating Notion plans + tasks from them. (file: /home/chanfle/.codex/skills/notion-spec-to-implementation/SKILL.md)
- skill-creator: Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Codex's capabilities with specialized knowledge, workflows, or tool integrations. (file: /home/chanfle/.codex/skills/.system/skill-creator/SKILL.md)
- skill-installer: Install Codex skills into $CODEX_HOME/skills from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo (including private repos). (file: /home/chanfle/.codex/skills/.system/skill-installer/SKILL.md)
- Discovery: Available skills are listed in project docs and may also appear in a runtime "## Skills" section (name + description + file path). These are the sources of truth; skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.
  2) If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request; don't bulk-load everything.
  3) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.
  4) If `assets/` or templates exist, reuse them instead of recreating from scratch.
- Description as trigger: The YAML `description` in `SKILL.md` is the primary trigger signal; rely on it to decide applicability. If unsure, ask a brief clarification before proceeding.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deeply nested references; prefer one-hop files explicitly linked from `SKILL.md`.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.

## Exec prompt
- Use `CODEX_EXEC_PROMPT.md` for non-interactive runs.
