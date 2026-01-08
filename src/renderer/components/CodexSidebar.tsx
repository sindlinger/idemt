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
import AnsiToHtml from "ansi-to-html";
import CodexTerminalView from "./CodexTerminalView";

const stripAnsi = (text: string) => {
  const withoutOsc = text.replace(/\x1b\][^\x07]*\x07/g, "");
  const withoutCsi = withoutOsc.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return withoutCsi.replace(/\x1b[@-Z\\-_]/g, "");
};

const sanitizeAnsiForHtml = (text: string) => {
  // Drop OSC sequences and any non-SGR CSI sequences to avoid leaking control codes.
  let cleaned = text.replace(/\x1b\][^\x07]*\x07/g, "");
  cleaned = cleaned.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, (match) =>
    match.endsWith("m") ? match : ""
  );
  cleaned = cleaned.replace(/\x1b[@-Z\\-_]/g, "");
  return cleaned;
};

const NOISY_FRAGMENTS = [
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

const METADATA_PREFIXES = [
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

const isNoisyLine = (line: string) => {
  if (!line) return true;
  if (line === "user") return true;
  if (line.startsWith("## ")) return true;
  if (METADATA_PREFIXES.some((prefix) => line.startsWith(prefix))) return true;
  return NOISY_FRAGMENTS.some((frag) => line.includes(frag));
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
  const recentUserMessages = useMemo(
    () =>
      codexMessages
        .filter((entry) => entry.role === "user")
        .slice(-12)
        .map((entry) => entry.text.trim())
        .filter(Boolean),
    [codexMessages]
  );
  const userBubbles = useMemo(() => {
    return codexMessages
      .filter((entry) => entry.role === "user")
      .slice(-3)
      .map((entry) => ({ id: entry.timestamp, text: entry.text }));
  }, [codexMessages]);
  const ansiToHtml = useMemo(() => {
    return new AnsiToHtml({
      fg: "#d7dce6",
      bg: "transparent",
      newline: false,
      escapeXML: true
    });
  }, []);
  const graphicLines = useMemo(() => {
    const lines: string[] = [""];
    const appendLine = (chunk: string) => {
      let buffer = sanitizeAnsiForHtml(chunk);
      buffer = buffer.replace(/\uFFFD/g, "");
      for (let i = 0; i < buffer.length; i += 1) {
        const char = buffer[i];
        if (char === "\r") {
          lines[lines.length - 1] = "";
          continue;
        }
        if (char === "\n") {
          lines.push("");
          continue;
        }
        lines[lines.length - 1] += char;
      }
    };
    for (const entry of codexEvents) {
      if (entry.type !== "stdout" && entry.type !== "stderr") continue;
      if (!entry.data) continue;
      appendLine(entry.data);
    }
    const filtered: string[] = [];
    for (const line of lines) {
      const plain = stripAnsi(line).replace(/\r/g, "").trim();
      if (!plain) continue;
      if (isNoisyLine(plain)) continue;
      if (recentUserMessages.includes(plain) || recentUserMessages.includes(plain.replace(/^>\s*/, ""))) {
        continue;
      }
      filtered.push(line);
    }
    return filtered.map((line) => ansiToHtml.toHtml(line));
  }, [ansiToHtml, codexEvents, recentUserMessages]);

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
  }, [codexEvents.length, codexMessages.length]);
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
            running={codexStatus.running}
            mode="raw"
          />
        ) : (
          <div className="codex-chat" ref={chatRef}>
            <div className="codex-output">
              {graphicLines.map((line, idx) => (
                <div
                  key={`codex-line-${idx}`}
                  className="codex-log-line codex"
                  dangerouslySetInnerHTML={{ __html: line }}
                />
              ))}
            </div>
            {userBubbles.length ? (
              <div className="codex-bubbles">
                {userBubbles.map((entry) => (
                  <div key={entry.id} className="codex-message user">
                    <div className="codex-text">{entry.text}</div>
                  </div>
                ))}
              </div>
            ) : null}
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
