import fs from "node:fs/promises";
import path from "node:path";
import type { Diagnostic, Settings } from "../../shared/ipc";
import type { LogsService } from "./LogsService";
import type { WorkspaceService } from "./WorkspaceService";

const MAX_FILE_CHARS = 12000;
const MAX_LOG_LINES = 300;
const MAX_FILES = 8;

export type ContextInputs = {
  requestMessage: string;
  activeFilePath?: string;
  selection?: string;
  diagnostics: Diagnostic[];
  logs: LogsService;
  workspace: WorkspaceService;
  settings: Settings;
};

export const buildContext = async (inputs: ContextInputs) => {
  const { requestMessage, activeFilePath, selection, diagnostics, logs, workspace } = inputs;
  const buffer: string[] = [];

  buffer.push("# Codex Request");
  buffer.push(`UserMessage: ${requestMessage}`);
  if (activeFilePath) buffer.push(`ActiveFile: ${activeFilePath}`);
  if (selection) {
    buffer.push("\n# Selection\n" + truncate(selection));
  }

  buffer.push("\n# Diagnostics");
  if (diagnostics.length === 0) {
    buffer.push("(no diagnostics)");
  } else {
    diagnostics.slice(0, 120).forEach((diag) => {
      buffer.push(`${diag.filePath}:${diag.line}:${diag.column} ${diag.severity} ${diag.message}`);
    });
  }

  buffer.push("\n# Recent Logs");
  const logLines = [
    ...logs.getRecent("build", MAX_LOG_LINES),
    ...logs.getRecent("test", MAX_LOG_LINES)
  ];
  if (logLines.length === 0) {
    buffer.push("(no recent logs)");
  } else {
    buffer.push(logLines.join("\n"));
  }

  buffer.push("\n# Relevant Files");
  const allFiles = await workspace.listWorkspaceFiles();
  const relevantFiles = selectRelevantFiles(allFiles, activeFilePath);
  for (const file of relevantFiles) {
    try {
      const content = await fs.readFile(file, "utf-8");
      buffer.push(`\n## ${file}`);
      buffer.push(truncate(content));
    } catch {
      buffer.push(`\n## ${file}\n(unreadable)`);
    }
  }

  return buffer.join("\n");
};

const selectRelevantFiles = (files: string[], activeFilePath?: string) => {
  const mqlFiles = files.filter((file) =>
    [".mq4", ".mq5", ".mqh"].includes(path.extname(file).toLowerCase())
  );

  if (!activeFilePath) return mqlFiles.slice(0, MAX_FILES);

  const baseDir = path.dirname(activeFilePath);
  const scored = mqlFiles.map((file) => ({
    file,
    score: distance(baseDir, file)
  }));

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, MAX_FILES).map((entry) => entry.file);
};

const distance = (baseDir: string, filePath: string) => {
  const relative = path.relative(baseDir, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  return segments.length;
};

const truncate = (value: string) => {
  if (value.length <= MAX_FILE_CHARS) return value;
  const head = value.slice(0, Math.floor(MAX_FILE_CHARS * 0.6));
  const tail = value.slice(-Math.floor(MAX_FILE_CHARS * 0.4));
  return `${head}\n...\n${tail}`;
};
