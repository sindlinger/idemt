# Settings Reference

Settings are stored in the user data directory:
- Path: `app.getPath("userData")/settings.json`

## UI tab
- **Color Mode**: light / dark
- **UI Theme**: Windows 11 / Windows Classic / macOS

## Editor tab
- **Editor Font Size**
- **Ctrl + Scroll** adjusts editor font size (auto-saved).
- **Column Guides** (toggle)
- **Cursor Position** (toggle)
- **Guide Columns**: comma-separated list (e.g. `80, 120`)

## Paths tab
- **Workspace Root**: default workspace folder
- **MetaEditor Path**: `metaeditor64.exe`
- **Terminal Path**: `terminal64.exe`
- **Codex Path**: CLI executable (default `codex` on PATH)
- **MT Data Dir**: MetaTrader data folder (contains `MQL5`, `Logs`, `Tester`)
- **Reports Dir**: output folder for HTML reports

Use **Validate** to verify that paths exist.

## Codex tab
- **Review Storage Provider**: local (userData) or Google Drive.
- **Review Max Size (MB)**: total storage budget for saved Codex changes.
- **Review Retention (days)**: delete older review bundles automatically.
- **Google Drive Credentials**: path to a service account JSON (required when Google Drive is selected).
- **Google Drive Folder ID**: folder to store review bundles (share it with the service account).
- **Extra Codex Args**: additional CLI flags to pass to Codex (space-separated)

Codex is always executed with `--skip-git-repo-check` to avoid workspace trust errors.
Codex change bundles are stored in `userData/codex-review` and can be mirrored to Google Drive if configured.

## Workspaces tab
- **Recent Workspaces**: list of recently opened workspaces.
- **Remove**: remove a single entry.
- **Clear List**: removes all entries.

Updating this list also adjusts the default `workspaceRoot` to the most recent remaining entry (if any).

## Persistence
The app also stores:
- `workspaceRoot`: last active workspace
- `recentWorkspaces`: list of open workspaces (max 4)
- `windowBounds`: last window size/position (restored on next launch)
- `layoutState` (localStorage): sidebar sizes, bottom panel height, collapsed pins

See `docs/WORKSPACES.md` for details on multi-workspace behavior.
