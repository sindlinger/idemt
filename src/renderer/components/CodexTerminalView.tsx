import { useEffect, useMemo, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import type { CodexEvent } from "@shared/ipc";
import type { CodexMessage } from "@state/store";

type CodexTerminalViewProps = {
  events: CodexEvent[];
  messages: CodexMessage[];
  running: boolean;
};

const CodexTerminalView = ({ events, messages, running }: CodexTerminalViewProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const indexRef = useRef(0);

  const streamItems = useMemo(() => {
    const messageItems = messages.map((entry) => ({
      kind: "user" as const,
      timestamp: entry.timestamp,
      text: entry.text
    }));
    const eventItems = events.map((entry) => ({
      kind: "event" as const,
      timestamp: entry.timestamp,
      text: entry.data,
      eventType: entry.type
    }));
    return [...messageItems, ...eventItems].sort((a, b) => a.timestamp - b.timestamp);
  }, [events, messages]);

  useEffect(() => {
    const terminal = new Terminal({
      fontSize: 11,
      convertEol: true,
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

  const sanitize = (text: string) => {
    const withoutOsc = text.replace(/\x1b\][^\x07]*\x07/g, "");
    const withoutCsi = withoutOsc.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const withoutOther = withoutCsi.replace(/\x1b[@-Z\\-_]/g, "");
    const withoutCtrl = withoutOther.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    return withoutCtrl.replace(/\r/g, "\n").replace(/\uFFFD/g, "");
  };

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    for (let i = indexRef.current; i < streamItems.length; i += 1) {
      const entry = streamItems[i];
      if (entry.kind === "user") {
        terminal.write(`\r\n> ${entry.text}\r\n`);
        continue;
      }
      if (!entry.text) continue;
      terminal.write(sanitize(entry.text));
    }
    indexRef.current = streamItems.length;
    terminal.scrollToBottom();
  }, [streamItems]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    fitAddon.fit();
  }, [running]);

  return <div ref={containerRef} className="codex-terminal" />;
};

export default CodexTerminalView;
