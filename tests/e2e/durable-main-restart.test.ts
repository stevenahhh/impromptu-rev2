import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
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
const privateDatabaseUrl = Bun.env.PRIVATE_DATABASE_URL;
const projectionDatabaseUrl = Bun.env.PROJECTION_DATABASE_URL;
if (privateDatabaseUrl === undefined || projectionDatabaseUrl === undefined) {
  throw new Error("PRIVATE_DATABASE_URL and PROJECTION_DATABASE_URL are required");
}
const privateSql = new Bun.SQL(privateDatabaseUrl);
const projectionSql = new Bun.SQL(projectionDatabaseUrl);

afterAll(async () => {
  await Promise.all([privateSql.close(), projectionSql.close()]);
});

async function privateSnapshot(): Promise<unknown> {
  const rows = await privateSql<readonly Readonly<{ snapshot: unknown }>[]>`
    SELECT snapshot FROM private_app.prepared_evidence_state WHERE state_key = ${privateSnapshotPath}
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("private snapshot fixture missing");
  return row.snapshot;
}

async function projectionSnapshot(): Promise<unknown> {
  const rows = await projectionSql<readonly Readonly<{ snapshot: unknown }>[]>`
    SELECT snapshot FROM public_projection.gateway_state WHERE state_key = ${projectionDatabasePath}
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("projection snapshot fixture missing");
  return row.snapshot;
}

async function writePrivateSnapshot(snapshot: unknown): Promise<void> {
  await privateSql`
    UPDATE private_app.prepared_evidence_state SET snapshot = ${snapshot}::jsonb
    WHERE state_key = ${privateSnapshotPath}
  `;
}

