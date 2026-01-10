#!/usr/bin/env bash
set -euo pipefail

SANDBOX_WIN="C:\\mql\\mt5-sandbox\\terminal"
SANDBOX_WSL="/mnt/c/mql/mt5-sandbox/terminal"
DEFAULT_CMD=("cmdmt" "--runner" "sandbox" "expert" "test" "M5" "DukaEA")

TIMEOUT_SEC="${MT5_SANDBOX_TIMEOUT_SEC:-300}"
POLL_SEC="${MT5_SANDBOX_POLL_SEC:-2}"

if [[ "${1-}" == "--help" || "${1-}" == "-h" ]]; then
  cat <<'EOF'
Uso:
  tools/mt5-sandbox-sync.sh [--timeout SEC] [--poll SEC] [--] [cmdmt args...]

Exemplos:
  tools/mt5-sandbox-sync.sh
  tools/mt5-sandbox-sync.sh -- --runner sandbox expert test M5 DukaEA
  MT5_SANDBOX_TIMEOUT_SEC=600 tools/mt5-sandbox-sync.sh
EOF
  exit 0
fi

while [[ "${1-}" == "--timeout" || "${1-}" == "--poll" ]]; do
  case "$1" in
    --timeout) TIMEOUT_SEC="$2"; shift 2;;
    --poll) POLL_SEC="$2"; shift 2;;
  esac
done

CMDMT_ARGS=("${DEFAULT_CMD[@]}")
if [[ "${1-}" == "--" ]]; then
  shift
  if [[ "$#" -gt 0 ]]; then
    CMDMT_ARGS=("$@")
  fi
fi

LOG_FILE="$(date +%Y%m%d).log"
LOG_PATH="$SANDBOX_WSL/MQL5/Logs/$LOG_FILE"

echo "[sandbox] Iniciando MT5 portable..."
powershell.exe -NoProfile -Command \
  "Start-Process -FilePath '${SANDBOX_WIN}\\\\terminal64.exe' -ArgumentList '/portable' | Out-Null"

start_ts="$(date +%s)"
found=0
while true; do
  now_ts="$(date +%s)"
  if (( now_ts - start_ts > TIMEOUT_SEC )); then
    echo "[sandbox] Timeout aguardando login ($TIMEOUT_SEC s)."
    break
  fi
  if [[ -f "$LOG_PATH" ]]; then
    python3 - <<PY
from pathlib import Path
p=Path("$LOG_PATH")
raw=p.read_bytes()
text=raw.decode("utf-16", errors="ignore") if raw.startswith(b"\xff\xfe") else raw.decode("utf-8", errors="ignore")
ok = ("authorized on Dukascopy-demo-mt5-1" in text.lower()) or ("authorization on dukascopy-demo-mt5-1" in text.lower())
print("OK" if ok else "")
PY
    if grep -q "OK" <<<"$(tail -n 1 <(python3 - <<PY
from pathlib import Path
p=Path("$LOG_PATH")
raw=p.read_bytes()
text=raw.decode("utf-16", errors="ignore") if raw.startswith(b"\xff\xfe") else raw.decode("utf-8", errors="ignore")
ok = ("authorized on dukascopy-demo-mt5-1" in text.lower()) or ("authorization on dukascopy-demo-mt5-1" in text.lower())
print("OK" if ok else "")
PY
))"; then
      found=1
      echo "[sandbox] Login confirmado no log."
      break
    fi
  fi
  sleep "$POLL_SEC"
done

echo "[sandbox] Encerrando MT5 sandbox..."
powershell.exe -NoProfile -Command \
  "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'terminal64.exe' -and \$_.CommandLine -like '*C:\\\\mql\\\\mt5-sandbox\\\\terminal*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"

echo "[sandbox] Rodando cmdmt..."
"${CMDMT_ARGS[@]}"

if (( found == 0 )); then
  echo "[sandbox] Aviso: login não confirmado no log. Verifique $LOG_PATH"
fi
