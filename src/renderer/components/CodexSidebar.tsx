import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitCompare,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Terminal
} from "lucide-react";
import type { CodexEvent, CodexRunStatus } from "@shared/ipc";
import type { CodexMessage, ReviewChange } from "@state/store";
import CodexTerminalView from "./CodexTerminalView";

const sanitizeCodexOutput = (text: string) => {
  const withoutOsc = text.replace(/\x1b\][^\x07]*\x07/g, "");
  const withoutCsi = withoutOsc.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const withoutOther = withoutCsi.replace(/\x1b[@-Z\\-_]/g, "");
  const withoutCtrl = withoutOther.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return withoutCtrl.replace(/\r/g, "").replace(/\uFFFD/g, "");
};

const stripCodexMetadata = (text: string) => {
  const markers = ["OpenAI Codex", "# Codex Request", "tokens used"];
  let cutoff = text.length;
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx !== -1) cutoff = Math.min(cutoff, idx);
  }
  const trimmed = text.slice(0, cutoff);
  const lines = trimmed.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    const noisy = [
      "UtilTranslatePathList",
      "Failed to translate",
      "[wsl-interop-fix]",
      "WSL (",
      "WSL_DISTRO_NAME",
      "powershell.exe disponível",
      "Codex session message sent",
      "Codex run started",
      "You are running Codex in",
      "AllowCodex",
      "Require approval",
      "Press enter to continue"
    ];
    if (noisy.some((frag) => t.includes(frag))) return false;
    if (/^\[?[0-9;?<>]*[A-Za-z]$/.test(t)) return false;
    if (/^\[?[0-9;?<>]*u$/.test(t)) return false;
    if (/^\[?[0-9;?<>]*$/.test(t) && t.length <= 6) return false;
    const prefixes = [
      "workdir:",
      "model:",
      "provider:",
      "approval:",
      "sandbox:",
      "reasoning effort:",
      "reasoning summaries:",
      "session id:",
      "UserMessage:",
      "ActiveFile:",
      "# Diagnostics",
      "# Recent Logs",
      "# Relevant Files",
      "# Codex Request",
      "--------"
    ];
    if (t === "user") return false;
    if (t.startsWith("## ")) return false;
    return !prefixes.some((prefix) => t.startsWith(prefix));
  });
  return filtered.join("\n");
};

type CodexSidebarProps = {
  codexEvents: CodexEvent[];
  codexMessages: CodexMessage[];
  codexStatus: CodexRunStatus;
  reviewChanges: Record<string, ReviewChange>;
  runTarget?: "windows" | "wsl";
  onRunTargetChange?: (target: "windows" | "wsl") => void;
  models: string[];
  defaultModel?: string;
  defaultLevel?: string;
  onRun: (message: string, options?: { model?: string; level?: string }) => void;
  onReview: (request: {
    preset: "base" | "uncommitted" | "commit" | "custom";
    baseBranch?: string;
    commitSha?: string;
    instructions?: string;
  }) => void;
  onCancel: () => void;
  onNewSession: () => void;
  onAcceptChange: (path: string) => void;
  onRevertChange: (path: string) => void;
  collapsed?: boolean;
};

