import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import type { CodexEvent } from "@shared/ipc";
type CodexTerminalViewProps = {
  events: CodexEvent[];
  running: boolean;
  mode?: "raw" | "clean";
  className?: string;
  filterUserMessages?: string[];
};

const stripAnsi = (text: string) => {
  const withoutOsc = text.replace(/\x1b\][^\x07]*\x07/g, "");
  const withoutCsi = withoutOsc.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return withoutCsi.replace(/\x1b[@-Z\\-_]/g, "");
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

const CodexTerminalView = ({
  events,
  running,
  mode = "raw",
  className,
  filterUserMessages = []
}: CodexTerminalViewProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const indexRef = useRef(0);
  const bufferRef = useRef("");

  useEffect(() => {
    const terminal = new Terminal({
      fontSize: 11,
      convertEol: false,
      theme: { background: "#141a28", foreground: "#e7ecf4" },
      scrollback: 5000
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    if (containerRef.current) {
      terminal.open(containerRef.current);
      fitAddon.fit();
    }
    return () => {
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!container || !terminal) return;
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const selection = terminal.getSelection();
      if (selection && navigator.clipboard) {
        void navigator.clipboard.writeText(selection);
      }
    };
    container.addEventListener("contextmenu", handleContextMenu);
    return () => container.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  useEffect(() => {
    const fit = () => {
      const fitAddon = fitAddonRef.current;
      if (!fitAddon) return;
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && window.api?.codexSessionResize) {
        window.api.codexSessionResize({ cols: dims.cols, rows: dims.rows });
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (indexRef.current > events.length) {
      terminal.clear();
      indexRef.current = 0;
    }
    const matchesUserMessage = (line: string) => {
      if (!filterUserMessages.length) return false;
      const trimmed = line.trim();
      if (!trimmed) return false;
      return filterUserMessages.some((msg) => {
        const clean = msg.trim();
        if (!clean) return false;
        return trimmed === clean || trimmed === `> ${clean}` || trimmed === `> ${clean}\r`;
      });
    };
    const writeFiltered = (data: string) => {
      if (mode === "raw") {
        terminal.write(data);
        return;
      }
      let buffer = bufferRef.current + data;
      let start = 0;
      let idx = buffer.indexOf("\n", start);
      while (idx !== -1) {
        const chunk = buffer.slice(start, idx + 1);
        const clean = stripAnsi(chunk).replace(/\r/g, "").trim();
        if (!isNoisyLine(clean) && !matchesUserMessage(clean)) {
          terminal.write(chunk);
        }
        start = idx + 1;
        idx = buffer.indexOf("\n", start);
      }
      bufferRef.current = buffer.slice(start);
      if (bufferRef.current.includes("\r")) {
        terminal.write(bufferRef.current);
        bufferRef.current = "";
      }
    };

    for (let i = indexRef.current; i < events.length; i += 1) {
      const entry = events[i];
      if (!entry?.data) continue;
      if (entry.type !== "stdout" && entry.type !== "stderr") continue;
      writeFiltered(entry.data);
    }
    indexRef.current = events.length;
    terminal.scrollToBottom();
  }, [events, mode, filterUserMessages]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    fitAddon.fit();
    if (!running && bufferRef.current) {
      terminal.write(bufferRef.current);
      bufferRef.current = "";
    }
  }, [running]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.clear();
    indexRef.current = 0;
    bufferRef.current = "";
  }, [mode]);

  return <div ref={containerRef} className={className ?? "codex-terminal"} />;
};

export default CodexTerminalView;
