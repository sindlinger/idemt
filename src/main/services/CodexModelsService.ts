import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CodexModelsInfo, Settings } from "../../shared/ipc";
import { resolveCodexConfigPath } from "./CodexConfigService";

const extractModelsFromToml = (raw: string) => {
  const models = new Set<string>();
  let defaultModel: string | undefined;
  let defaultLevel: string | undefined;

  const modelMatch = raw.match(/^\s*model\s*=\s*["']([^"']+)["']\s*$/m);
  if (modelMatch) {
    defaultModel = modelMatch[1];
    models.add(defaultModel);
  }

  const levelMatch = raw.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']\s*$/m);
  if (levelMatch) {
    defaultLevel = levelMatch[1];
  }

  const modelsArrayMatch = raw.match(/^\s*models\s*=\s*\[(.*?)\]\s*$/ms);
  if (modelsArrayMatch) {
    const items = modelsArrayMatch[1]
      .split(",")
      .map((entry) => entry.trim())
      .map((entry) => entry.replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    items.forEach((entry) => models.add(entry));
  }

  return { models: Array.from(models), defaultModel, defaultLevel };
};

const getConfigPath = () => {
  if (process.env.CODEX_CONFIG) return process.env.CODEX_CONFIG;
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  return path.join(codexHome, "config.toml");
};

const readConfigFromWsl = async (): Promise<string | null> => {
  if (process.platform !== "win32") return null;
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["--", "bash", "-lc", "cat ~/.codex/config.toml"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0 && output.trim().length > 0) {
        resolve(output);
      } else {
        resolve(null);
      }
    });
  });
};

export const getCodexModelsInfo = async (settings: Settings): Promise<CodexModelsInfo> => {
  const runTarget = settings.codexRunTarget ?? "windows";
  if (runTarget === "wsl" && process.platform === "win32") {
    const raw = await readConfigFromWsl();
    if (raw) {
      const parsed = extractModelsFromToml(raw);
      if (parsed.models.length > 0) {
        return {
          models: parsed.models,
          defaultModel: parsed.defaultModel,
          defaultLevel: parsed.defaultLevel,
          source: "config"
        };
      }
    }
    return { models: [], source: "empty" };
  }

  const configPath = (await resolveCodexConfigPath(undefined, { target: runTarget })) ?? getConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = extractModelsFromToml(raw);
    if (parsed.models.length > 0) {
      return {
        models: parsed.models,
        defaultModel: parsed.defaultModel,
        defaultLevel: parsed.defaultLevel,
        source: "config"
      };
    }
  } catch {
    // ignore
  }
  return { models: [], source: "empty" };
};
