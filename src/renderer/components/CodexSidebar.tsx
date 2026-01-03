import { useMemo, useState } from "react";
import { Check, GitCompare, History, Power, RotateCcw, Send, Square } from "lucide-react";
import type { CodexEvent, CodexRunStatus } from "@shared/ipc";
import type { CodexMessage, ReviewChange } from "@state/store";

type CodexSidebarProps = {
  codexEvents: CodexEvent[];
  codexMessages: CodexMessage[];
  codexStatus: CodexRunStatus;
  sessionActive: boolean;
  reviewChanges: Record<string, ReviewChange>;
  onRun: (message: string) => void;
  onCancel: () => void;
  onToggleSession: (active: boolean) => void;
  onAcceptChange: (path: string) => void;
  onRevertChange: (path: string) => void;
  collapsed?: boolean;
};

const CodexSidebar = ({
  codexEvents,
  codexMessages,
  codexStatus,
  sessionActive,
  reviewChanges,
  onRun,
  onCancel,
  onToggleSession,
  onAcceptChange,
  onRevertChange,
  collapsed
}: CodexSidebarProps) => {
  const [message, setMessage] = useState("");
  const [showHistory, setShowHistory] = useState(true);
  const [showReview, setShowReview] = useState(true);
  const historyEntries = useMemo(() => codexEvents.slice().reverse(), [codexEvents]);

  const changes = Object.values(reviewChanges);
  const sendMessage = () => {
    if (!message.trim()) return;
    onRun(message.trim());
    setMessage("");
  };

  return (
    <aside className={`sidebar right codex-sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="codex-header">
        <div className="panel-title">Codex</div>
        <button
          className={`codex-toggle ${sessionActive ? "active" : ""}`}
          onClick={() => onToggleSession(!sessionActive)}
        >
          <Power size={12} />
          On
        </button>
      </div>
      <div className="codex-section">
        <div className="codex-view-toggles">
          <button
            className={`codex-view-toggle ${showHistory ? "active" : ""}`}
            onClick={() => setShowHistory((value) => !value)}
          >
            <History size={12} />
            History
          </button>
          <button
            className={`codex-view-toggle ${showReview ? "active" : ""}`}
            onClick={() => setShowReview((value) => !value)}
          >
            <GitCompare size={12} />
            Review
          </button>
        </div>
        <div className="codex-chat">
          {codexMessages.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>
              No messages yet. Toggle On to keep context between runs.
            </div>
          ) : (
            codexMessages.map((entry) => (
              <div key={`${entry.timestamp}-${entry.role}`} className={`codex-message ${entry.role}`}>
                <div className="codex-meta">{entry.role.toUpperCase()}</div>
                <div className="codex-text">{entry.text}</div>
              </div>
            ))
          )}
        </div>
        {showHistory ? (
          <div className="codex-history">
            {historyEntries.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>
                No history yet.
              </div>
            ) : (
              historyEntries.map((entry) => (
                <div key={`${entry.timestamp}-${entry.type}`} className="codex-history-line">
                  <span className="codex-history-time">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="codex-history-text">{entry.data.trim()}</span>
                </div>
              ))
            )}
          </div>
        ) : null}
        <div className="codex-input">
          <textarea
            placeholder="Type your request..."
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
          <div className="codex-actions">
            <button
              className="codex-send"
              onClick={sendMessage}
              disabled={codexStatus.running}
              title="Send"
            >
              <Send size={12} />
            </button>
            <button
              className="codex-stop"
              onClick={onCancel}
              disabled={!codexStatus.running}
              title="Stop"
            >
              <Square size={10} />
            </button>
          </div>
        </div>
        {showReview ? (
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
                      <Check size={12} />
                      Accept
                    </button>
                    <button className="button" onClick={() => onRevertChange(change.path)}>
                      <RotateCcw size={12} />
                      Revert
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
};

export default CodexSidebar;
