/**
 * Production-main integration contract for authenticated deck uploads.
 *
 * Spawns services/private-backend/src/main.ts with a real staging/artifact
 * root, the repo-relative ingestion project default, and a fake `uv` CLI on
 * PATH standing in for the ingestion renderer (the only external executable
 * behind the real Bun-spawn subprocess adapter). Exercises the closed
 * production chain end to end:
 *
 *   POST /v1/deck-uploads -> http.ts -> deck-upload-service ->
 *   createDeckUploadWorker (real streaming staging + immutable artifact
 *   promotion) -> createDeckRenderSubprocess (real uv argv + strict
 *   render.json schema) -> renderedDeckArtifacts -> receipt + presentation
 *   session persisted in the private snapshot.
 *
 * Startup must fail closed: missing/invalid DECK_STAGING_ROOT,
 * DECK_ARTIFACT_ROOT, INGESTION_PROJECT_PATH, and DECK_RENDER_DEADLINE_MS
 * refuse to boot before the server listens.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateDeckContextSchema } from "@impromptu/contracts/private";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";

type ServiceProcess = ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
const processes: ServiceProcess[] = [];
const fixtureRoots: string[] = [];

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PPTX_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const PDF_CONTENT_TYPE = "application/pdf";
const PDF_MAGIC = new TextEncoder().encode("%PDF-1.7\nmain integration fixture");

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

function waitForOutput(stream: ReadableStream<Uint8Array>, expected: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const signal = AbortSignal.timeout(10_000);
  let output = "";
  return new Promise<void>((resolve, reject) => {
    const poll = async () => {
      try {
        while (!output.includes(expected)) {
          const next = await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, rejectWith) => {
              signal.addEventListener(
                "abort",
                () =>
                  rejectWith(
                    new Error(`service did not emit ${expected}; saw: ${output || "(none)"}`),
                  ),
                { once: true },
              );
            }),
          ]);
          if (next.done) throw new Error(`service exited before emitting ${expected}: ${output}`);
          output += decoder.decode(next.value, { stream: true });
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    void poll();
  });
}

async function startMain(environment: Record<string, string>, ready = "private-backend listening") {
  const process = Bun.spawn<"ignore", "pipe", "pipe">({
    cmd: ["bun", "run", "src/main.ts"],
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
  environment: Record<string, string>,
  expectedError: string,
): Promise<void> {
  const process = Bun.spawn<"ignore", "pipe", "pipe">({
    cmd: ["bun", "run", "src/main.ts"],
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
        AbortSignal.timeout(4_000).addEventListener(
          "abort",
          () => reject(new Error(`main did not reject startup for ${expectedError}`)),
          { once: true },
        );
      }),
    ]),
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(exitCode).not.toBe(0);
  expect(stdout).not.toContain("listening");
  expect(stderr).toContain(expectedError);
}

interface MainFixture {
  readonly stagingRoot: string;
  readonly artifactRoot: string;
  readonly snapshotPath: string;
  readonly binDir: string;
  readonly privateOrigin: string;
  readonly projectionOrigin: string;
  readonly consoleOrigin: string;
}

async function fixture(): Promise<MainFixture> {
  const root = mkdtempSync(join(tmpdir(), "deck-upload-main-"));
  fixtureRoots.push(root);
  const stagingRoot = join(root, "staging");
  const artifactRoot = join(root, "artifacts");
  const binDir = join(root, "bin");
  mkdirSync(stagingRoot);
  mkdirSync(artifactRoot);
  mkdirSync(binDir);
  const privatePort = await availablePort();
  const projectionPort = await availablePort();
  const consolePort = await availablePort();
  return {
    stagingRoot,
    artifactRoot,
    snapshotPath: join(root, "snapshot.json"),
    binDir,
    privateOrigin: `http://127.0.0.1:${privatePort}`,
    projectionOrigin: `http://127.0.0.1:${projectionPort}`,
    consoleOrigin: `http://127.0.0.1:${consolePort}`,
  };
}

function baseEnvironment(fixtureInput: MainFixture): Record<string, string> {
  return {
    CONSOLE_ORIGIN: fixtureInput.consoleOrigin,
    CONTROLLER_ACCOUNT_ID: "account_deck_main",
    CONTROLLER_ACTOR_ID: "actor_deck_main",
    CONTROLLER_AUTHORIZATION_CODE: "deck-main-code",
    PRIVATE_BACKEND_HOST: "127.0.0.1",
    PRIVATE_BACKEND_PORT: new URL(fixtureInput.privateOrigin).port,
    PRIVATE_SNAPSHOT_PATH: fixtureInput.snapshotPath,
    PROJECTION_GATEWAY_ORIGIN: fixtureInput.projectionOrigin,
    SERVICE_AUTH_TOKEN: "deck-main-token-for-integration-test",
    DECK_STAGING_ROOT: fixtureInput.stagingRoot,
    DECK_ARTIFACT_ROOT: fixtureInput.artifactRoot,
    DECK_RENDER_DEADLINE_MS: "5000",
    FAKE_UV_SOURCE_LOG: join(fixtureInput.binDir, "source-paths.log"),
    PATH: `${fixtureInput.binDir}:${process.env.PATH ?? ""}`,
  };
}

/** A fake `uv` that stands in for `uv run --project ... impromptu-ingestion render`. */
function installFakeUv(binDir: string): void {
  const script = `#!/usr/bin/env bash
set -euo pipefail
out=""
source_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-dir" ]; then out="$arg"; fi
  if [ "$prev" = "render" ]; then source_path="$arg"; fi
  prev="$arg"
done
if [ -z "$out" ]; then echo "fake-uv: --output-dir missing" >&2; exit 2; fi
if [ -z "$source_path" ]; then echo "fake-uv: render source missing" >&2; exit 2; fi
printf '%s\n' "$source_path" >> "$FAKE_UV_SOURCE_LOG"
mkdir -p "$out/slides"
cat > "$out/render.json" <<'JSON'
{"deck_id":"deck_${"a".repeat(64)}","renderer":{"name":"libreoffice","version":"7.6.5.2"},"slides":[{"slide_key":"slide_${"b".repeat(64)}","source_index":1,"relative_path":"slides/slide-1.svg","content_sha256":"${"c".repeat(64)}","width_points":960,"height_points":540}],"assets":[],"fonts":[],"timelines":[],"mapping_issues":[],"animation_eligible":true,"ineligible_reason":null}
JSON
printf '%s' '<svg xmlns="http://www.w3.org/2000/svg"/>' > "$out/slides/slide-1.svg"
exit 0
`;
  const path = join(binDir, "uv");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function browserHeaders(origin: string, csrfToken?: string, cookie?: string): HeadersInit {
  return {
    origin,
    referer: `${origin}/`,
    ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
    ...(cookie === undefined ? {} : { cookie }),
  };
}

async function signIn(origin: string, fixtureInput: MainFixture) {
  const response = await fetch(`${origin}/v1/account-sessions`, {
    method: "POST",
    headers: browserHeaders(fixtureInput.consoleOrigin),
    body: JSON.stringify({ authorizationCode: "deck-main-code" }),
  });
  expect(response.status).toBe(201);
  const session = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined || typeof session.csrfToken !== "string") {
    throw new Error("sign-in fixture failed");
  }
  return { cookie, csrfToken: session.csrfToken };
}

