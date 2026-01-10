#!/usr/bin/env bash
set -euo pipefail

BIN="/mnt/c/git/mt5ide/services/telnetmt/tools"
PROFILE="${HOME}/.bashrc"

if [ ! -d "$BIN" ]; then
  echo "Path not found: $BIN" >&2
  exit 1
fi

if ! grep -q "$BIN" "$PROFILE" 2>/dev/null; then
  echo "" >> "$PROFILE"
  echo "# mt5ide: add mt5-compile.exe tools to PATH" >> "$PROFILE"
  echo "export PATH=\"${BIN}:\$PATH\"" >> "$PROFILE"
  echo "Added to $PROFILE"
else
  echo "Already in $PROFILE"
fi

export PATH="${BIN}:$PATH"
echo "PATH updated for current shell."
