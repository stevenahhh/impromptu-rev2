// Boot the whole impromptu-r2 stack on fixed ports and keep it running.
// Usage: node .omo/scratch/render-qa/run-system.mjs
import { spawn } from "node:child_process";
import { join } from "node:path";
import { rmSync } from "node:fs";

const ROOT = "C:/Users/steve/Desktop/projects/impromptu-r2";
const TEMP = process.env.TEMP ?? "C:/temp";
const PRIVATE_PORT = 4310;
const PROJECTION_PORT = 4311;
const STAGE_PORT = 4174;
const CONSOLE_PORT = 4173;
const privateOrigin = `http://127.0.0.1:${PRIVATE_PORT}`;
const projectionOrigin = `http://127.0.0.1:${PROJECTION_PORT}`;
const stageOrigin = `http://127.0.0.1:${STAGE_PORT}`;
const consoleOrigin = `http://127.0.0.1:${CONSOLE_PORT}`;
const serviceToken = "local-system-run-token";

const snapshotPath = join(TEMP, "impromptu-system-private-snapshot.json");
const projectionDbPath = join(TEMP, "impromptu-system-projection-db.json");
rmSync(snapshotPath, { force: true });
rmSync(projectionDbPath, { force: true });

const children = [];
function start(name, command, args, env, expect, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd ?? ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    children.push({ name, child });
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`${name} never printed ${expect}\n${buffer}`)), 60000);
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      buffer += text;
      process.stdout.write(`[${name}] ${text}`);
      if (buffer.includes(expect)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited early with ${code}\n${buffer}`));
    });
  });
}

console.log("=== 1/4 projection-gateway ===");
await start(
  "projection",
  "bun",
  ["run", "services/projection-gateway/src/main.ts"],
  {
    PRIVATE_BACKEND_ORIGIN: privateOrigin,
    PROJECTION_GATEWAY_HOST: "127.0.0.1",
    PROJECTION_GATEWAY_PORT: String(PROJECTION_PORT),
    PROJECTION_DATABASE_PATH: projectionDbPath,
    SERVICE_AUTH_TOKEN: serviceToken,
    STAGE_ORIGIN: stageOrigin,
  },
  "projection-gateway listening",
);

console.log("=== 2/4 private-backend ===");
await start(
  "private",
  "bun",
  ["run", "services/private-backend/src/main.ts"],
  {
    CONSOLE_ORIGIN: consoleOrigin,
    CONTROLLER_ACCOUNT_ID: "account_local",
    CONTROLLER_ACTOR_ID: "actor_local",
    CONTROLLER_AUTHORIZATION_CODE: "local-code",
    TAKEOVER_ACTOR_ID: "actor_local_takeover",
    TAKEOVER_AUTHORIZATION_CODE: "local-takeover-code",
    PRIVATE_BACKEND_HOST: "127.0.0.1",
    PRIVATE_BACKEND_PORT: String(PRIVATE_PORT),
    PRIVATE_SNAPSHOT_PATH: snapshotPath,
    PROJECTION_GATEWAY_ORIGIN: projectionOrigin,
    SERVICE_AUTH_TOKEN: serviceToken,
  },
  "private-backend listening",
);

console.log("=== 3/4 build apps (production, CSP-compliant) ===");
await new Promise((resolve, reject) => {
  const build = spawn("bun", ["run", "build"], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  let out = "";
  build.stdout.on("data", (c) => {
    out += c;
    process.stdout.write(`[build] ${c}`);
  });
  build.stderr.on("data", (c) => {
    out += c;
  });
  build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${out.slice(-800)}`))));
});

console.log("=== 4/4 stage + console origins (serving dist, proxying /v1) ===");
await start(
  "stage",
  "bun",
  ["run", "tests/e2e/stage-origin.ts"],
  { PROJECTION_GATEWAY_ORIGIN: projectionOrigin, TOPOLOGY_STAGE_PORT: String(STAGE_PORT) },
  "stage-origin listening",
);
await start(
  "console",
  "bun",
  ["run", "tests/e2e/console-origin.ts"],
  { PRIVATE_BACKEND_ORIGIN: privateOrigin, TOPOLOGY_CONSOLE_PORT: String(CONSOLE_PORT) },
  "console-origin listening",
);

console.log("SYSTEM_UP");
console.log(`  private-backend    ${privateOrigin}`);
console.log(`  projection-gateway ${projectionOrigin}`);
console.log(`  stage              ${stageOrigin}`);
console.log(`  console            ${consoleOrigin}`);

const shutdown = () => {
  for (const { name, child } of children) {
    if (child.pid !== undefined) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      console.log(`stopped ${name}`);
    }
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 1 << 30);
