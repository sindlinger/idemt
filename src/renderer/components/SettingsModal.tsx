import { useEffect, useState } from "react";
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

  useEffect(() => {
    setLocal(settings);
  }, [settings]);

  if (!open) return null;

  const updateField = (key: keyof Settings, value: string) => {
    setLocal((prev) => ({ ...prev, [key]: value }));
  };

  const browse = async (key: keyof Settings, type: "file" | "directory") => {
    const title = `Select ${String(key)}`;
    const result = await window.api.selectPath({ type, title });
    if (result) updateField(key, result);
  };

  const handleValidate = async () => {
    const result = await window.api.settingsValidate(local);
    setValidation(result);
  };

  return (
    <div className="settings-modal" onClick={onClose}>
      <div className="settings-card" onClick={(event) => event.stopPropagation()}>
        <h2>Settings</h2>
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
                Browse
              </button>
            </div>
            {validation[field.key] === false ? (
              <span style={{ color: "var(--danger)", fontSize: 12 }}>Path not found.</span>
            ) : null}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="button" onClick={handleValidate}>
            Validate
          </button>
          <button
            className="button primary"
            onClick={() => {
              onSave(local);
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
