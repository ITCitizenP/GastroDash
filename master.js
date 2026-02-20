const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

if (fs.existsSync(path.join(process.cwd(), ".env"))) {
  // Load local .env when available (helpful for panel environments).
  // eslint-disable-next-line global-require
  require("dotenv").config();
}

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:./dev.db";
  console.log("[master] DATABASE_URL war nicht gesetzt, nutze Fallback: file:./dev.db");
}

function runStep(title, command, args) {
  console.log(`\n[master] ${title}...`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env
  });
  if (result.status !== 0) {
    console.error(`[master] Fehler bei: ${title}`);
    process.exit(result.status || 1);
  }
}

runStep("Prisma Client generieren", "npx", ["prisma", "generate"]);
runStep("Datenbank Schema pruefen/anwenden", "npx", ["prisma", "db", "push"]);

console.log("\n[master] Starte Server...");
const server = spawn("node", ["src/server.js"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env
});

server.on("exit", (code) => {
  process.exit(code || 0);
});
