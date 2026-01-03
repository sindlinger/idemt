# Multi-workspace Sessions

This app supports multiple workspaces open at the same time (3–4 recommended). Each workspace has its own isolated session state.

## What is isolated per workspace
- File tree (root + expanded nodes)
- Open tabs and active file
- Codex chat + timeline + session toggle
- Problems, Output logs, and Test report
- Review changes (diffs)

When you click a workspace chip in the top bar, the UI switches to that workspace’s state.

## Persistence (last-opened list)
The last opened workspaces are stored in the app settings file:

- File: `app.getPath("userData")/settings.json`
- Keys:
  - `workspaceRoot`: the last active workspace
  - `recentWorkspaces`: ordered list of open workspaces (last item is most recent)

On startup, the app reopens **only** the workspaces from `recentWorkspaces`.

## Persisted tabs
Each workspace stores its open file list and active file in local storage. When a workspace is reopened, its tabs are restored automatically.
If a file no longer exists, it is skipped.

## Persisted tree state
The expanded/collapsed tree state is stored per workspace and restored on startup.

## Limits
- The list is capped at **4** workspaces.
- When a 5th workspace is opened, the oldest one is dropped.

## Close a workspace
- Click the **×** on the workspace chip in the top bar.
- If you close the active workspace, the app automatically activates the most recent remaining workspace.

## How activation works
- Clicking a chip calls `workspace:activate` to switch the backend root.
- The file tree is rebuilt for that root.
- Only the active workspace has active file watchers.

## Resetting the list
To reset the workspace list manually:
1. Close the app.
2. Edit `settings.json` in the userData directory.
3. Clear or replace `recentWorkspaces`.

Example:
```
"recentWorkspaces": [
  "C:\\Users\\you\\AppData\\Roaming\\MetaQuotes\\Terminal\\ABCDEF123456\\MQL5",
  "D:\\Projects\\MyEA"
]
```

## Notes for future expansion
- The state container is modularized per workspace (`WorkspaceSession`) to keep features isolated and easier to extend.
- Add new per-workspace state inside `WorkspaceSession` instead of global state.
