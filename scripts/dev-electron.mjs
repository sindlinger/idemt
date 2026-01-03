import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  path.join(root, "dist", "main", "main.js"),
  path.join(root, "dist", "preload", "index.js")
];

const waitForFiles = async () => {
  while (true) {
    const checks = await Promise.all(
      requiredFiles.map((file) =>
        fs
          .access(file)
          .then(() => true)
          .catch(() => false)
      )
    );
    if (checks.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

await waitForFiles();

const electronPath = path.join(root, "node_modules", ".bin", "electron");
const child = spawn(electronPath, ["."], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_ENABLE_STACK_DUMPING: "1"
  },
  stdio: "inherit"
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
