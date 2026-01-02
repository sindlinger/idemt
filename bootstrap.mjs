#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();

const requiredFiles = ["AGENTS.md", "PROMPT.md"];
for (const f of requiredFiles) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) {
    console.error(`ERRO: arquivo obrigatório não encontrado: ${f}`);
    process.exit(1);
  }
}

function haveCmd(cmd) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: true });
  return r.status === 0;
}

if (!haveCmd("node")) {
  console.error("ERRO: Node.js não encontrado no PATH.");
  process.exit(1);
}
if (!haveCmd("git")) {
  console.error("ERRO: Git não encontrado no PATH.");
  process.exit(1);
}
if (!haveCmd("codex")) {
  console.error(
    "ERRO: Codex CLI não encontrado no PATH.\n" +
      "Instale com: npm i -g @openai/codex\n" +
      "Depois rode: codex login"
  );
  process.exit(1);
}

// Estrutura mínima
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.mkdirSync(path.join(root, "logs", "codex"), { recursive: true });
fs.mkdirSync(path.join(root, "runs"), { recursive: true });

const gitignorePath = path.join(root, ".gitignore");
if (!fs.existsSync(gitignorePath)) {
  fs.writeFileSync(
    gitignorePath,
    [
      "node_modules/",
      "dist/",
      "out/",
      ".DS_Store",
      "*.log",
      ".env",
      ".env.*",
      "runs/**",
      "logs/**",
    ].join("\n") + "\n",
    "utf8"
  );
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) {
    throw new Error(`Falha ao executar: ${cmd} ${args.join(" ")}`);
  }
}

// Init git (se necessário)
const gitDir = path.join(root, ".git");
if (!fs.existsSync(gitDir)) {
  console.log(">> git init");
  run("git", ["init"]);
}

// Config local para commit (não altera global)
try {
  spawnSync("git", ["config", "user.email"], { stdio: "ignore" });
  run("git", ["config", "user.email", "codex@local"]);
  run("git", ["config", "user.name", "Codex Local"]);
} catch {}

// Commit inicial (se não houver HEAD)
const hasHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
  stdio: "ignore",
}).status === 0;

if (!hasHead) {
  console.log(">> commit inicial");
  spawnSync("git", ["add", "-A"], { stdio: "inherit" });
  const c = spawnSync("git", ["commit", "-m", "chore: bootstrap"], {
    stdio: "inherit",
  });
  // Se falhar por “nothing to commit”, não é fatal
}

const promptPath = path.join(root, "PROMPT.md");
const outLogPath = path.join(root, "logs", "codex", "codex_exec.log");
const errLogPath = path.join(root, "logs", "codex", "codex_exec.err.log");
const finalMsgPath = path.join(root, "logs", "codex", "codex_final.md");

const model = process.env.CODEX_MODEL || "gpt-5-codex";
const enableSearch = process.env.CODEX_SEARCH !== "0"; // default ON
const yolo = process.env.CODEX_YOLO === "1"; // perigoso

const codexArgs = [];
if (enableSearch) codexArgs.push("--search"); // flag global (antes do subcomando)
codexArgs.push("exec");
codexArgs.push("--cd", root);
codexArgs.push("--model", model);
codexArgs.push("--full-auto");
codexArgs.push("--skip-git-repo-check");
codexArgs.push("--output-last-message", finalMsgPath);
if (yolo) codexArgs.push("--yolo");
codexArgs.push("-"); // PROMPT = '-' => lê do stdin

console.log(">> Iniciando Codex...");
console.log(`   model: ${model}`);
console.log(`   web search: ${enableSearch ? "ON" : "OFF"}`);
console.log(`   yolo: ${yolo ? "ON (PERIGOSO)" : "OFF"}`);
console.log(`   prompt: ${promptPath}`);
console.log(`   logs: ${outLogPath}`);
console.log(`   final message: ${finalMsgPath}`);

const outLog = fs.createWriteStream(outLogPath, { flags: "a" });
const errLog = fs.createWriteStream(errLogPath, { flags: "a" });

const child = spawn("codex", codexArgs, {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdout.on("data", (buf) => {
  process.stdout.write(buf);
  outLog.write(buf);
});
child.stderr.on("data", (buf) => {
  process.stderr.write(buf);
  errLog.write(buf);
});

// Pipe do PROMPT.md para stdin do codex
fs.createReadStream(promptPath, { encoding: "utf8" }).pipe(child.stdin);

const killChild = () => {
  if (!child.killed) {
    console.log("\n>> Interrompendo Codex...");
    child.kill("SIGINT");
  }
};

process.on("SIGINT", () => {
  killChild();
});
process.on("SIGTERM", () => {
  killChild();
});

child.on("close", (code) => {
  outLog.end();
  errLog.end();
  console.log(`\n>> Codex terminou com código: ${code}`);
  if (fs.existsSync(finalMsgPath)) {
    console.log(`>> Mensagem final salva em: ${finalMsgPath}`);
  } else {
    console.log(">> (Sem mensagem final gerada. Veja logs para detalhes.)");
  }
  process.exit(code ?? 0);
});
