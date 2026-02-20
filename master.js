const { spawnSync, spawn } = require("child_process");

function runStep(title, command, args) {
  console.log(`\n[master] ${title}...`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
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
  shell: process.platform === "win32"
});

server.on("exit", (code) => {
  process.exit(code || 0);
});