async function writeProjectionSnapshot(snapshot: unknown): Promise<void> {
  await projectionSql`
    UPDATE public_projection.gateway_state SET snapshot = ${snapshot}::jsonb
    WHERE state_key = ${projectionDatabasePath}
  `;
}
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
  tamperCase: string,
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
          () => reject(new Error(`${entrypoint} did not reject its snapshot: ${tamperCase}`)),
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
  PROJECTION_GATEWAY_STATE_KEY: projectionDatabasePath,
  PROJECTION_GATEWAY_HOST: "127.0.0.1",
  PROJECTION_GATEWAY_PORT: String(projectionPort),
  SERVICE_AUTH_TOKEN: serviceToken,
  STAGE_ORIGIN: stageOrigin,
  DECK_ARTIFACT_ROOT: deckArtifactRoot,
};
const privateEnvironment = {
  CONSOLE_ORIGIN: consoleOrigin,
  CONTROLLER_ACCOUNT_ID: "account_restart",
  CONTROLLER_USERNAME: "restart",
  CONTROLLER_PASSWORD: "restart-password",
  CHAT_MODEL_API_KEY: "e2e-provider-key",
  EMBEDDING_MODEL_API_KEY: "e2e-provider-key",
  CHAT_MODEL_BASE_URL: "https://models.example.test/v1",
  EMBEDDING_MODEL_BASE_URL: "https://embeddings.example.test/v1",
  EMBEDDING_MODEL: "embedding-test",
  RERANK_MODEL: "rerank-test",
  LLM_MODEL: "llm-test",
  VERIFIER_MODEL: "verifier-test",
  PRIVATE_BACKEND_HOST: "127.0.0.1",
  PRIVATE_BACKEND_PORT: String(privatePort),
  PRIVATE_PREPARED_EVIDENCE_STATE_KEY: privateSnapshotPath,
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
  await Promise.all([
    privateSql`DELETE FROM private_app.prepared_evidence_state WHERE state_key = ${privateSnapshotPath}`,
    projectionSql`DELETE FROM public_projection.gateway_state WHERE state_key = ${projectionDatabasePath}`,
  ]);
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
      body: JSON.stringify({ username: "restart", password: "restart-password" }),
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
    // Stage is slide-only: both publication transitions are permanently closed, so the durable
    // restore boundary must survive without any public card ever existing.
    expect(publishedResponse.status).toBe(410);
    expect((await publishedResponse.json()).error).toBe("stage_cards_disabled");
    const terminated = await fetch(`${privateOrigin}/v1/publications/terminate`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({
        presentationSessionId: presentation.lifecycle.presentationSessionId,
        projectionId: "projection_never_published",
        expectedPublicCardRevision: "pcr_1",
        authorityId: presentation.authority.authorityId,
        status: "RETRACTED",
      }),
    });
    expect(terminated.status).toBe(410);
    expect((await terminated.json()).error).toBe("stage_cards_disabled");

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
    const displayCookie = claimAfterProjectionRestart.headers.get("set-cookie")?.split(";", 1)[0];
    if (displayCookie === undefined) throw new Error("display session cookie missing");
    const restoredSession = await claimAfterProjectionRestart.json();
    expect(restoredSession.binding.displayBindingEpoch).toBe("dbe_1");

    // Slide-only contract: the restored public projection carries slides and playback state only,
    // and never resurrects a card even though a curated candidate exists on the private side.
    const stageSnapshot = await fetch(
      `${projectionOrigin}/v1/snapshot?${new URLSearchParams({
        role: "PUBLIC_STAGE",
        presentationSessionEpoch: restoredSession.binding.presentationSessionEpoch,
        displayBindingEpoch: restoredSession.binding.displayBindingEpoch,
        deckVersion: artifacts.publicDeck.deckVersion,
        manifestHash: artifacts.publicDeck.manifestHash,
      })}`,
      { headers: { origin: stageOrigin, cookie: displayCookie } },
    );
    expect(stageSnapshot.status).toBe(200);
    const stageSnapshotBody = await stageSnapshot.json();
    expect(stageSnapshotBody.cards).toEqual([]);
    expect(stageSnapshotBody.tombstones).toEqual([]);
    expect(stageSnapshotBody.deck.slides.length).toBeGreaterThan(0);

    await stop(privateBackend);
    await stop(projection);
    const privateBaseline = await privateSnapshot();
    const projectionBaseline = await projectionSnapshot();

    const unsafeOccurrence = structuredClone(projectionBaseline) as {
      projections: Array<{ occurrence: { occurrenceSeq: number } }>;
    };
    const unsafeProjection = unsafeOccurrence.projections[0];
    if (unsafeProjection === undefined) throw new Error("projection snapshot fixture missing");
    unsafeProjection.occurrence.occurrenceSeq = Number.MAX_SAFE_INTEGER + 1;
    await writeProjectionSnapshot(unsafeOccurrence);
    await expectRejectedStartup(
      "services/projection-gateway/src/main.ts",
      projectionEnvironment,
      "ProjectionGatewaySnapshotError",
      "unsafe occurrence sequence",
    );

    // Card and tombstone history no longer exists in the public projection, so the surviving
    // slide-only integrity claim is that a restored occurrence must still name a deck slide.
    const forgedOccurrenceSlide = structuredClone(projectionBaseline) as {
      projections: Array<{ occurrence: { publicSlideKey: string } }>;
    };
    const forgedProjection = forgedOccurrenceSlide.projections[0];
    if (forgedProjection === undefined) throw new Error("projection snapshot fixture missing");
    forgedProjection.occurrence.publicSlideKey = "slide_not_in_deck";
    await writeProjectionSnapshot(forgedOccurrenceSlide);
    await expectRejectedStartup(
      "services/projection-gateway/src/main.ts",
      projectionEnvironment,
      "ProjectionGatewaySnapshotError",
      "occurrence slide outside the deck",
    );

    await writeProjectionSnapshot(projectionBaseline);
    const mismatchedCandidateHash = structuredClone(privateBaseline) as {
      presentations: Array<{
        candidates: Array<{ lifecycle: { contentHash: string } }>;
      }>;
    };
    const hashCandidate = mismatchedCandidateHash.presentations[0]?.candidates[0];
    if (hashCandidate === undefined) throw new Error("private candidate fixture missing");
    hashCandidate.lifecycle.contentHash = "f".repeat(64);
    await writePrivateSnapshot(mismatchedCandidateHash);
    await expectRejectedStartup(
      "services/private-backend/src/main.ts",
      privateEnvironment,
      "PreparedEvidenceSnapshotError",
      "forged candidate content hash",
    );

    await writePrivateSnapshot(privateBaseline);
    const mismatchedCandidateVersion = structuredClone(privateBaseline) as {
      presentations: Array<{
        candidates: Array<{ lifecycle: { candidateVersion: string } }>;
      }>;
    };
    const versionCandidate = mismatchedCandidateVersion.presentations[0]?.candidates[0];
    if (versionCandidate === undefined) throw new Error("private candidate fixture missing");
    versionCandidate.lifecycle.candidateVersion = "candidate-version-forged";
    await writePrivateSnapshot(mismatchedCandidateVersion);
    await expectRejectedStartup(
      "services/private-backend/src/main.ts",
      privateEnvironment,
      "PreparedEvidenceSnapshotError",
      "forged candidate version",
    );
  });
});
