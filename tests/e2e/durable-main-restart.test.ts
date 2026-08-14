import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

type ServiceProcess = ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
const processes: ServiceProcess[] = [];
const privateSnapshotPath = join(import.meta.dir, ".restart-private-snapshot.json");
const projectionDatabasePath = join(import.meta.dir, ".restart-projection-database.json");
const privateOrigin = "http://127.0.0.1:44301";
const projectionOrigin = "http://127.0.0.1:44302";
const consoleOrigin = "http://127.0.0.1:44373";
const stageOrigin = "http://127.0.0.1:44374";
const serviceToken = "durable-main-restart-token";

async function waitForOutput(stream: ReadableStream<Uint8Array>, expected: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const signal = AbortSignal.timeout(5_000);
  let output = "";
  try {
    while (!output.includes(expected)) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error(output)), { once: true });
        }),
      ]);
      if (next.done) throw new Error(`service exited: ${output}`);
      output += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function start(entrypoint: string, environment: Record<string, string>, ready: string) {
  const process = Bun.spawn<"ignore", "pipe", "pipe">({
    cmd: ["bun", "run", entrypoint],
    env: { ...Bun.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(process);
  await waitForOutput(process.stdout, ready);
  return process;
}

async function stop(process: ServiceProcess): Promise<void> {
  const index = processes.indexOf(process);
  if (index >= 0) processes.splice(index, 1);
  process.kill();
  await process.exited;
}

function headers(origin: string, csrfToken?: string, cookie?: string): HeadersInit {
  return {
    origin,
    referer: `${origin}/`,
    "content-type": "application/json",
    ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
    ...(cookie === undefined ? {} : { cookie }),
  };
}

const projectionEnvironment = {
  PRIVATE_BACKEND_ORIGIN: privateOrigin,
  PROJECTION_DATABASE_PATH: projectionDatabasePath,
  PROJECTION_GATEWAY_HOST: "127.0.0.1",
  PROJECTION_GATEWAY_PORT: "44302",
  SERVICE_AUTH_TOKEN: serviceToken,
  STAGE_ORIGIN: stageOrigin,
};
const privateEnvironment = {
  CONSOLE_ORIGIN: consoleOrigin,
  CONTROLLER_ACCOUNT_ID: "account_restart",
  CONTROLLER_ACTOR_ID: "actor_restart",
  CONTROLLER_AUTHORIZATION_CODE: "restart-code",
  PRIVATE_BACKEND_HOST: "127.0.0.1",
  PRIVATE_BACKEND_PORT: "44301",
  PRIVATE_SNAPSHOT_PATH: privateSnapshotPath,
  PROJECTION_GATEWAY_ORIGIN: projectionOrigin,
  SERVICE_AUTH_TOKEN: serviceToken,
};

afterEach(async () => {
  for (const process of processes.splice(0).toReversed()) await stop(process);
  rmSync(privateSnapshotPath, { force: true });
  rmSync(projectionDatabasePath, { force: true });
});

describe("durable service-main restore boundary", () => {
  test("restores account, presentation, binding, and an unclaimed display session", async () => {
    rmSync(privateSnapshotPath, { force: true });
    rmSync(projectionDatabasePath, { force: true });
    let projection = await start(
      "services/projection-gateway/src/main.ts",
      projectionEnvironment,
      "projection-gateway listening",
    );
    let privateBackend = await start(
      "services/private-backend/src/main.ts",
      privateEnvironment,
      "private-backend listening",
    );

    const signIn = await fetch(`${privateOrigin}/v1/account-sessions`, {
      method: "POST",
      headers: headers(consoleOrigin),
      body: JSON.stringify({ authorizationCode: "restart-code" }),
    });
    const signInBody = await signIn.json();
    const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined || typeof signInBody.csrfToken !== "string") {
      throw new Error("sign-in fixture failed");
    }
    const authenticatedHeaders = headers(consoleOrigin, signInBody.csrfToken, cookie);
    const upload = await fetch(`${privateOrigin}/v1/deck-artifacts`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({ title: "Restart deck", content: "durable restart" }),
    });
    const artifacts = await upload.json();
    const presentationResponse = await fetch(`${privateOrigin}/v1/presentation-sessions`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({
        privateDeck: artifacts.privateDeck,
        publicDeck: artifacts.publicDeck,
      }),
    });
    const presentation = await presentationResponse.json();
    const joinResponse = await fetch(`${projectionOrigin}/v1/display-joins`, {
      method: "POST",
      headers: headers(stageOrigin),
      body: JSON.stringify({
        displayId: "display_restart",
        deckVersion: artifacts.publicDeck.deckVersion,
        displayFingerprint: "restart-display-fingerprint",
      }),
    });
    const join = await joinResponse.json();
    const binding = await fetch(`${privateOrigin}/v1/display-bindings`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({
        presentationSessionId: presentation.lifecycle.presentationSessionId,
        displayJoinId: join.displayJoinId,
        expectedDisplayBindingEpoch: "dbe_0",
        expectedDeckVersion: artifacts.publicDeck.deckVersion,
        approvedDisplayId: join.displayId,
        approvedDisplayFingerprint: join.displayFingerprint,
      }),
    });
    expect(binding.status).toBe(201);

    await stop(privateBackend);
    privateBackend = await start(
      "services/private-backend/src/main.ts",
      privateEnvironment,
      "private-backend listening",
    );
    const accountAfterPrivateRestart = await fetch(`${privateOrigin}/v1/account-session`, {
      headers: { cookie, origin: consoleOrigin },
    });
    expect(accountAfterPrivateRestart.status).toBe(200);
    expect((await accountAfterPrivateRestart.json()).csrfToken).toBe(signInBody.csrfToken);

    await stop(projection);
    projection = await start(
      "services/projection-gateway/src/main.ts",
      projectionEnvironment,
      "projection-gateway listening",
    );
    const claimAfterProjectionRestart = await fetch(`${projectionOrigin}/v1/display-session`, {
      method: "POST",
      headers: headers(stageOrigin),
      body: JSON.stringify(join),
    });
    expect(claimAfterProjectionRestart.status).toBe(201);
    expect((await claimAfterProjectionRestart.json()).binding.displayBindingEpoch).toBe("dbe_1");

    void privateBackend;
    void projection;
  });
});
