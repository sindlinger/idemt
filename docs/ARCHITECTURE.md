# Architecture Overview

## Process boundaries
- **Main**: Electron main process, owns filesystem access, CLI execution, and watchers.
- **Preload**: the only IPC surface; exposes `window.api` to the renderer.
- **Renderer**: React UI, Monaco, and per-workspace session state.

## IPC contract
All IPC channels and shared types live in `src/shared/ipc.ts`.
Only preload exposes the API to the renderer (ContextIsolation ON, NodeIntegration OFF).

## Workspace model
- Each workspace is identified by its root path.
- The UI keeps a **WorkspaceSession** per root with isolated state:
  - tree, tabs, active file, diagnostics, Codex chat, logs, report, diff review
- Switching workspaces swaps the active session.

## Persistence
- `settings.json` (userData): user settings + `recentWorkspaces` list (max 4)
- `localStorage` (renderer): per-workspace open tab list + active file

## Services (main)
Services live in `src/main/services/` and are grouped by domain:
- `workspace/WorkspaceService`: filesystem traversal, file IO, watchers, file tree
- `codex/CodexService`: runs Codex CLI and emits file-change diffs
- `codex/CodexSessionService`: interactive Codex session lifecycle
- `build/BuildService`: MetaEditor CLI compile + diagnostics parsing
- `test/TestService`: MT5 tester run + report handling
- `logging/LogsService`: shared log stream to UI

## UI layout
- Top bar: title + workspace chips + toolbar
- Left sidebar: file tree and filters
- Center: Monaco + tabs
- Right sidebar: Codex chat/timeline
- Bottom panel: Terminal / Problems / Output / Report

## Renderer structure
Renderer UI is split by domain under `src/renderer/`:
- `app/` (top bar + app shell)
- `workspace/` (file tree, workspace header)
- `editor/` (Monaco + tabs)
- `codex/` (Codex sidebar + terminal view)
- `panels/` (Bottom panel + sub-panels)
- `settings/` (Settings modal)
- `styles/` (`app.css`)

## Evidence-first
Build, test, and Codex results are always based on real output/logs and displayed as-is.
