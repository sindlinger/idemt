#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROMPT_FILE="$SCRIPT_DIR/codex_prompt_cmdmt.txt"
LIB_FILE="$SCRIPT_DIR/mql5_lib.txt"

HTML_FILES=(
"/mnt/c/Users/pichau/Downloads/Files and Folders - For Advanced Users - Getting Started - MetaTrader 5 Help(1).html"
"/mnt/c/Users/pichau/Downloads/Platform Logs - For Advanced Users - Getting Started - MetaTrader 5 Help.html"
"/mnt/c/Users/pichau/Downloads/Hot Keys - For Advanced Users - Getting Started - MetaTrader 5 Help(1).html"
"/mnt/c/Users/pichau/Downloads/Platform Start - For Advanced Users - Getting Started - MetaTrader 5 Help(2).html"
"/mnt/c/Users/pichau/Downloads/Templates and Profiles - Additional Features - Price Charts, Technical and Fundamental Analysis - MetaTrader 5 Help.html"
"/mnt/c/Users/pichau/Downloads/How to Create an Expert Advisor or an Indicator - Algorithmic Trading, Trading Robots - MetaTrader 5 Help.html"
"/mnt/c/Users/pichau/Downloads/Event Handling - MQL5 Reference.html"
"/mnt/c/Users/pichau/Downloads/File Functions - MQL5 Reference.html"
)

missing=0
for f in "${HTML_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "Missing file: $f" >&2
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

cat <<'PROMPT' > "$PROMPT_FILE"
INSTRUCOES DE EXECUCAO (OBRIGATORIAS):
- Execute tudo ate concluir, sem pausar para "proximos passos".
- Nao escreva plano nem pergunte para continuar.
- Se faltar info, use defaults razoaveis e declare no final.
- Pare apenas se houver risco real de acao destrutiva nao solicitada.
- Teste sempre: rode build/teste/smoke real, corrija erros e repita ate passar.
- Consulte o servico e mantenha ele executando: verifique ping via cmdmt, tente iniciar o servico se necessario e confirme resposta.

# AGENTS.md — Codex Instructions (cmdmt / indicador / expert / tester)

## Papel
Voce e o Codex CLI agent no repositorio atual. Sua missao e profissionalizar o CLI `cmdmt` para que o usuario possa rodar comandos simples e deterministicos, com defaults claros e sem heuristica.

## Objetivo principal
Deixar defaults obrigatorios prontos para o usuario. Ele so digita TF e nome do indicador/expert. Alem disso, fazer o tester do expert funcionar.

## Tarefas obrigatorias
1) Defaults deterministas (sem heuristica)
- Fonte de verdade explicita: config, env vars ou perfil MT definido.
- Ordem de resolucao (deterministica):
  1. Argumentos explicitos no CLI
  2. Variaveis de ambiente (ex: `CMDMT_SYMBOL`, `CMDMT_PROFILE`, `CMDMT_MT5_PATH`)
  3. Config file do `cmdmt` (ex: `~/.cmdmt/config.json`)
  4. Perfil MT definido pelo usuario (id/pasta), nunca por heuristica
- Se algum default obrigatorio estiver ausente, erro claro + instrucao de como configurar.

2) UX minima para indicador e expert (defaults)
- Novo comando `indicador` (alias de `indicator attach`).
- Sintaxe minima: `indicador <TF> <NOME> [sub=N] [k=v ...]`
- Novo comando para expert no grafico: `expert run <TF> <NOME> [k=v ...]`
- Novo comando para tester do expert: `expert test <TF> <NOME> [k=v ...]`
- Todos sem SYMBOL; SYMBOL/PROFILE devem vir dos defaults acima.
- Manter compatibilidade com comandos existentes (`cmdmt indicator attach SYMBOL TF NAME ...`, `expert attach`, etc).

3) Tester do expert (Strategy Tester)
- Implementar o fluxo completo no CLI e no service, se necessario.
- Disparar Strategy Tester com EA e parametros informados (sem heuristica).
- Permitir escolher onde executar:
  - MT atual (com DLL/automacao e Strategy Tester)
  - MT especial (instancia dedicada ja prevista no codigo)
- Criar flag clara (ex: `--runner=active|special`) com fallback explicito.
- Se o MT especial falhar (download/instalacao), corrigir e registrar log claro.

