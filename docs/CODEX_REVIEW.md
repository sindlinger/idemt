# Codex Review Storage

This app keeps a local, reversible history of Codex-applied changes.

## Where it is stored
The review bundles are saved here:

```
app.getPath("userData")/codex-review
```

Typical Windows path (when launched from WSL using our dev script):

```
%LOCALAPPDATA%\\mt5ide-win\\codex-review
```

If you launch the packaged app directly on Windows, it will normally be:

```
%APPDATA%\\mt5ide\\codex-review
```

## What is saved
Each bundle includes:
- file path
- before/after content
- source ("codex")
- timestamp

## Limits & retention
Settings -> Codex:
- **Review Max Size (MB)**: total budget for all bundles.
- **Review Retention (days)**: older bundles are deleted first.

## Google Drive (optional)
If you select Google Drive:
1) Create a **service account** (new Google Cloud project recommended).
2) Download the JSON key.
3) Create a Drive folder and **share** it with the service account email.
4) In Settings -> Codex, fill:
   - **Google Drive Credentials**: path to the JSON key
   - **Google Drive Folder ID**: the folder ID from the URL

If credentials are missing, the app continues saving locally.
