# Progress

## MVP Checklist
- [x] Scaffold Electron + Vite + React + TypeScript with main/preload/renderer structure
- [x] IPC contract in `src/shared/ipc.ts`
- [x] Settings persistence + validation UI
- [x] Workspace picker and file tree
- [x] Monaco editor with tabs, MQL language + dirty state
- [x] File watcher with external change handling + diff + line highlights
- [x] Codex sidebar with streaming timeline + review accept/revert
- [x] Build (MetaEditor CLI) + Problems panel
- [x] Tester (MT5 /config) + logs + report viewer
- [x] Bottom panel (Terminal, Problems, Output, Report) with Ctrl+J toggle
- [x] README with setup, config, compile, test, Codex flow

## Notes
- Evidence-first: build/test panels rely on actual logs and report files when available.