4) Execucao em qualquer diretorio (WSL ou Windows)
- Garantir que `cmdmt` e `indicador` funcionem de qualquer lugar.
- Disponibilizar wrappers/shims:
  - WSL: symlink em `/usr/local/bin` ou similar.
- Nada deve depender do cwd.

5) OneShot (experts e execucao)
- Procurar no repo por `OneShot` e integrar fluxo de:
  - adicionar expert desconhecido
  - rodar aplicador
  - rodar expert em test
- Reusar comandos existentes da biblioteca, sem duplicar logica.

## Requisitos de qualidade
- CLI profissional com QCLI:
  - help/usage completos
  - mensagens de erro uteis
  - exit codes corretos
  - JSON output opcional (`--json`)
- Zero heuristica implicita; tudo deve ser configuravel e transparente.
- Testes basicos de parsing e defaults (se ja existir infra de testes).

## Validacao obrigatoria
- Sempre executar build/testes (ou smoke tests) e repetir ate passar.
- Verificar servico (socket) com `cmdmt ping` e registrar se respondeu.
- Se o servico nao responder, iniciar o bootstrap/servico indicado no repo e repetir a verificacao.

## Criterios de aceite
- `indicador M5 ZigZag` funciona com defaults explicitos.
- `expert run M5 MyEA` anexa e roda o EA no grafico.
- `expert test M5 MyEA` inicia o Strategy Tester e gera log/resultado.
- `cmdmt ping` responde.

## Estilo de entrega
- Codigo limpo, pequenas mudancas incrementais.
- Nao remover logica existente sem autorizacao.
- Atualizar docs do CLI.
PROMPT

python3 - <<'PY' > "$LIB_FILE"
from html.parser import HTMLParser
import re, html, pathlib, sys

paths = [
    r"/mnt/c/Users/pichau/Downloads/Files and Folders - For Advanced Users - Getting Started - MetaTrader 5 Help(1).html",
    r"/mnt/c/Users/pichau/Downloads/Platform Logs - For Advanced Users - Getting Started - MetaTrader 5 Help.html",
    r"/mnt/c/Users/pichau/Downloads/Hot Keys - For Advanced Users - Getting Started - MetaTrader 5 Help(1).html",
    r"/mnt/c/Users/pichau/Downloads/Platform Start - For Advanced Users - Getting Started - MetaTrader 5 Help(2).html",
    r"/mnt/c/Users/pichau/Downloads/Templates and Profiles - Additional Features - Price Charts, Technical and Fundamental Analysis - MetaTrader 5 Help.html",
    r"/mnt/c/Users/pichau/Downloads/How to Create an Expert Advisor or an Indicator - Algorithmic Trading, Trading Robots - MetaTrader 5 Help.html",
    r"/mnt/c/Users/pichau/Downloads/Event Handling - MQL5 Reference.html",
    r"/mnt/c/Users/pichau/Downloads/File Functions - MQL5 Reference.html",
]

class Extractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.out = []
        self.skip = 0
    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self.skip += 1
        elif tag in ("p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.out.append("\n")
    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            if self.skip:
                self.skip -= 1
        elif tag in ("p", "br", "div", "li", "tr"):
            self.out.append("\n")
    def handle_data(self, data):
        if self.skip:
            return
        text = data.strip()
        if text:
            self.out.append(text + " ")

def read_text(path):
    data = pathlib.Path(path).read_bytes()
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            text = None
    if text is None:
        text = data.decode("utf-8", errors="ignore")
    parser = Extractor()
    parser.feed(text)
    raw = html.unescape("".join(parser.out))
    cleaned = re.sub(r"[ \t]+", " ", raw)
    cleaned = re.sub(r"\n\s*\n+", "\n\n", cleaned)
    return cleaned.strip()

for p in paths:
    if not pathlib.Path(p).exists():
        sys.stderr.write("Missing file: %s\n" % p)
        sys.exit(1)

for p in paths:
    print("===== " + p + " =====\n")
    print(read_text(p))
    print("\n")
PY

{
  cat "$PROMPT_FILE"
  printf "\n\n# MQL5 LIBRARY (EXTRAIDO)\n\n"
  cat "$LIB_FILE"
} | codex -a never -s danger-full-access exec -C "$ROOT" --skip-git-repo-check -
