import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { LogsService } from "./LogsService";

const ALLOWED_LEVELS = new Set(["minimal", "low", "medium", "high"]);
const EFFORT_REGEX = /(^\s*model_reasoning_effort\s*=\s*["'])([^"']+)(["'].*$)/m;
const LEVEL_REGEX = /(^\s*reasoning\.level\s*=\s*["'])([^"']+)(["'].*$)/m;

const getConfigPath = () => {
  if (process.env.CODEX_CONFIG) return process.env.CODEX_CONFIG;
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  return path.join(codexHome, "config.toml");
};

export const resolveCodexConfigPath = async (
  logs?: LogsService,
  options?: { target?: "windows" | "wsl" }
): Promise<string | null> => {
  if (options?.target === "wsl" && process.platform === "win32") {
    return null;
  }
  const configPath = getConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    let sanitized = raw;
    let changed = false;

    const effortMatch = raw.match(EFFORT_REGEX);
    if (effortMatch && !ALLOWED_LEVELS.has(effortMatch[2].toLowerCase())) {
      sanitized = sanitized.replace(EFFORT_REGEX, `$1high$3`);
      logs?.append(
        "codex",
        `Codex config normalized (model_reasoning_effort=${effortMatch[2]} -> high)`
      );
      changed = true;
    }

    const levelMatch = raw.match(LEVEL_REGEX);
    if (levelMatch && !ALLOWED_LEVELS.has(levelMatch[2].toLowerCase())) {
      sanitized = sanitized.replace(LEVEL_REGEX, `$1high$3`);
      logs?.append(
        "codex",
        `Codex config normalized (reasoning.level=${levelMatch[2]} -> high)`
      );
      changed = true;
    }

    if (changed) {
      const outPath = path.join(app.getPath("userData"), "codex-config.toml");
      await fs.writeFile(outPath, sanitized, "utf-8");
      try {
        await fs.writeFile(configPath, sanitized, "utf-8");
        logs?.append("codex", "Codex config patched in place.");
      } catch (error) {
        logs?.append("codex", `Codex config patch failed: ${String(error)}`);
      }
      return outPath;
    }
    return configPath;
  } catch {
    return null;
  }
};
