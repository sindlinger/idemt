import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { app } from "electron";
import type { LogsService } from "./LogsService";

const DEFAULT_PROFILES = [
  {
    id: "reviewer",
    label: "Revisor de Código",
    content: `# MT5IDE Code Reviewer

Você é um revisor de código rodando dentro do MT5IDE.

## Papel
- Revisar mudanças com foco em bugs, regressões e riscos.
- Preferir respostas objetivas e estruturadas.
- Quando sugerir mudanças, explique o porquê em poucas linhas.

## Contexto
- Você recebe o arquivo aberto e a seleção atual.
- Existe um painel de review com diffs inline.

## Saída
- Seja conciso.
- Não repita o prompt do usuário.
`
  },
  {
    id: "implementer",
    label: "Implementador",
    content: `# MT5IDE Implementer

Você é um implementador dentro do MT5IDE.

## Papel
- Fazer mudanças diretas nos arquivos.
- Priorizar alterações pequenas e seguras.
- Manter o código funcional.

## Contexto
- Você recebe o arquivo aberto e a seleção.
- O IDE mostra diffs inline.

## Saída
- Explique o que mudou e por quê, de forma curta.
`
  },
  {
    id: "inline",
    label: "Inline (IDE)",
    content: `# MT5IDE Inline Assistant

Você é um assistente inline do MT5IDE.

## Papel
- Alterar arquivos diretamente no workspace.
- Trabalhar com o arquivo aberto e a seleção.
- Produzir mudanças visíveis no editor (diffs inline).

## Regras
- Não use arquivos temporários.
- Não peça permissões (o host já autorizou).
- Respostas curtas; a interface é o principal.
`
  }
] as const;

const hashWorkspace = (value: string) =>
  createHash("sha1").update(value).digest("hex").slice(0, 10);

type ProfileIndex = {
  activeId: string;
  profiles: { id: string; label: string; file: string }[];
};

const getBaseDir = (workspaceRoot: string) =>
  path.join(app.getPath("userData"), "codex-profiles", hashWorkspace(workspaceRoot));

const ensureProfileIndex = async (workspaceRoot: string, logs?: LogsService) => {
  const base = getBaseDir(workspaceRoot);
  const indexPath = path.join(base, "profiles.json");
  await fs.mkdir(base, { recursive: true });
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    return { base, index: JSON.parse(raw) as ProfileIndex };
  } catch {
    const index: ProfileIndex = {
      activeId: DEFAULT_PROFILES[0].id,
      profiles: DEFAULT_PROFILES.map((profile) => ({
        id: profile.id,
        label: profile.label,
        file: `${profile.id}.md`
      }))
    };
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
    logs?.append("codex", `Codex profiles index created at ${indexPath}`);
    return { base, index };
  }
};

const ensureProfileFiles = async (workspaceRoot: string, logs?: LogsService) => {
  const { base, index } = await ensureProfileIndex(workspaceRoot, logs);
  for (const profile of DEFAULT_PROFILES) {
    const filePath = path.join(base, `${profile.id}.md`);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, profile.content, "utf-8");
    }
  }
  return { base, index };
};

export const ensureInstructionsFile = async (
  workspaceRoot: string,
  logs?: LogsService
): Promise<string> => {
  const { base, index } = await ensureProfileFiles(workspaceRoot, logs);
  const active = index.profiles.find((profile) => profile.id === index.activeId);
  const fileName = active?.file ?? `${DEFAULT_PROFILES[0].id}.md`;
  const filePath = path.join(base, fileName);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    if (!content.trim()) {
      const fallback = DEFAULT_PROFILES.find((profile) => profile.id === index.activeId)
        ?? DEFAULT_PROFILES[0];
      await fs.writeFile(filePath, fallback.content, "utf-8");
    }
  } catch {
    // ignore read errors; file will be created by ensureProfileFiles
  }
  return filePath;
};

export const getProfilesInfo = async (workspaceRoot: string, logs?: LogsService) => {
  const { base, index } = await ensureProfileFiles(workspaceRoot, logs);
  const active = index.profiles.find((profile) => profile.id === index.activeId) ?? index.profiles[0];
  const contentPath = path.join(base, active.file);
  const content = await fs.readFile(contentPath, "utf-8");
  return {
    profiles: index.profiles.map((profile) => ({ id: profile.id, label: profile.label })),
    activeId: active.id,
    content
  };
};

export const setActiveProfile = async (
  workspaceRoot: string,
  id: string,
  logs?: LogsService
) => {
  const { base, index } = await ensureProfileFiles(workspaceRoot, logs);
  const exists = index.profiles.some((profile) => profile.id === id);
  const nextId = exists ? id : index.activeId;
  index.activeId = nextId;
  await fs.writeFile(path.join(base, "profiles.json"), JSON.stringify(index, null, 2), "utf-8");
  return getProfilesInfo(workspaceRoot, logs);
};

export const saveProfileContent = async (
  workspaceRoot: string,
  id: string,
  content: string,
  logs?: LogsService
) => {
  const { base, index } = await ensureProfileFiles(workspaceRoot, logs);
  const target = index.profiles.find((profile) => profile.id === id) ?? index.profiles[0];
  await fs.writeFile(path.join(base, target.file), content, "utf-8");
  return getProfilesInfo(workspaceRoot, logs);
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
  const configArg = `experimental_instructions_file=${instructionsPath}`;
  return ["-a", "never", "-s", "workspace-write", "-c", configArg];
};
