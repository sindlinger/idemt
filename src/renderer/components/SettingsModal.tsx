import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FolderOpen, Save, Trash2 } from "lucide-react";
import type { Settings } from "@shared/ipc";

const SettingsModal = ({
  open,
  settings,
  onClose,
  onSave
}: {
  open: boolean;
  settings: Settings;
  onClose: () => void;
  onSave: (settings: Settings) => void;
}) => {
  const [local, setLocal] = useState<Settings>(settings);
  const [validation, setValidation] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<"ui" | "editor" | "paths" | "codex" | "workspaces">(
    "ui"
  );
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const isWindows = window.api?.platform === "win32";
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(
    null
  );

  useEffect(() => {
    setLocal(settings);
    setValidation({});
  }, [settings]);

  if (!open) return null;

  const beginDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y
    };
    const handleMove = (moveEvent: MouseEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const nextX = current.originX + (moveEvent.clientX - current.startX);
      const nextY = current.originY + (moveEvent.clientY - current.startY);
      setPosition({ x: nextX, y: nextY });
    };
    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const updateField = (key: keyof Settings, value: string | number) => {
    setLocal((prev) => ({ ...prev, [key]: value }));
  };

  const updateNumberField = (key: keyof Settings, value: string) => {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) return;
    setLocal((prev) => ({ ...prev, [key]: parsed }));
  };

  const updateBooleanField = (key: keyof Settings, value: boolean) => {
    setLocal((prev) => ({ ...prev, [key]: value }));
  };

  const updateRulersField = (value: string) => {
    const parsed = value
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((num) => Number.isFinite(num) && num > 0);
    setLocal((prev) => ({ ...prev, editorRulers: parsed }));
  };

  const updateRecentWorkspaces = (list: string[]) => {
    const next = list.filter(Boolean);
    const nextRoot = next.includes(local.workspaceRoot ?? "")
      ? local.workspaceRoot
      : next[next.length - 1] ?? "";
    setLocal((prev) => ({ ...prev, recentWorkspaces: next, workspaceRoot: nextRoot }));
  };

  const browse = async (key: keyof Settings, type: "file" | "directory") => {
    const title = `Select ${String(key)}`;
    if (typeof window.api?.selectPath !== "function") return;
    const result = await window.api.selectPath({ type, title });
    if (result) updateField(key, result);
  };

  const handleValidate = async () => {
    if (typeof window.api?.settingsValidate !== "function") return;
    const result = await window.api.settingsValidate(local);
    setValidation(result);
  };

  return (
    <div className="settings-modal" onClick={onClose}>
      <div
        className="settings-card"
        style={{
          left: "50%",
          top: "50%",
          transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px)`
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 onMouseDown={beginDrag}>Settings</h2>
        <div className="settings-tabs">
          <button
            className={`settings-tab ${activeTab === "ui" ? "active" : ""}`}
            onClick={() => setActiveTab("ui")}
          >
            UI
          </button>
          <button
            className={`settings-tab ${activeTab === "editor" ? "active" : ""}`}
            onClick={() => setActiveTab("editor")}
          >
            Editor
          </button>
          <button
            className={`settings-tab ${activeTab === "paths" ? "active" : ""}`}
            onClick={() => setActiveTab("paths")}
          >
            Paths
          </button>
          <button
            className={`settings-tab ${activeTab === "codex" ? "active" : ""}`}
            onClick={() => setActiveTab("codex")}
          >
            Codex
          </button>
          <button
            className={`settings-tab ${activeTab === "workspaces" ? "active" : ""}`}
            onClick={() => setActiveTab("workspaces")}
          >
            Workspaces
          </button>
        </div>
        <div className="settings-section">
          {activeTab === "ui" ? (
            <>
              <div className="settings-field">
                <label>Color Mode</label>
                <select
                  value={local.uiMode ?? "dark"}
                  onChange={(event) => updateField("uiMode", event.target.value)}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </div>
              <div className="settings-field">
                <label>UI Theme</label>
                <select
                  value={local.uiTheme ?? "windows11"}
                  onChange={(event) => updateField("uiTheme", event.target.value)}
                >
                  <option value="windows11">Windows 11</option>
                  <option value="windowsClassic">Windows Classic</option>
                  <option value="macos">macOS</option>
                  <option value="metatrader">MetaTrader</option>
                </select>
              </div>
            </>
          ) : null}
          {activeTab === "editor" ? (
            <>
              <div className="settings-field">
                <label>Editor Font Size</label>
                <input
                  type="number"
                  min={10}
                  max={22}
                  value={local.editorFontSize ?? 13}
                  onChange={(event) => updateNumberField("editorFontSize", event.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Column Guides</label>
                <input
                  type="checkbox"
                  checked={local.editorShowRulers ?? false}
                  onChange={(event) => updateBooleanField("editorShowRulers", event.target.checked)}
                />
              </div>
              <div className="settings-field">
                <label>Cursor Position</label>
                <input
                  type="checkbox"
                  checked={local.editorShowCursorPosition ?? false}
                  onChange={(event) => updateBooleanField("editorShowCursorPosition", event.target.checked)}
                />
              </div>
              <div className="settings-field">
                <label>Guide Columns (comma-separated)</label>
                <input
                  value={(local.editorRulers ?? [80, 120]).join(", ")}
                  onChange={(event) => updateRulersField(event.target.value)}
                />
              </div>
            </>
          ) : null}
          {activeTab === "paths" ? (
            <>
              {(
                [
                  { key: "workspaceRoot", label: "Workspace Root", type: "directory" },
                  { key: "metaeditorPath", label: "MetaEditor Path", type: "file" },
                  { key: "terminalPath", label: "Terminal Path", type: "file" },
                  { key: "codexPath", label: "Codex Path", type: "file" },
                  { key: "mtDataDir", label: "MT Data Dir", type: "directory" },
                  { key: "reportsDir", label: "Reports Dir", type: "directory" }
                ] as const
              ).map((field) => (
                <div className="settings-field" key={field.key}>
                  <label>{field.label}</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={local[field.key] ?? ""}
                      onChange={(event) => updateField(field.key, event.target.value)}
                    />
                    <button
                      className="button"
                      type="button"
                      onClick={() => browse(field.key, field.type)}
                    >
                      <FolderOpen size={12} />
                      Browse
                    </button>
                  </div>
                  {validation[field.key] === false ? (
                    <span style={{ color: "var(--danger)", fontSize: 12 }}>Path not found.</span>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
          {activeTab === "codex" ? (
            <>
              {isWindows ? (
                <div className="settings-field">
                  <label>Codex Runtime</label>
                  <select
                    value={local.codexRunTarget ?? "windows"}
                    onChange={(event) => updateField("codexRunTarget", event.target.value)}
                  >
                    <option value="windows">Windows</option>
                    <option value="wsl">WSL</option>
                  </select>
                </div>
              ) : null}
              {isWindows ? (
                <div className="settings-field">
                  <label>Codex Path (WSL)</label>
                  <input
                    value={local.codexPathWsl ?? ""}
                    onChange={(event) => updateField("codexPathWsl", event.target.value)}
                    placeholder="codex"
                  />
                  <span style={{ color: "var(--muted)", fontSize: 11 }}>
                    Leave empty to use Codex from WSL PATH.
                  </span>
                </div>
              ) : null}
              <div className="settings-field">
                <label>Review Storage Provider</label>
                <select
                  value={local.codexReviewProvider ?? "local"}
                  onChange={(event) => updateField("codexReviewProvider", event.target.value)}
                >
                  <option value="local">Local (userData)</option>
                  <option value="googleDrive">Google Drive</option>
                </select>
              </div>
              <div className="settings-field">
                <label>Review Max Size (MB)</label>
                <input
                  type="number"
                  min={10}
                  max={2048}
                  value={local.codexReviewMaxMb ?? 200}
                  onChange={(event) => updateNumberField("codexReviewMaxMb", event.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Review Retention (days)</label>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={local.codexReviewKeepDays ?? 14}
                  onChange={(event) => updateNumberField("codexReviewKeepDays", event.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Extra Codex Args (space-separated)</label>
                <input
                  value={local.codexArgs ?? ""}
                  onChange={(event) => updateField("codexArgs", event.target.value)}
                />
                <span style={{ color: "var(--muted)", fontSize: 11 }}>
                  Example: --model gpt-5 --max-tokens 2048
                </span>
              </div>
              {isWindows ? (
                <>
                  <div className="settings-field">
                    <label>Extra Codex Args (Windows)</label>
                    <input
                      value={local.codexArgsWindows ?? ""}
                      onChange={(event) => updateField("codexArgsWindows", event.target.value)}
                    />
                  </div>
                  <div className="settings-field">
                    <label>Extra Codex Args (WSL)</label>
                    <input
                      value={local.codexArgsWsl ?? ""}
                      onChange={(event) => updateField("codexArgsWsl", event.target.value)}
                    />
                  </div>
                </>
              ) : null}
              {local.codexReviewProvider === "googleDrive" ? (
                <>
                  <div className="settings-field">
                    <label>Google Drive Credentials (JSON)</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        value={local.codexReviewGoogleCredentials ?? ""}
                        onChange={(event) =>
                          updateField("codexReviewGoogleCredentials", event.target.value)
                        }
                      />
                      <button
                        className="button"
                        type="button"
                        onClick={() => browse("codexReviewGoogleCredentials", "file")}
                      >
                        <FolderOpen size={12} />
                        Browse
                      </button>
                    </div>
                  </div>
                  <div className="settings-field">
                    <label>Google Drive Folder ID</label>
                    <input
                      value={local.codexReviewGoogleFolderId ?? ""}
                      onChange={(event) =>
                        updateField("codexReviewGoogleFolderId", event.target.value)
                      }
                    />
                    <span style={{ color: "var(--muted)", fontSize: 11 }}>
                      Share the folder with the service account email.
                    </span>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
          {activeTab === "workspaces" ? (
            <>
              <div className="settings-field">
                <label>Recent Workspaces</label>
                <div className="settings-list">
                  {(local.recentWorkspaces ?? []).length === 0 ? (
                    <div className="settings-list-empty">No recent workspaces.</div>
                  ) : (
                    (local.recentWorkspaces ?? []).map((root) => (
                      <div key={root} className="settings-list-row">
                        <span className="settings-list-text">{root}</span>
                        <button
                          className="button"
                          type="button"
                          onClick={() =>
                            updateRecentWorkspaces(
                              (local.recentWorkspaces ?? []).filter((item) => item !== root)
                            )
                          }
                        >
                          <Trash2 size={12} />
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <span style={{ color: "var(--muted)", fontSize: 11 }}>
                  Max 4 workspaces. Oldest entries are dropped automatically.
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="button"
                  type="button"
                  onClick={() => updateRecentWorkspaces([])}
                >
                  <Trash2 size={12} />
                  Clear List
                </button>
              </div>
            </>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="button" onClick={handleValidate}>
            <CheckCircle2 size={12} />
            Validate
          </button>
          <button
            className="button primary"
            onClick={() => {
              onSave(local);
              onClose();
            }}
          >
            <Save size={12} />
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
