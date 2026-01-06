import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { LogsService } from "./LogsService";

const ALLOWED_LEVELS = new Set(["minimal", "low", "medium", "high"]);

const getConfigPath = () => {
  if (process.env.CODEX_CONFIG) return process.env.CODEX_CONFIG;
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  return path.join(codexHome, "config.toml");
};

export const resolveCodexConfigPath = async (logs?: LogsService): Promise<string | null> => {
  const configPath = getConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const match = raw.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']\s*$/m);
    if (match && !ALLOWED_LEVELS.has(match[1])) {
      const sanitized = raw.replace(match[0], 'model_reasoning_effort = "high"');
      const outPath = path.join(app.getPath("userData"), "codex-config.toml");
      await fs.writeFile(outPath, sanitized, "utf-8");
      logs?.append(
        "codex",
        `Codex config normalized (model_reasoning_effort=${match[1]} -> high)`
      );
      return outPath;
    }
    return configPath;
  } catch {
    return null;
  }
};
