import { useMemo, useState } from "react";
import type { CodexEvent, CodexRunStatus } from "@shared/ipc";
import type { ReviewChange } from "@state/store";

const formatEvents = (events: CodexEvent[]) =>
  events
    .map((event) => `[${new Date(event.timestamp).toLocaleTimeString()}] ${event.data}`)
    .join("\n");

type CodexSidebarProps = {
  codexEvents: CodexEvent[];
  codexStatus: CodexRunStatus;
  reviewChanges: Record<string, ReviewChange>;
  onRun: (message: string) => void;
  onCancel: () => void;
  onAcceptChange: (path: string) => void;
  onRevertChange: (path: string) => void;
};

const CodexSidebar = ({
  codexEvents,
  codexStatus,
  reviewChanges,
  onRun,
  onCancel,
  onAcceptChange,
  onRevertChange
}: CodexSidebarProps) => {
  const [message, setMessage] = useState("");

  const logText = useMemo(() => formatEvents(codexEvents), [codexEvents]);
  const changes = Object.values(reviewChanges);

  return (
    <aside className="sidebar right">
      <div className="panel-title">Codex</div>
      <div className="codex-section">
        <div>
          <strong>Status:</strong>{" "}
          {codexStatus.running ? "Running" : "Idle"}
          {codexStatus.running ? <span className="status-pill">Streaming</span> : null}
        </div>
        <div className="codex-input">
          <textarea
            placeholder="Describe the change you want..."
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="button primary"
              onClick={() => {
                if (!message.trim()) return;
                onRun(message.trim());
                setMessage("");
              }}
            >
              Run Codex
            </button>
            <button className="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
        <div>
          <div className="panel-title">Timeline</div>
          <div className="codex-log">{logText || "No events yet."}</div>
        </div>
        <div>
          <div className="panel-title">Review</div>
          {changes.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 12 }}>No changes detected.</div>
          ) : (
            changes.map((change) => (
              <div key={change.path} className="review-card">
                <strong>{change.path.split(/[\\/]/).pop()}</strong>
                <pre>{change.diff}</pre>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="button primary" onClick={() => onAcceptChange(change.path)}>
                    Accept
                  </button>
                  <button className="button" onClick={() => onRevertChange(change.path)}>
                    Revert
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
};

export default CodexSidebar;
