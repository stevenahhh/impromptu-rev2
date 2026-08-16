import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ServiceProcess = ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;

const processes: ServiceProcess[] = [];
const privateSnapshotPath = join(import.meta.dir, ".runtime-private-snapshot.json");
const projectionDatabasePath = join(import.meta.dir, ".runtime-projection-database.json");
const deckStagingRoot = join(import.meta.dir, ".runtime-deck-staging");
const deckArtifactRoot = join(import.meta.dir, ".runtime-deck-artifacts");

const RUNTIME_MANIFEST_HASH = "a".repeat(64);
const runtimeArtifactDir = join(deckArtifactRoot, RUNTIME_MANIFEST_HASH);
const runtimeOutsideSecret = join(import.meta.dir, ".runtime-deck-outside-secret.txt");

beforeAll(() => {
  mkdirSync(deckStagingRoot, { recursive: true });
  mkdirSync(runtimeArtifactDir, { recursive: true });
  writeFileSync(
    join(runtimeArtifactDir, "slide-01.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
  );
  writeFileSync(runtimeOutsideSecret, "not for public serving");
  symlinkSync(runtimeOutsideSecret, join(runtimeArtifactDir, "leak.svg"));
});

afterAll(() => {
  rmSync(deckStagingRoot, { force: true, recursive: true });
  rmSync(deckArtifactRoot, { force: true, recursive: true });
  rmSync(runtimeOutsideSecret, { force: true });
});

afterAll(() => {
  rmSync(deckStagingRoot, { force: true, recursive: true });
  rmSync(deckArtifactRoot, { force: true, recursive: true });
});

afterEach(async () => {
  for (const process of processes.splice(0).toReversed()) {
    process.kill();
    await process.exited;
  }
  rmSync(privateSnapshotPath, { force: true });
  rmSync(projectionDatabasePath, { force: true });
});

async function waitForOutput(
  stream: ReadableStream<Uint8Array>,
  expected: string,
  timeoutMs = 5_000,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const timeout = AbortSignal.timeout(timeoutMs);
  let output = "";
  try {
    while (!output.includes(expected)) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout.addEventListener(
            "abort",
            () => reject(new Error(`service did not emit ${expected}: ${output}`)),
            { once: true },
          );
        }),
      ]);
      if (next.done) throw new Error(`service exited before emitting ${expected}: ${output}`);
      output += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function startService(
  entrypoint: string,
  environment: Record<string, string>,
  expectedOutput: string,
): Promise<ServiceProcess> {
  const process = Bun.spawn<"ignore", "pipe", "pipe">({
    cmd: ["bun", "run", entrypoint],
    env: { ...Bun.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(process);
  await waitForOutput(process.stdout, expectedOutput);
  return process;
}

const consoleOrigin = "http://127.0.0.1:44173";
const stageOrigin = "http://127.0.0.1:44174";
const serviceToken = "runtime-route-token-alpha";

function browserHeaders(origin: string, csrfToken?: string, cookie?: string): HeadersInit {
  return {
    origin,
    referer: `${origin}/`,
    "content-type": "application/json",
    ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
    ...(cookie === undefined ? {} : { cookie }),
  };
}

describe("runnable WP3 service composition", () => {
  test("service mains compose dependencies for every WP3 route", async () => {
    rmSync(privateSnapshotPath, { force: true });
    rmSync(projectionDatabasePath, { force: true });
    await startService(
      "services/projection-gateway/src/main.ts",
      {
        PROJECTION_GATEWAY_HOST: "127.0.0.1",
        PROJECTION_GATEWAY_PORT: "44102",
        PROJECTION_DATABASE_PATH: projectionDatabasePath,
        PRIVATE_BACKEND_ORIGIN: "http://127.0.0.1:44101",
        SERVICE_AUTH_TOKEN: serviceToken,
        STAGE_ORIGIN: stageOrigin,
        DECK_ARTIFACT_ROOT: deckArtifactRoot,
      },
      "projection-gateway listening",
    );
    await startService(
      "services/private-backend/src/main.ts",
      {
        CONSOLE_ORIGIN: consoleOrigin,
        CONTROLLER_ACCOUNT_ID: "account_runtime",
        CONTROLLER_ACTOR_ID: "actor_runtime",
        CONTROLLER_AUTHORIZATION_CODE: "runtime-code",
        PRIVATE_BACKEND_HOST: "127.0.0.1",
        PRIVATE_BACKEND_PORT: "44101",
        PRIVATE_SNAPSHOT_PATH: privateSnapshotPath,
        PROJECTION_GATEWAY_ORIGIN: "http://127.0.0.1:44102",
        SERVICE_AUTH_TOKEN: serviceToken,
        DECK_STAGING_ROOT: deckStagingRoot,
        DECK_ARTIFACT_ROOT: deckArtifactRoot,
      },
      "private-backend listening",
    );

    const join = await fetch("http://127.0.0.1:44102/v1/display-joins", {
      method: "POST",
      headers: browserHeaders(stageOrigin),
      body: JSON.stringify({
        displayId: "display_runtime",
        deckVersion: "deck_runtime",
        displayFingerprint: "runtime-stage-fingerprint",
      }),
    });
    expect(join.status).toBe(201);
    const joinBody = await join.json();
    const claim = await fetch("http://127.0.0.1:44102/v1/display-session", {
      method: "POST",
      headers: browserHeaders(stageOrigin),
      body: JSON.stringify(joinBody),
    });
    expect(claim.status).not.toBe(404);
    const snapshot = await fetch("http://127.0.0.1:44102/v1/snapshot", {
      headers: { origin: stageOrigin },
    });
    expect(snapshot.status).not.toBe(404);
    const events = await fetch("http://127.0.0.1:44102/v1/events", {
      headers: { origin: stageOrigin },
    });
    expect(events.status).not.toBe(404);
    const applied = await fetch("http://127.0.0.1:44102/v1/stage-applied", {
      method: "POST",
      headers: browserHeaders(stageOrigin),
      body: JSON.stringify({}),
    });
    expect(applied.status).not.toBe(404);
    const deckAsset = await fetch(
      `http://127.0.0.1:44102/v1/deck-assets/${RUNTIME_MANIFEST_HASH}/slide-01.svg`,
      { headers: { origin: stageOrigin } },
    );
    expect(deckAsset.status).toBe(200);
    expect(deckAsset.headers.get("content-type")).toBe("image/svg+xml");
    expect(deckAsset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(deckAsset.headers.get("access-control-allow-origin")).toBe(stageOrigin);
    expect(await deckAsset.text()).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
    );
    const escapedAsset = await fetch(
      `http://127.0.0.1:44102/v1/deck-assets/${RUNTIME_MANIFEST_HASH}/leak.svg`,
      { headers: { origin: stageOrigin } },
    );
    expect(escapedAsset.status).toBe(403);
    expect(await escapedAsset.json()).toEqual({ error: "asset_escape_forbidden" });

    const signIn = await fetch("http://127.0.0.1:44101/v1/account-sessions", {
      method: "POST",
      headers: browserHeaders(consoleOrigin),
      body: JSON.stringify({ authorizationCode: "runtime-code" }),
    });
    expect(signIn.status).toBe(201);
    const accountCookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
    const signInBody = await signIn.json();
    if (accountCookie === undefined || typeof signInBody.csrfToken !== "string") {
      throw new Error("runtime sign-in did not issue cookie and CSRF token");
    }
    const authenticatedHeaders = browserHeaders(consoleOrigin, signInBody.csrfToken, accountCookie);
    const probes: readonly [string, string, unknown][] = [
      ["POST", "/v1/deck-artifacts", {}],
      ["POST", "/v1/presentation-sessions", {}],
      ["POST", "/v1/display-bindings", {}],
      ["POST", "/v1/playback/slide-set", {}],
      ["POST", "/v1/playback/lease-takeover", {}],
      ["POST", "/v1/recommendations", {}],
      ["POST", "/v1/candidates/curated", {}],
      ["POST", "/v1/candidates/live", {}],
      ["POST", "/v1/publications/approve", {}],
      ["POST", "/v1/publications/terminate", {}],
    ];
    for (const [method, path, body] of probes) {
      const response = await fetch(`http://127.0.0.1:44101${path}`, {
        method,
        headers: authenticatedHeaders,
        body: JSON.stringify(body),
      });
      expect(response.status).not.toBe(404);
    }
    const recommendation = await fetch("http://127.0.0.1:44101/v1/recommendations", {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({
        query: "revenue",
        deckVersion: "deck_v1",
        manifestHash: "a".repeat(64),
        maxResults: 3,
      }),
    });
    expect(recommendation.status).toBe(200);
    expect(await recommendation.json()).toMatchObject({
      outcome: "RECOMMEND",
      recommendation: { claim: "Acme revenue was 42 million USD in 2025." },
    });

    const controllerEvents = await fetch("http://127.0.0.1:44101/v1/playback/controller-events", {
      headers: { cookie: accountCookie, origin: consoleOrigin },
    });
    expect(controllerEvents.status).not.toBe(404);
    const accountSession = await fetch("http://127.0.0.1:44101/v1/account-session", {
      headers: { cookie: accountCookie, origin: consoleOrigin },
    });
    expect(accountSession.status).toBe(200);
  });
});
