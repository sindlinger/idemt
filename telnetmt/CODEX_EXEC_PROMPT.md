Voce esta no repo /mnt/c/git/mt5ide/telnetmt. Siga AGENTS.md e implemente o desenho de config/perfis/runner para o CLI (cmdmt), alem dos novos comandos. Objetivo: tornar o CLI flexivel e robusto para multiplas instancias MT5 e testes.

Requisitos principais:
- TypeScript em tudo.
- Config JSON com defaults + profiles + runners + tester.
- Resolucao deterministica: prioridade CLI > env > config > profile (e entao defaults), com validacao clara e mensagens amigaveis.
- Paths do MetaTrader/MetaEditor/workspace sempre configuraveis pelo usuario; distinguir terminalPath vs dataPath; suportar portatil e runners especiais.
- Sem heuristicas para host; erro se host obrigatorio estiver ausente. Port/timeout podem ter default se ja existirem nos valores atuais.
- Novo comando `indicador` (alias de indicator attach com defaults).
- `expert run` e `expert test` com parsing consistente, defaults de symbol/timeframe, geracao deterministica de template/.set/.ini, e execucao em duas etapas quando necessario.
- Dispatch deve suportar acoes multi-step e "test spec".
- Geracao e coleta de logs/reports do tester; copiar logs para pasta de artefatos sob o data dir.
- Conversao de paths Win/WSL onde necessario para garantir que o terminal encontre arquivos.
- Shims `cmdmt/shims/` (shell + batch) para aliases.
- Atualizar `cmdmt/README.md` com setup, paths, fluxo completo e exemplos.
- Criar/atualizar `docs/PROGRESS.md` com checklist do MVP e marcar progresso.
- Manter `npm run dev` funcionando.
- Antes de finalizar: rodar `npm run typecheck` e `npm run build` (ou documentar excecao).

Arquivos esperados:
- `cmdmt/src/index.ts` (se necessario para novos comandos/opcoes globais)
- `cmdmt/src/lib/dispatch.ts`
- `cmdmt/src/lib/args.ts`
- `cmdmt/src/lib/help.ts`
- novos: `cmdmt/src/lib/config.ts`, `cmdmt/src/lib/tester.ts`
- `cmdmt/shims/*`
- `cmdmt/README.md`
- `docs/PROGRESS.md`

Faca mudancas pequenas e claras; se notar alteracoes inesperadas no repo, pare e peca instrucao.
