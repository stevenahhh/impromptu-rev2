import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";

type ServiceProcess = ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
const processes: ServiceProcess[] = [];
async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("ephemeral port missing");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

const privateSnapshotPath = join(import.meta.dir, ".restart-private-snapshot.json");
const projectionDatabasePath = join(import.meta.dir, ".restart-projection-database.json");
const deckStagingRoot = join(import.meta.dir, ".restart-deck-staging");
const deckArtifactRoot = join(import.meta.dir, ".restart-deck-artifacts");
const privatePort = await availablePort();
const projectionPort = await availablePort();
const privateOrigin = `http://127.0.0.1:${privatePort}`;
const projectionOrigin = `http://127.0.0.1:${projectionPort}`;
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

async function expectRejectedStartup(
  entrypoint: string,
  environment: Record<string, string>,
  expectedErrorType: string,
): Promise<void> {
  const process = Bun.spawn<"ignore", "pipe", "pipe">({
    cmd: ["bun", "run", entrypoint],
    env: { ...Bun.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(process);
  const [exitCode, stdout, stderr] = await Promise.all([
    Promise.race([
      process.exited,
      new Promise<never>((_resolve, reject) => {
        AbortSignal.timeout(5_000).addEventListener(
          "abort",
          () => reject(new Error(`${entrypoint} did not reject its snapshot`)),
          { once: true },
        );
      }),
    ]),
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(exitCode).not.toBe(0);
  expect(stdout).not.toContain("listening");
  expect(stderr).toContain(expectedErrorType);
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
  PROJECTION_GATEWAY_PORT: String(projectionPort),
  SERVICE_AUTH_TOKEN: serviceToken,
  STAGE_ORIGIN: stageOrigin,
};
const privateEnvironment = {
  CONSOLE_ORIGIN: consoleOrigin,
  CONTROLLER_ACCOUNT_ID: "account_restart",
  CONTROLLER_ACTOR_ID: "actor_restart",
  CONTROLLER_AUTHORIZATION_CODE: "restart-code",
  PRIVATE_BACKEND_HOST: "127.0.0.1",
  PRIVATE_BACKEND_PORT: String(privatePort),
  PRIVATE_SNAPSHOT_PATH: privateSnapshotPath,
  PROJECTION_GATEWAY_ORIGIN: projectionOrigin,
  SERVICE_AUTH_TOKEN: serviceToken,
  DECK_STAGING_ROOT: deckStagingRoot,
  DECK_ARTIFACT_ROOT: deckArtifactRoot,
};

afterEach(async () => {
  for (const process of processes.splice(0).toReversed()) await stop(process);
  rmSync(privateSnapshotPath, { force: true });
  rmSync(projectionDatabasePath, { force: true });
  rmSync(deckStagingRoot, { recursive: true, force: true });
  rmSync(deckArtifactRoot, { recursive: true, force: true });
});

describe("durable service-main restore boundary", () => {
  test("restores account, presentation, binding, and an unclaimed display session", async () => {
    rmSync(privateSnapshotPath, { force: true });
    rmSync(projectionDatabasePath, { force: true });
    mkdirSync(deckStagingRoot, { recursive: true });
    mkdirSync(deckArtifactRoot, { recursive: true });
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
    const candidateId = "candidate_restart_terminal";
    const candidate = await fetch(`${privateOrigin}/v1/candidates/curated`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({
        candidateId,
        candidateVersion: "candidate-version-restart",
        provenance: "CURATED_PREAPPROVED",
        verdict: "SUPPORTED",
        claimText: "Restart terminal claim",
        evidenceExcerpt: "Restart terminal support",
        privateSourceUri: "private://restart/terminal",
        causal: {
          presentationSessionId: presentation.lifecycle.presentationSessionId,
          presentationSessionEpoch: "pse_1",
          displayBindingEpoch: "dbe_1",
          deckVersion: artifacts.publicDeck.deckVersion,
          manifestHash: artifacts.publicDeck.manifestHash,
          occurrence: {
            publicSlideKey: artifacts.publicDeck.slides[0].publicSlideKey,
            occurrenceSeq: 1,
          },
          transcriptFinalId: null,
          source: {
            sourceId: "source_restart_terminal",
            revision: "source-revision-1",
            contentHash: artifacts.sourceHash,
          },
          decisions: {
            acl: "acl-1",
            publicationPolicy: "publication-policy-1",
            rights: "rights-1",
            dlp: "dlp-1",
          },
        },
      }),
    });
    expect(candidate.status).toBe(201);
    const publishedResponse = await fetch(`${privateOrigin}/v1/publications/approve`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({
        presentationSessionId: presentation.lifecycle.presentationSessionId,
        candidateId,
        expectedCandidateRevision: "candrev_1",
        expectedPublicCardRevision: "pcr_0",
        authorityId: presentation.authority.authorityId,
        expiresAtMs: null,
      }),
    });
    expect(publishedResponse.status).toBe(201);
    const published = await publishedResponse.json();
    const terminated = await fetch(`${privateOrigin}/v1/publications/terminate`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({
        presentationSessionId: presentation.lifecycle.presentationSessionId,
        projectionId: published.projectionId,
        expectedPublicCardRevision: "pcr_1",
        authorityId: presentation.authority.authorityId,
        status: "RETRACTED",
      }),
    });
    expect(terminated.status).toBe(200);

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

    await stop(privateBackend);
    await stop(projection);
    const privateBaseline: unknown = JSON.parse(readFileSync(privateSnapshotPath, "utf8"));
    const projectionBaseline: unknown = JSON.parse(readFileSync(projectionDatabasePath, "utf8"));

    const unsafeOccurrence = structuredClone(projectionBaseline) as {
      projections: Array<{ occurrence: { occurrenceSeq: number } }>;
    };
    const unsafeProjection = unsafeOccurrence.projections[0];
    if (unsafeProjection === undefined) throw new Error("projection snapshot fixture missing");
    unsafeProjection.occurrence.occurrenceSeq = Number.MAX_SAFE_INTEGER + 1;
    writeFileSync(projectionDatabasePath, JSON.stringify(unsafeOccurrence));
    await expectRejectedStartup(
      "services/projection-gateway/src/main.ts",
      projectionEnvironment,
      "ProjectionGatewaySnapshotError",
    );

    const strippedTerminalHistory = structuredClone(projectionBaseline) as {
      projections: Array<{ tombstones: unknown[] }>;
    };
    const strippedProjection = strippedTerminalHistory.projections[0];
    if (strippedProjection === undefined) throw new Error("projection snapshot fixture missing");
    strippedProjection.tombstones = [];
    writeFileSync(projectionDatabasePath, JSON.stringify(strippedTerminalHistory));
    await expectRejectedStartup(
      "services/projection-gateway/src/main.ts",
      projectionEnvironment,
      "ProjectionGatewaySnapshotError",
    );

    const mismatchedCandidateHash = structuredClone(privateBaseline) as {
      presentations: Array<{
        candidates: Array<{ lifecycle: { contentHash: string } }>;
      }>;
    };
    const hashCandidate = mismatchedCandidateHash.presentations[0]?.candidates[0];
    if (hashCandidate === undefined) throw new Error("private candidate fixture missing");
    hashCandidate.lifecycle.contentHash = "f".repeat(64);
    writeFileSync(privateSnapshotPath, JSON.stringify(mismatchedCandidateHash));
    await expectRejectedStartup(
      "services/private-backend/src/main.ts",
      privateEnvironment,
      "PreparedEvidenceSnapshotError",
    );

    const mismatchedCandidateVersion = structuredClone(privateBaseline) as {
      presentations: Array<{
        candidates: Array<{ lifecycle: { candidateVersion: string } }>;
      }>;
    };
    const versionCandidate = mismatchedCandidateVersion.presentations[0]?.candidates[0];
    if (versionCandidate === undefined) throw new Error("private candidate fixture missing");
    versionCandidate.lifecycle.candidateVersion = "candidate-version-forged";
    writeFileSync(privateSnapshotPath, JSON.stringify(mismatchedCandidateVersion));
    await expectRejectedStartup(
      "services/private-backend/src/main.ts",
      privateEnvironment,
      "PreparedEvidenceSnapshotError",
    );
  });
});
