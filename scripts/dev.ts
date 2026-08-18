import { developmentServices } from "./dev-services";

const children = developmentServices.map((service) => {
  console.log(`[dev] starting ${service.name} on http://localhost:${service.port}`);
  return Bun.spawn([...service.command], {
    cwd: service.cwd,
    env: { ...service.env, ...process.env },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
});

let stopping = false;

function stopChildren(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

process.once("SIGINT", stopChildren);
process.once("SIGTERM", stopChildren);

const result = await Promise.race(
  children.map(async (child, index) => ({
    exitCode: await child.exited,
    service: developmentServices[index]?.name ?? "unknown",
  })),
);

stopChildren();

if (result.exitCode !== 0) {
  console.error(`[dev] ${result.service} exited with code ${result.exitCode}`);
}

process.exitCode = result.exitCode;
