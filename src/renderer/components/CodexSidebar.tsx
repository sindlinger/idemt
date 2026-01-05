import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitCompare,
  History,
  Power,
  RotateCcw,
  Send,
  Square
} from "lucide-react";
import type { CodexEvent, CodexRunStatus } from "@shared/ipc";
import type { CodexMessage, ReviewChange } from "@state/store";

type CodexSidebarProps = {
  codexEvents: CodexEvent[];
  codexMessages: CodexMessage[];
  codexStatus: CodexRunStatus;
  sessionActive: boolean;
  reviewChanges: Record<string, ReviewChange>;
  onRun: (message: string, options?: { model?: string; level?: string }) => void;
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
  const [model, setModel] = useState("default");
  const [level, setLevel] = useState("default");
  const [expandedReview, setExpandedReview] = useState<Set<string>>(() => new Set());
  const historyEntries = useMemo(() => codexEvents.slice().reverse(), [codexEvents]);

  const changes = Object.values(reviewChanges);
  const sendMessage = () => {
    if (!message.trim()) return;
    onRun(message.trim(), { model, level });
    setMessage("");
  };
  const statusInfo = useMemo(() => {
    if (codexStatus.running) {
      return { label: "Running", className: "running" };
    }
    if (codexStatus.endedAt) {
      return codexStatus.exitCode === 0
        ? { label: "Complete", className: "ok" }
        : { label: "Error", className: "error" };
    }
    return { label: "Idle", className: "idle" };
  }, [codexStatus]);
  const lastRunTime = useMemo(() => {
    if (!codexStatus.startedAt) return "—";
    return new Date(codexStatus.startedAt).toLocaleTimeString();
  }, [codexStatus.startedAt]);
  const toggleReviewItem = (path: string) => {
    setExpandedReview((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <aside className={`sidebar right codex-sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="codex-section">
        <div className="codex-topbar">
          <div className="codex-status">
            <span className={`codex-dot ${statusInfo.className}`} />
            <span className="codex-status-text">{statusInfo.label}</span>
            <span className="codex-status-time">{lastRunTime}</span>
          </div>
          <div className="codex-top-actions">
            <button
              className={`codex-view-toggle ${showHistory ? "active" : ""}`}
              onClick={() => setShowHistory((value) => !value)}
              title="History"
              aria-pressed={showHistory}
            >
              <History size={12} />
            </button>
            <button
              className={`codex-view-toggle ${showReview ? "active" : ""}`}
              onClick={() => setShowReview((value) => !value)}
              title="Review"
              aria-pressed={showReview}
            >
              <GitCompare size={12} />
            </button>
            <button
              className={`codex-session ${sessionActive ? "active" : ""}`}
              onClick={() => onToggleSession(!sessionActive)}
              title={sessionActive ? "Context on" : "Context off"}
              aria-pressed={sessionActive}
            >
              <Power size={12} />
            </button>
          </div>
        </div>
        <div className="codex-chat">
          {codexMessages.map((entry) => (
            <div key={`${entry.timestamp}-${entry.role}`} className={`codex-message ${entry.role}`}>
              <div className="codex-text">{entry.text}</div>
            </div>
          ))}
        </div>
        {(showHistory && historyEntries.length > 0) || (showReview && changes.length > 0) ? (
          <div className="codex-panels">
            {showHistory && historyEntries.length > 0 ? (
              <div className="codex-panel codex-history">
                {historyEntries.map((entry) => (
                  <div key={`${entry.timestamp}-${entry.type}`} className="codex-history-line">
                    <span className="codex-history-time">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="codex-history-text">{entry.data.trim()}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {showReview && changes.length > 0 ? (
              <div className="codex-panel codex-review">
                {changes.map((change) => {
                  const expanded = expandedReview.has(change.path);
                  return (
                    <div key={change.path} className="codex-review-item">
                      <button
                        className="codex-review-toggle"
                        onClick={() => toggleReviewItem(change.path)}
                        title={change.path}
                      >
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        <span className="codex-review-name">
                          {change.path.split(/[\\/]/).pop()}
                        </span>
                      </button>
                      {expanded ? (
                        <div className="codex-review-body">
                          <pre className="codex-review-diff">{change.diff}</pre>
                          <div className="codex-review-actions">
                            <button
                              className="codex-review-action"
                              onClick={() => onAcceptChange(change.path)}
                              title="Accept"
                            >
                              <Check size={12} />
                            </button>
                            <button
                              className="codex-review-action"
                              onClick={() => onRevertChange(change.path)}
                              title="Revert"
                            >
                              <RotateCcw size={12} />
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
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
            <div className="codex-action-group">
              <select
                className="codex-combo"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                aria-label="Model"
              >
                <option value="default">Model</option>
                <option value="o3">o3</option>
                <option value="o4-mini">o4-mini</option>
              </select>
              <select
                className="codex-combo"
                value={level}
                onChange={(event) => setLevel(event.target.value)}
                aria-label="Level"
              >
                <option value="default">Level</option>
                <option value="low">Low</option>
                <option value="high">High</option>
              </select>
            </div>
            <div className="codex-action-group right">
              <button
                className="codex-send"
                onClick={sendMessage}
                disabled={codexStatus.running}
                title="Send"
              >
                <Send size={12} />
              </button>
              {codexStatus.running ? (
                <button className="codex-stop" onClick={onCancel} title="Stop">
                  <Square size={10} />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};

export default CodexSidebar;