afterEach(async () => {
  for (const process of processes.splice(0).toReversed()) {
    process.kill();
    await process.exited;
  }
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production main deck upload wiring", () => {
  test("fails closed for missing or invalid deck roots, ingestion project, and render deadline", async () => {
    const fixtureInput = await fixture();
    const env = baseEnvironment(fixtureInput);
    installFakeUv(fixtureInput.binDir);

    const {
      DECK_STAGING_ROOT: _deckStagingRoot,
      DECK_ARTIFACT_ROOT: _deckArtifactRoot,
      ...withoutRoots
    } = env;
    await expectRejectedStartup(withoutRoots, "DECK_STAGING_ROOT is required");

    const stagingFile = join(fixtureInput.stagingRoot, "not-a-directory");
    writeFileSync(stagingFile, "file");
    await expectRejectedStartup(
      { ...env, DECK_STAGING_ROOT: stagingFile },
      "DECK_STAGING_ROOT must be an existing absolute directory",
    );

    const artifactFile = join(fixtureInput.artifactRoot, "not-a-directory");
    writeFileSync(artifactFile, "file");
    await expectRejectedStartup(
      { ...env, DECK_ARTIFACT_ROOT: artifactFile },
      "DECK_ARTIFACT_ROOT must be an existing absolute directory",
    );

    await expectRejectedStartup(
      { ...env, INGESTION_PROJECT_PATH: join(fixtureInput.stagingRoot, "missing-ingestion") },
      "INGESTION_PROJECT_PATH must be an existing absolute directory",
    );

    await expectRejectedStartup(
      { ...env, DECK_RENDER_DEADLINE_MS: "not-a-number" },
      "DECK_RENDER_DEADLINE_MS must be a positive integer",
    );
  });

  test("preserves validated PPTX and PDF suffixes through the production main renderer argv", async () => {
    const fixtureInput = await fixture();
    installFakeUv(fixtureInput.binDir);
    await startMain(baseEnvironment(fixtureInput));
    const { cookie, csrfToken } = await signIn(fixtureInput.privateOrigin, fixtureInput);

    for (const upload of [
      { contentType: PPTX_CONTENT_TYPE, body: PPTX_MAGIC, filename: "board-review.pptx" },
      { contentType: PDF_CONTENT_TYPE, body: PDF_MAGIC, filename: "board-handout.PDF" },
    ]) {
      const response = await fetch(`${fixtureInput.privateOrigin}/v1/deck-uploads`, {
        method: "POST",
        headers: {
          ...browserHeaders(fixtureInput.consoleOrigin, csrfToken, cookie),
          "Content-Type": upload.contentType,
          "Content-Length": String(upload.body.byteLength),
          "X-Filename": upload.filename,
        },
        body: upload.body,
      });
      expect(response.status, await response.text()).toBe(201);
    }

    const stagedSources = readFileSync(join(fixtureInput.binDir, "source-paths.log"), "utf8")
      .trim()
      .split("\n");
    expect(stagedSources).toHaveLength(2);
    expect(stagedSources.map((source) => source.split("/").at(-1))).toEqual([
      "upload.pptx",
      "upload.pdf",
    ]);
    expect(stagedSources.every((source) => source.startsWith(fixtureInput.stagingRoot))).toBe(true);
    expect(readdirSync(fixtureInput.stagingRoot)).toEqual([]);
  });

  test("accepts an authenticated raw upload through the real adapter chain and returns matching artifacts and session receipt", async () => {
    const fixtureInput = await fixture();
    installFakeUv(fixtureInput.binDir);
    const env = baseEnvironment(fixtureInput);
    // The default repo-relative ingestion project (services/ingestion) is used:
    // INGESTION_PROJECT_PATH is intentionally absent.

    const main = await startMain(env);
    expect(processes).toContain(main);

    const { cookie, csrfToken } = await signIn(fixtureInput.privateOrigin, fixtureInput);
    const response = await fetch(`${fixtureInput.privateOrigin}/v1/deck-uploads`, {
      method: "POST",
      headers: {
        ...browserHeaders(fixtureInput.consoleOrigin, csrfToken, cookie),
        "Content-Type": PPTX_CONTENT_TYPE,
        "Content-Length": String(PPTX_MAGIC.byteLength),
        "X-Filename": "quarterly-review.pptx",
      },
      body: PPTX_MAGIC,
    });

    expect(response.status).toBe(201);
    const receipt = await response.json();
    const privateDeck = PrivateDeckContextSchema.parse(receipt.privateDeck);
    const publicDeck = PublishedDeckArtifactSchema.parse(receipt.publicDeck);
    expect(receipt.sourceHash).toBe("a".repeat(64));
    expect(privateDeck.title).toBe("Quarterly review");
    expect(String(privateDeck.ownerAccountId)).toBe("account_deck_main");
    expect(publicDeck.title).toBe("Quarterly review");
    expect(publicDeck.slides).toHaveLength(1);

    // The receipt points at the immutable artifact the worker promoted.
    const artifactIds = readdirSync(fixtureInput.artifactRoot).filter(
      (entry) => !entry.endsWith(".part"),
    );
    expect(artifactIds).toHaveLength(1);
    const artifactId = artifactIds[0];
    if (artifactId === undefined) throw new Error("expected exactly one promoted artifact");
    expect(publicDeck.slides[0]?.image.url).toBe(
      `${fixtureInput.projectionOrigin}/v1/deck-assets/${artifactId}/slides/slide-1.svg`,
    );
    const promotedManifest = JSON.parse(
      readFileSync(join(fixtureInput.artifactRoot, artifactId, "render.json"), "utf8"),
    );
    expect(promotedManifest.deck_id).toBe(`deck_${"a".repeat(64)}`);
    expect(readdirSync(fixtureInput.stagingRoot)).toEqual([]);
    expect(
      readdirSync(fixtureInput.artifactRoot).filter((entry) => entry.endsWith(".part")),
    ).toEqual([]);

    // The presentation session was created and persisted in the private snapshot.
    const snapshot = JSON.parse(readFileSync(fixtureInput.snapshotPath, "utf8"));
    expect(snapshot.presentations).toHaveLength(1);
    expect(snapshot.presentations[0].publicDeck).toEqual(receipt.publicDeck);
    expect(snapshot.presentations[0].privateDeck).toEqual(receipt.privateDeck);
    expect(snapshot.presentations[0].lifecycle.deckVersion).toBe(publicDeck.deckVersion);
    expect(snapshot.presentations[0].lifecycle.ownerAccountId).toBe("account_deck_main");
  });
});
