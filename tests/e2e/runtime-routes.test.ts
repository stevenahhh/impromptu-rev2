import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

type ServiceProcess = ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;

// Coordinator and gateway state live in PostgreSQL keyed by these strings, so each run gets a
// unique key: a fixed key would restore previous runs' state and grow the rows without bound.
const runNonce = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const privateStateKey = `impromptu-r2-runtime-${runNonce}-private`;
const projectionStateKey = `impromptu-r2-runtime-${runNonce}-projection`;

const processes: ServiceProcess[] = [];
const deckStagingRoot = join(import.meta.dir, ".runtime-deck-staging");
const deckArtifactRoot = join(import.meta.dir, ".runtime-deck-artifacts");

const RUNTIME_MANIFEST_HASH = "a".repeat(64);
const runtimeArtifactDir = join(deckArtifactRoot, RUNTIME_MANIFEST_HASH);
const runtimeOutsideSecret = join(import.meta.dir, ".runtime-deck-outside-secret.txt");

beforeAll(() => {
  mkdirSync(deckStagingRoot, { recursive: true });
  mkdirSync(join(runtimeArtifactDir, "slides"), { recursive: true });
  mkdirSync(join(runtimeArtifactDir, "fonts"), { recursive: true });
  writeFileSync(
    join(runtimeArtifactDir, "slides", "slide-01.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
  );
  writeFileSync(join(runtimeArtifactDir, "fonts", "Family.ttf"), new Uint8Array([0, 1, 0, 0]));
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
  await deleteRuntimeStateRows();
});

/**
 * Removes this run's coordinator and gateway state rows so repeated runs cannot accumulate
 * abandoned snapshots in the shared test databases. Best effort: a failed cleanup must not mask
 * the test result, and the row is keyed uniquely per run so it can never leak into another run.
 */
async function deleteRuntimeStateRows(): Promise<void> {
  const targets: readonly { readonly url: string; readonly key: string; readonly table: string }[] =
    [
      {
        url: globalThis.process.env.PRIVATE_DATABASE_URL ?? "",
        key: privateStateKey,
        table: "private_app.prepared_evidence_state",
      },
      {
        url: globalThis.process.env.PROJECTION_DATABASE_URL ?? "",
        key: projectionStateKey,
        table: "public_projection.gateway_state",
      },
    ];
  for (const target of targets) {
    if (target.url.length === 0) continue;
    try {
      const sql = new SQL(target.url);
      try {
        if (target.table === "private_app.prepared_evidence_state") {
          await sql`DELETE FROM private_app.prepared_evidence_state WHERE state_key = ${target.key}`;
        } else {
          await sql`DELETE FROM public_projection.gateway_state WHERE state_key = ${target.key}`;
        }
      } finally {
        await sql.close({ timeout: 1 }).catch(() => undefined);
      }
    } catch {
      // Leave the row; it is unreachable for other runs because the key is unique per run.
    }
  }
}

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
    await startService(
      "services/projection-gateway/src/main.ts",
      {
        PROJECTION_GATEWAY_HOST: "127.0.0.1",
        PROJECTION_GATEWAY_PORT: "44102",
        PROJECTION_GATEWAY_STATE_KEY: projectionStateKey,
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
        CONTROLLER_USERNAME: "runtime",
        CONTROLLER_PASSWORD: "runtime-password",
        CHAT_MODEL_API_KEY: "e2e-provider-key",
        EMBEDDING_MODEL_API_KEY: "e2e-provider-key",
        CHAT_MODEL_BASE_URL: "https://models.example.test/v1",
        EMBEDDING_MODEL_BASE_URL: "https://embeddings.example.test/v1",
        EMBEDDING_MODEL: "embedding-test",
        RERANK_MODEL: "rerank-test",
        LLM_MODEL: "llm-test",
        VERIFIER_MODEL: "verifier-test",
        PRIVATE_BACKEND_HOST: "127.0.0.1",
        PRIVATE_BACKEND_PORT: "44101",
        PRIVATE_PREPARED_EVIDENCE_STATE_KEY: privateStateKey,
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
      `http://127.0.0.1:44102/v1/deck-assets/${RUNTIME_MANIFEST_HASH}/slides/slide-01.svg`,
      { headers: { origin: stageOrigin } },
    );
    expect(deckAsset.status).toBe(200);
    expect(deckAsset.headers.get("content-type")).toBe("image/svg+xml");
    expect(deckAsset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(deckAsset.headers.get("access-control-allow-origin")).toBe(stageOrigin);
    expect(await deckAsset.text()).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
    );
    const nestedFont = await fetch(
      `http://127.0.0.1:44102/v1/deck-assets/${RUNTIME_MANIFEST_HASH}/fonts/Family.ttf`,
      { headers: { origin: stageOrigin } },
    );
    expect(nestedFont.status).toBe(200);
    expect(nestedFont.headers.get("content-type")).toBe("font/ttf");
    expect(new Uint8Array(await nestedFont.arrayBuffer())).toEqual(new Uint8Array([0, 1, 0, 0]));
    const escapedAsset = await fetch(
      `http://127.0.0.1:44102/v1/deck-assets/${RUNTIME_MANIFEST_HASH}/leak.svg`,
      { headers: { origin: stageOrigin } },
    );
    expect(escapedAsset.status).toBe(403);
    expect(await escapedAsset.json()).toEqual({ error: "asset_escape_forbidden" });

    const signIn = await fetch("http://127.0.0.1:44101/v1/account-sessions", {
      method: "POST",
      headers: browserHeaders(consoleOrigin),
      body: JSON.stringify({ username: "runtime", password: "runtime-password" }),
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
      outcome: "ABSTAIN",
      reason: "MODEL_FAILURE",
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
