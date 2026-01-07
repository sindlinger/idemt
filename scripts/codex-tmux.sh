#!/usr/bin/env bash
set -euo pipefail

# Codex interactive + log mirror + resizable log pane (tmux).
# Usage:
#   CODEX_LOG_PATH=/path/to/log.txt CODEX_CMD=codex ./scripts/codex-tmux.sh
# Mirror mode (simulated "transparent" view of main pane):
#   CODEX_LOG_MODE=mirror CODEX_MIRROR_W=50 CODEX_MIRROR_H=20 ./scripts/codex-tmux.sh
# Deep mode (tagged input/output + colorized log pane):
#   CODEX_LOG_MODE=deep ./scripts/codex-tmux.sh

SESSION_NAME=${CODEX_SESSION_NAME:-codex}
CODEX_CMD=${CODEX_CMD:-codex}
LOG_PATH=${CODEX_LOG_PATH:-/mnt/c/Users/pichau/AppData/Roaming/mt5ide/logs/codex-live.txt}
LOG_W=${CODEX_LOG_W:-80}
LOG_H=${CODEX_LOG_H:-24}
LOG_TITLE=${CODEX_LOG_TITLE:-LOG}
LOG_MODE=${CODEX_LOG_MODE:-tail}
MIRROR_X=${CODEX_MIRROR_X:-0}
MIRROR_Y=${CODEX_MIRROR_Y:-0}
MIRROR_W=${CODEX_MIRROR_W:-$LOG_W}
MIRROR_H=${CODEX_MIRROR_H:-$LOG_H}
MIRROR_INTERVAL=${CODEX_MIRROR_INTERVAL:-0.1}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required. Install it first." >&2
  exit 1
fi

if [ "$LOG_MODE" != "deep" ]; then
  if ! command -v script >/dev/null 2>&1; then
    echo "script(1) is required (util-linux). Install it first." >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$LOG_PATH")"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux attach -t "$SESSION_NAME"
  exit 0
fi

START_LINE=$((MIRROR_Y + 1))
END_LINE=$((MIRROR_Y + MIRROR_H))
START_COL=$((MIRROR_X + 1))
END_COL=$((MIRROR_X + MIRROR_W))

LOG_RUNNER="$(mktemp -t codex-log-XXXXXX.sh)"
cat >"$LOG_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
MODE="${LOG_MODE}"
LOG_PATH="${LOG_PATH}"
SESSION_NAME="${SESSION_NAME}"
START_LINE="${START_LINE}"
END_LINE="${END_LINE}"
START_COL="${START_COL}"
END_COL="${END_COL}"
INTERVAL="${MIRROR_INTERVAL}"

BASE_INDEX=$(tmux show -gv base-index 2>/dev/null || echo 0)
SESSION="${SESSION_NAME}:${BASE_INDEX}.0"

if [ "\$MODE" = "mirror" ]; then
  tput civis
  trap 'tput cnorm; exit' INT TERM
  while true; do
    tput cup 0 0
    tput ed
    tmux capture-pane -pt "\$SESSION" -J | sed -n "\${START_LINE},\${END_LINE}p" | cut -c "\${START_COL}-\${END_COL}"
    sleep "\$INTERVAL"
  done
elif [ "\$MODE" = "deep" ]; then
  exec tail -f "\$LOG_PATH" | awk '
    /\\] SYS / { printf(\"\\033[38;5;244m%s\\033[0m\\n\", \$0); next }
    /\\] IN / { printf(\"\\033[38;5;75m%s\\033[0m\\n\", \$0); next }
    /\\] OUT / { printf(\"\\033[38;5;214m%s\\033[0m\\n\", \$0); next }
    /ERROR|Error|error/ { printf(\"\\033[38;5;196m%s\\033[0m\\n\", \$0); next }
    { print \$0 }
  '
else
  exec tail -f "\$LOG_PATH"
fi
EOF
chmod +x "$LOG_RUNNER"
LOG_CMD="bash $LOG_RUNNER"

# Start Codex in an interactive PTY with log mirroring.
if [ "$LOG_MODE" = "deep" ]; then
  CODEX_RUN="CODEX_LOG_PATH=\"$LOG_PATH\" CODEX_CMD=\"$CODEX_CMD\" python3 \"$SCRIPT_DIR/codex-pty-log.py\""
else
  CODEX_RUN="script -q -f -a \"$LOG_PATH\" -c \"$CODEX_CMD\""
fi

tmux new-session -d -s "$SESSION_NAME" -n main "bash"
BASE_INDEX=$(tmux show -gv base-index 2>/dev/null || echo 0)
WIN_TARGET="$SESSION_NAME:$BASE_INDEX"
tmux send-keys -t "$WIN_TARGET" "$CODEX_RUN" C-m
tmux set -g mouse on

# Split bottom area for logs, then split right to keep it compact.
tmux split-window -v -l "$LOG_H" -t "$WIN_TARGET"
tmux split-window -h -l "$LOG_W" -t "$WIN_TARGET.1" "$LOG_CMD"
tmux select-pane -t "$WIN_TARGET.2" -T "$LOG_TITLE"
tmux select-pane -t "$WIN_TARGET.0"

# Toggle log pane with prefix + L (keeps log file alive).
tmux bind-key -T prefix L run-shell "pane=\$(tmux list-panes -t $WIN_TARGET -F '#{pane_id} #{pane_title}' | awk '\$2==\"$LOG_TITLE\"{print \$1}'); if [ -n \"\$pane\" ]; then tmux kill-pane -t \"\$pane\"; else tmux split-window -h -l $LOG_W -t $WIN_TARGET.1 \"$LOG_CMD\"; tmux select-pane -t $WIN_TARGET.2 -T $LOG_TITLE; tmux select-pane -t $WIN_TARGET.0; fi"

tmux attach -t "$SESSION_NAME"
