# Codex Review Storage Setup

You are configuring Codex review storage for MT5 Sidecar IDE.

Please follow these steps and confirm each step with "OK" before moving on:

1) Open Settings -> Codex.
2) Confirm that "Review Storage Provider" is set to "Local (userData)".
3) Set:
   - Review Max Size (MB): 200
   - Review Retention (days): 14
4) Trigger a Codex change (edit any file using Codex).
5) Verify that a new file appears in:
   - app.getPath("userData")/codex-review

If Google Drive is required:
6) Create a NEW Google Cloud project and a Service Account.
7) Download the Service Account JSON.
8) Create a Google Drive folder and share it with the service account email.
9) In Settings -> Codex, set:
   - Review Storage Provider: Google Drive
   - Google Drive Credentials: <path-to-json>
   - Google Drive Folder ID: <folder-id>
10) Trigger another Codex change and confirm a new file appears in the Drive folder.

If any step fails, stop and report the exact error message and the full path used.
