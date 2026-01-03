import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const source = path.resolve(repoRoot, "node_modules", "monaco-editor", "min", "vs");
const dest = path.resolve(repoRoot, "src", "renderer", "public", "monaco", "vs");

async function ensureDir(dir) {
  try {
    const info = await stat(dir);
    if (info.isDirectory()) return;
  } catch {
    // ignore
  }
  await mkdir(dir, { recursive: true });
}

async function main() {
  await ensureDir(path.dirname(dest));
  await cp(source, dest, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("copy-monaco failed:", err);
  process.exitCode = 1;
});
