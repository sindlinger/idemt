# MT5 Sidecar IDE (Electron)

A lightweight Electron IDE/sidecar for MQL4/MQL5 with Monaco, file tree, Codex assistant, compile (MetaEditor CLI), and MT5 Strategy Tester runs.

## Prerequisites
- Node.js 18+
- MetaTrader 5 installed
- MetaEditor CLI and terminal paths available (from MT5 install)
- Codex CLI available on PATH (or set a custom path in Settings)

## Setup
```bash
npm install
npm run dev
```
Keep the dev terminal open while using the app (it runs Vite + Electron together).

## Build
```bash
npm run typecheck
npm run build
```

## Configure Paths (Settings)
Open **Settings** and set:
- **Workspace Root**: your MQL project folder.
- **MetaEditor Path**: e.g. `C:\Program Files\MetaTrader 5\metaeditor64.exe`
- **Terminal Path**: e.g. `C:\Program Files\MetaTrader 5\terminal64.exe`
- **MT Data Dir**: the MT5 data folder (contains `MQL5`, `Logs`, `Tester`).
- **Codex Path** (optional): defaults to `codex` on PATH.
- **Reports Dir** (optional): where HTML reports should be written.

Use **Validate** to verify the configured paths exist.
See `docs/SETTINGS.md` for the full settings reference.

## Workflow
1. **Open Workspace** from the top toolbar.
2. Click a `.mq4`, `.mq5`, or `.mqh` file to open it in Monaco.
3. Edit and **Save** (Ctrl+S) to write changes.
4. **Compile** to invoke MetaEditor CLI. Diagnostics appear in the **Problems** tab.
5. **Run Test** to launch MT5 Strategy Tester via `/config`. Output appears in **Output**, and the report renders in **Report** when ready.
6. Use the **Codex** sidebar to describe changes. Review diffs and **Accept/Revert**.

## Multi-workspace
- Open multiple workspaces; each one keeps its own tabs, tree, Codex chat, and logs.
- Workspaces are persisted and restored on startup (last open list, capped at 4).
- Tabs are restored per workspace on startup (missing files are skipped).
- Use the top-bar chips to switch or close workspaces.

See `docs/WORKSPACES.md` for details.
See `docs/ARCHITECTURE.md` for a process + state overview.

## Notes
- Codex runs use evidence-first context (active file, recent diagnostics, recent logs, and nearby files).
- Test runs store artifacts in `runs/<timestamp>/` (ini, report, tester log).
- Codex logs are stored in `logs/codex/` and build logs in `logs/build/`.

## Troubleshooting (WSL + X410)
- Ensure the X server is running and `DISPLAY` is set (ex: `192.168.64.1:0`).
- If the window opens and closes quickly, keep `npm run dev` running in a terminal.
- GPU/ANGLE issues are mitigated by disabling hardware acceleration in WSL.

## Shortcuts
- **Ctrl+S**: Save
- **Ctrl+J**: Toggle bottom panel
