import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { app } from "electron";
import type { LogsService } from "./LogsService";

const DEFAULT_INSTRUCTIONS = `# MT5IDE Agent

You are Codex running inside MT5IDE as an inline code assistant.

## Core role
- Act as a code reviewer and code implementer.
- You operate inside an IDE that shows inline diffs and a review panel.
- Prefer small, safe edits and explain what changed.

## Workflow
- Use the open file and selection context provided by the host app.
- Apply edits directly to files in the workspace (not in temporary files).
- Keep responses concise; the UI is the primary surface.

## Safety
- Assume workspace write access is already granted.
- Do not ask for permission prompts; the host handles approvals.
`;

const hashWorkspace = (value: string) =>
  createHash("sha1").update(value).digest("hex").slice(0, 10);

export const ensureInstructionsFile = async (
  workspaceRoot: string,
  logs?: LogsService
): Promise<string> => {
  const base = path.join(app.getPath("userData"), "codex-profiles", hashWorkspace(workspaceRoot));
  const filePath = path.join(base, "AGENTS.md");
  await fs.mkdir(base, { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, DEFAULT_INSTRUCTIONS, "utf-8");
    logs?.append("codex", `Codex instructions created at ${filePath}`);
  }
  return filePath;
};

export const toWslPath = (value: string) => {
  if (!value) return value;
  if (value.startsWith("/mnt/")) return value.replace(/\\/g, "/");
  const match = value.match(/^([A-Za-z]):[\\/](.*)$/);
  if (match) {
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  return value.replace(/\\/g, "/");
};

export const buildCodexAgentArgs = (instructionsPath: string) => {
  const configArg = `experimental_instructions_file=${JSON.stringify(instructionsPath)}`;
  return ["-a", "never", "-s", "workspace-write", "-c", configArg];
};