const CodexSidebar = ({
  codexEvents,
  codexMessages,
  codexStatus,
  reviewChanges,
  runTarget,
  onRunTargetChange,
  models,
  defaultModel,
  defaultLevel,
  onRun,
  onReview,
  onCancel,
  onNewSession,
  onAcceptChange,
  onRevertChange,
  collapsed
}: CodexSidebarProps) => {
  const [message, setMessage] = useState("");
  const [showTerminal, setShowTerminal] = useState(false);
  const [model, setModel] = useState(defaultModel ?? "default");
  const [level, setLevel] = useState(defaultLevel ?? "default");
  const [expandedReview, setExpandedReview] = useState<Set<string>>(() => new Set());
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false);
  const [reviewPreset, setReviewPreset] = useState<
    "base" | "uncommitted" | "commit" | "custom" | null
  >(null);
  const [reviewBase, setReviewBase] = useState("");
  const [reviewCommit, setReviewCommit] = useState("");
  const [reviewInstructions, setReviewInstructions] = useState("");
  const chatRef = useRef<HTMLDivElement | null>(null);
  const recentUserMessages = useMemo(() => {
    return new Set(
      codexMessages
        .filter((entry) => entry.role === "user")
        .slice(-6)
        .map((entry) => entry.text.trim())
        .filter(Boolean)
    );
  }, [codexMessages]);
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
        eventType: "codex" as const
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
  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [streamItems.length]);
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
  const resetReviewPicker = () => {
    setReviewPreset(null);
    setReviewBase("");
    setReviewCommit("");
    setReviewInstructions("");
  };
  const runReviewPreset = (payload: {
    preset: "base" | "uncommitted" | "commit" | "custom";
    baseBranch?: string;
    commitSha?: string;
    instructions?: string;
  }) => {
    onReview(payload);
    setReviewPickerOpen(false);
    resetReviewPicker();
  };
  const startReview = () => {
    if (!reviewPreset) return;
    if (reviewPreset === "base" && !reviewBase.trim()) return;
    if (reviewPreset === "commit" && !reviewCommit.trim()) return;
    if (reviewPreset === "custom" && !reviewInstructions.trim()) return;
    runReviewPreset({
      preset: reviewPreset,
      baseBranch: reviewPreset === "base" ? reviewBase.trim() : undefined,
      commitSha: reviewPreset === "commit" ? reviewCommit.trim() : undefined,
      instructions: reviewInstructions.trim() || undefined
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
            {onRunTargetChange && runTarget ? (
              <div className="codex-target-toggle" role="group" aria-label="Codex runtime">
                <button
                  className={`codex-target ${runTarget === "windows" ? "active" : ""}`}
                  onClick={() => onRunTargetChange("windows")}
                  title="Run Codex on Windows"
                >
                  Win
                </button>
                <button
                  className={`codex-target ${runTarget === "wsl" ? "active" : ""}`}
                  onClick={() => onRunTargetChange("wsl")}
                  title="Run Codex on WSL"
                >
                  WSL
                </button>
              </div>
            ) : null}
            <button
              className={`codex-view-toggle ${showTerminal ? "active" : ""}`}
              onClick={() => setShowTerminal((value) => !value)}
              title="Terminal"
              aria-pressed={showTerminal}
            >
              <Terminal size={12} />
            </button>
            <button className="codex-view-toggle" onClick={onNewSession} title="New">
              <RefreshCw size={12} />
            </button>
            <button
              className={`codex-view-toggle ${reviewPickerOpen ? "active" : ""}`}
              onClick={() => setReviewPickerOpen((value) => !value)}
              title="Review presets"
              aria-pressed={reviewPickerOpen}
            >
              <GitCompare size={12} />
            </button>
          </div>
        </div>
        {reviewPickerOpen ? (
          <div className="codex-review-picker">
            <div className="codex-review-title">Select a review preset</div>
            {!reviewPreset ? (
              <div className="codex-review-list">
                <button
                  className="codex-review-option"
                  onClick={() => setReviewPreset("base")}
                >
                  1. Review against a base branch (PR Style)
                </button>
                <button
                  className="codex-review-option"
                  onClick={() => runReviewPreset({ preset: "uncommitted" })}
                >
                  2. Review uncommitted changes
                </button>
                <button
                  className="codex-review-option"
                  onClick={() => setReviewPreset("commit")}
                >
                  3. Review a commit
                </button>
                <button
                  className="codex-review-option"
                  onClick={() => setReviewPreset("custom")}
                >
                  4. Custom review instructions
                </button>
              </div>
            ) : (
              <div className="codex-review-form">
                {reviewPreset === "base" ? (
                  <label>
                    Base branch
                    <input
                      type="text"
                      placeholder="main"
                      value={reviewBase}
                      onChange={(event) => setReviewBase(event.target.value)}
                    />
                  </label>
                ) : null}
                {reviewPreset === "commit" ? (
                  <label>
                    Commit SHA
                    <input
                      type="text"
                      placeholder="HEAD~1"
                      value={reviewCommit}
                      onChange={(event) => setReviewCommit(event.target.value)}
                    />
                  </label>
                ) : null}
                {reviewPreset === "custom" ? (
                  <label>
                    Instructions
                    <textarea
                      rows={3}
                      placeholder="Focus on risk, correctness, and performance."
                      value={reviewInstructions}
                      onChange={(event) => setReviewInstructions(event.target.value)}
                    />
                  </label>
                ) : (
                  <label>
                    Instructions (optional)
                    <textarea
                      rows={2}
                      placeholder="Optional review focus."
                      value={reviewInstructions}
                      onChange={(event) => setReviewInstructions(event.target.value)}
                    />
                  </label>
                )}
                <div className="codex-review-picker-actions">
                  <button className="codex-review-picker-action" onClick={startReview}>
                    Run
                  </button>
                  <button
                    className="codex-review-picker-action ghost"
                    onClick={() => resetReviewPicker()}
                  >
                    Back
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}
        {showTerminal ? (
          <CodexTerminalView
            events={codexEvents}
            messages={codexMessages}
            running={codexStatus.running}
          />
        ) : (
          <div className="codex-chat" ref={chatRef}>
            {streamItems.map((entry) => {
              if (entry.kind === "user") {
                return (
                  <div key={`user-${entry.timestamp}`} className="codex-message user">
                    <div className="codex-text">{entry.text}</div>
                  </div>
                );
              }
              const cleaned = stripCodexMetadata(sanitizeCodexOutput(entry.text));
              if (!cleaned) return null;
              const lines = cleaned
                .split(/\r?\n/)
                .filter((line) => line.length > 0)
                .filter((line) => !recentUserMessages.has(line.trim()));
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
        )}
        {changes.length > 0 ? (
          <div className="codex-panels">
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
