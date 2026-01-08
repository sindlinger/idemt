import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import type { CodexEvent } from "@shared/ipc";
type CodexTerminalViewProps = {
  events: CodexEvent[];
  running: boolean;
};

const CodexTerminalView = ({ events, running }: CodexTerminalViewProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const indexRef = useRef(0);

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
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (indexRef.current > events.length) {
      terminal.clear();
      indexRef.current = 0;
    }
    for (let i = indexRef.current; i < events.length; i += 1) {
      const entry = events[i];
      if (!entry?.data) continue;
      terminal.write(entry.data);
    }
    indexRef.current = events.length;
    terminal.scrollToBottom();
  }, [events]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    fitAddon.fit();
  }, [running]);

  return <div ref={containerRef} className="codex-terminal" />;
};

export default CodexTerminalView;
