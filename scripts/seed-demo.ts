/**
 * Demo seed: registers the demo account and drives the real private-backend HTTP surface
 * (sign-in, deck upload, reference-document upload) through the same cookie + CSRF +
 * Origin/Referer contract a browser uses, so a fresh environment opens with one usable
 * presentation and reference material attached. Deliberately dependency-free: it mounts
 * into the production image as a single file and runs with the image's own `bun`.
 *
 * Env:
 *   PRIVATE_BACKEND_ORIGIN  backend base URL          (default http://127.0.0.1:3001)
 *   CONSOLE_ORIGIN          Origin/Referer to assert  (default http://localhost:4173)
 *   DEMO_USERNAME           demo account username     (default "demo")
 *   DEMO_PASSWORD           demo account password     (default "12341234")
 *   SAMPLES_DIR             directory with the assets (default ../docs/samples)
 *   SEED_TIMEOUT_MS         backend readiness deadline (default 120000)
 */

import { basename, join } from "node:path";

const backendOrigin = (process.env.PRIVATE_BACKEND_ORIGIN ?? "http://127.0.0.1:3001").replace(
  /\/$/,
  "",
);
const consoleOrigin = (process.env.CONSOLE_ORIGIN ?? "http://localhost:4173").replace(/\/$/, "");
const username = process.env.DEMO_USERNAME ?? "demo";
const password = process.env.DEMO_PASSWORD ?? "12341234";
const samplesDir = process.env.SAMPLES_DIR ?? join(import.meta.dir, "..", "docs", "samples");
const seedTimeoutMs = Number(process.env.SEED_TIMEOUT_MS ?? 120_000);

const deckFile = join(samplesDir, "impromptu-sample-deck.pdf");
const referenceFiles = [
  join(samplesDir, "reference", "impromptu-product-brief.md"),
  join(samplesDir, "reference", "impromptu-faq.md"),
];

function log(step: string, detail: string): void {
  console.log(`[seed-demo] ${step}: ${detail}`);
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + seedTimeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${backendOrigin}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`private-backend never became ready (last: ${lastError})`);
}

/** Same pre-auth mutation contract the browser hits: exact Origin and Referer. */
function entryHeaders(): Record<string, string> {
  return {
    Origin: consoleOrigin,
    Referer: `${consoleOrigin}/sign-in`,
    "content-type": "application/json",
  };
}

async function registerDemoAccount(): Promise<void> {
  const response = await fetch(`${backendOrigin}/v1/accounts`, {
    method: "POST",
    headers: entryHeaders(),
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 201) {
    log("account", `registered ${username}`);
    return;
  }
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (response.status === 409 || body?.error === "USERNAME_TAKEN") {
    log("account", `${username} already exists`);
    return;
  }
  throw new Error(`registration failed: HTTP ${response.status} ${JSON.stringify(body)}`);
}

async function signIn(): Promise<{ cookie: string; csrfToken: string }> {
  const response = await fetch(`${backendOrigin}/v1/account-sessions`, {
    method: "POST",
    headers: entryHeaders(),
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 201) {
    throw new Error(`sign-in failed: HTTP ${response.status} ${await response.text()}`);
  }
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const body = (await response.json()) as { csrfToken?: string };
  if (cookie.length === 0 || typeof body.csrfToken !== "string") {
    throw new Error("sign-in response did not carry a session cookie and CSRF token");
  }
  return { cookie, csrfToken: body.csrfToken };
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

function authedHeaders(session: Session): Record<string, string> {
  return {
    Origin: consoleOrigin,
    Referer: `${consoleOrigin}/`,
    Cookie: session.cookie,
    "x-csrf-token": session.csrfToken,
  };
}

interface PresentationRow {
  readonly presentationSessionId: string;
  readonly title: string;
}

async function listPresentations(session: Session): Promise<readonly PresentationRow[]> {
  const rows: PresentationRow[] = [];
  let cursor: string | null = null;
  do {
    const suffix = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const response = await fetch(`${backendOrigin}/v1/presentations${suffix}`, {
      headers: { Cookie: session.cookie },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`presentation list failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      presentations?: PresentationRow[];
      nextCursor?: string | null;
    };
    rows.push(...(body.presentations ?? []));
    cursor = body.nextCursor ?? null;
  } while (cursor !== null);
  return rows;
}

async function uploadDeck(session: Session): Promise<string> {
  const file = Bun.file(deckFile);
  if (!(await file.exists())) throw new Error(`sample deck missing: ${deckFile}`);
  const form = new FormData();
  form.append(
    "file",
    new File([await file.arrayBuffer()], basename(deckFile), {
      type: "application/pdf",
    }),
  );
  const response = await fetch(`${backendOrigin}/v1/deck-uploads`, {
    method: "POST",
    headers: authedHeaders(session),
    body: form,
    signal: AbortSignal.timeout(300_000),
  });
  if (response.status !== 201) {
    throw new Error(`deck upload failed: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { presentationSessionId?: string };
  if (typeof body.presentationSessionId !== "string") {
    throw new Error("deck upload receipt did not carry a presentationSessionId");
  }
  return body.presentationSessionId;
}

async function uploadReferenceDocuments(
  session: Session,
  presentationSessionId: string,
): Promise<void> {
  const form = new FormData();
  form.append("presentationSessionId", presentationSessionId);
  for (const path of referenceFiles) {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`reference sample missing: ${path}`);
    form.append(
      "files",
      new File([await file.arrayBuffer()], basename(path), { type: "text/markdown" }),
    );
  }
  const response = await fetch(`${backendOrigin}/v1/reference-documents`, {
    method: "POST",
    headers: authedHeaders(session),
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json().catch(() => null)) as {
    outcome?: string;
    reason?: string;
  } | null;
  if (response.status !== 201 || body?.outcome !== "ACCEPTED") {
    throw new Error(`reference upload failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  log("reference", `${referenceFiles.length} documents attached`);
}

await waitReady();
await registerDemoAccount();
const session = await signIn();
log("session", "signed in");

// Idempotent: an environment that already has a seeded deck is left alone — uploads create a
// new presentation row every run and would otherwise pile up duplicates on each deploy.
const existing = await listPresentations(session);
if (existing.length > 0) {
  log("deck", `skipped; ${existing.length} presentation(s) already on the account`);
  process.exit(0);
}

const presentationSessionId = await uploadDeck(session);
log("deck", `uploaded ${basename(deckFile)} as ${presentationSessionId}`);
await uploadReferenceDocuments(session, presentationSessionId);
log("done", `demo account ${username} is ready`);
