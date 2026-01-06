import { useEffect, useMemo, useState } from "react";
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
  models: string[];
  defaultModel?: string;
  defaultLevel?: string;
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
  models,
  defaultModel,
  defaultLevel,
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
  const [model, setModel] = useState(defaultModel ?? "default");
  const [level, setLevel] = useState(defaultLevel ?? "default");
  const [expandedReview, setExpandedReview] = useState<Set<string>>(() => new Set());
  const streamItems = useMemo(() => {
    const messageItems = codexMessages.map((entry) => {
      if (entry.role === "user") {
        return {
          kind: "user" as const,
          timestamp: entry.timestamp,
          text: entry.text
        };
      }
      return {
        kind: "event" as const,
        timestamp: entry.timestamp,
        text: entry.text,
        eventType: "status" as const
      };
    });
    const eventItems = codexEvents.map((entry) => ({
      kind: "event" as const,
      timestamp: entry.timestamp,
      text: entry.data,
      eventType: entry.type
    }));
    return [...messageItems, ...eventItems].sort((a, b) => a.timestamp - b.timestamp);
  }, [codexEvents, codexMessages]);

  const changes = Object.values(reviewChanges);
  const modelOptions = useMemo(() => models.filter(Boolean), [models]);
  const levelOptions = useMemo(() => {
    const base = ["default", "low", "medium", "high", "xhigh"];
    if (defaultLevel && !base.includes(defaultLevel)) {
      base.push(defaultLevel);
    }
    return base;
  }, [defaultLevel]);
  const sendMessage = () => {
    if (!message.trim()) return;
    onRun(message.trim(), { model, level });
    setMessage("");
  };
  const resolvedDefaultModel = defaultModel ?? modelOptions[0];
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
  useEffect(() => {
    if (!resolvedDefaultModel) return;
    setModel((prev) => {
      if (prev === "default" || !modelOptions.includes(prev)) {
        return resolvedDefaultModel;
      }
      return prev;
    });
  }, [resolvedDefaultModel, modelOptions]);
  useEffect(() => {
    if (!defaultLevel) return;
    setLevel((prev) => (prev === "default" ? defaultLevel : prev));
  }, [defaultLevel]);
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
        {showHistory ? (
          <div className="codex-chat">
            {streamItems.map((entry) => {
              if (entry.kind === "user") {
                return (
                  <div key={`user-${entry.timestamp}`} className="codex-message user">
                    <div className="codex-text">{entry.text}</div>
                  </div>
                );
              }
              const lines = entry.text.split(/\r?\n/).filter((line) => line.length > 0);
              if (lines.length === 0) return null;
              return lines.map((line, idx) => (
                <div
                  key={`event-${entry.timestamp}-${idx}`}
                  className={`codex-log-line ${entry.eventType}`}
                >
                  {line}
                </div>
              ));
            })}
          </div>
        ) : null}
        {showReview && changes.length > 0 ? (
          <div className="codex-panels">
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
              <div className="codex-combo-wrap">
                <select
                  className="codex-combo"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  aria-label="Model"
                >
                  {modelOptions.length === 0 ? (
                    <option value="default">Model</option>
                  ) : (
                    modelOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div className="codex-combo-wrap">
                <select
                  className="codex-combo"
                  value={level}
                  onChange={(event) => setLevel(event.target.value)}
                  aria-label="Level"
                >
                  {levelOptions.map((option) => (
                    <option key={option} value={option}>
                      {option === "default" ? "Level" : option}
                    </option>
                  ))}
                </select>
              </div>
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
