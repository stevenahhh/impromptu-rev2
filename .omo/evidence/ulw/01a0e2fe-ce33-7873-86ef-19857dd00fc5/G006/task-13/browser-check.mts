/**
 * Task 13/32 browser verification: drives the real Stage production bundle (vite preview,
 * same-origin /v1 proxy) against the real projection-gateway HTTP handler, in real Chromium.
 *
 * Proves: an independent browser (no window.opener) carrying #invite=<token> performs exactly
 * one POST /v1/display-joins, loses the fragment immediately, sits pending, and only shows
 * slides after the presenter-side bind approves the join. Replayed/expired tokens and a bare
 * URL stay public and inert. Referer/headers are asserted from the wire itself.
 *
 * Run from the repo root: bun .omo/evidence/ulw/<id>/G006/task-13/browser-check.mts <evidenceDir>
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";

import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { parseProjectionGatewayConfig } from "../../../../../../services/projection-gateway/src/config.ts";
import { createProjectionGatewayHandler } from "../../../../../../services/projection-gateway/src/http.ts";
import { PreparedEvidenceProjectionGateway } from "../../../../../../services/projection-gateway/src/prepared-evidence.ts";

const PREVIEW_ORIGIN = "http://127.0.0.1:4573";
const GATEWAY_ORIGIN = "http://127.0.0.1:3999";
const INTERNAL_TOKEN = "internal-test-token-alpha";
const evidenceDir = process.argv[2] ?? ".";

const logLines: string[] = [];
function log(line: string) {
  logLines.push(line);
  console.log(line);
}
function redact(text: string, secrets: string[]): string {
  return secrets.reduce((acc, secret) => acc.split(secret).join("<redacted>"), text);
}

// A real published-deck artifact: the slide image is an inline data: URI so the Stage can verify
// and paint it without a deck-asset store.
const pngPixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const deck = PublishedDeckArtifactSchema.parse({
  deckVersion: "deck_alpha",
  manifestHash: "a".repeat(64),
  title: "Invitation QA deck",
  slides: [
    {
      publicSlideKey: "slide_one",
      ordinal: 1,
      image: { url: pngPixel, contentHash: "b".repeat(64), width: 1, height: 1 },
      accessibilityLabel: "Slide one",
    },
  ],
});

// Injectable clock: the expired-invitation run mints at nowMs, then the clock is advanced past
// the 90s TTL before the browser arrives — deterministic, no sleeps.
const clock = { now: Date.now() };
const gateway = new PreparedEvidenceProjectionGateway();
const handle = createProjectionGatewayHandler(
  parseProjectionGatewayConfig({ STAGE_ORIGIN: PREVIEW_ORIGIN }),
  {
    gateway,
    internalAuthToken: INTERNAL_TOKEN,
    now: () => clock.now,
    stageReceiptWriter: { async recordApplied() { return null; } },
  },
);

const server = Bun.serve({
  port: 3999,
  fetch(request, bunServer) {
    const url = new URL(request.url);
    // Keep /v1/realtime open so the Stage's secondary channel does not flap during QA; the
    // authoritative path under test is the HTTP join/claim/snapshot sequence.
    if (url.pathname === "/v1/realtime" && bunServer.upgrade(request)) return undefined;
    return handle(request);
  },
  websocket: {
    open() {},
    message() {},
    close() {},
  },
});

async function api(path: string, init: RequestInit = {}) {
  return fetch(`${GATEWAY_ORIGIN}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      Origin: PREVIEW_ORIGIN,
      Referer: `${PREVIEW_ORIGIN}/`,
      ...init.headers,
    },
  });
}

async function internalApi(path: string, init: RequestInit = {}) {
  return fetch(`${GATEWAY_ORIGIN}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INTERNAL_TOKEN}`,
      ...init.headers,
    },
  });
}

async function issueInvitation(nowMs: number) {
  const response = await internalApi("/internal/display-invitations", {
    method: "POST",
    body: JSON.stringify({
      presentationSessionId: "ps_alpha",
      deckVersion: deck.deckVersion,
      nowMs,
    }),
  });
  if (response.status !== 201) throw new Error(`issuance failed: ${response.status}`);
  return (await response.json()) as { invitationId: string; token: string; expiresAtMs: number };
}

async function pendingView(invitationId: string) {
  const response = await internalApi(`/internal/display-invitations/${invitationId}`);
  return (await response.json()) as {
    join: { displayJoinId: string; displayId: string; displayFingerprint: string } | null;
    status: string;
  };
}

async function approveJoin(invitationId: string) {
  const view = await pendingView(invitationId);
  if (view.join === null) throw new Error("no pending join to approve");
  const response = await internalApi("/internal/display-bindings", {
    method: "POST",
    body: JSON.stringify({
      displayJoinId: view.join.displayJoinId,
      presentationSessionId: "ps_alpha",
      presentationSessionEpoch: "pse_1",
      publicationPolicyVersion: "ppv_1",
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: deck.deckVersion,
      approvedDisplayId: view.join.displayId,
      approvedDisplayFingerprint: view.join.displayFingerprint,
      deck,
      nowMs: clock.now,
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForPreview(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${PREVIEW_ORIGIN}/index.html`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error("vite preview did not come up");
}

const secrets: string[] = [];
const joinPosts: Array<Record<string, unknown>> = [];
const joinPostStatuses: number[] = [];
const failures: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    log(`PASS ${name}`);
  } else {
    failures.push(name);
    log(`FAIL ${name} ${detail}`);
  }
}

const vite = Bun.spawn(
  ["bunx", "vite", "preview", "--host", "127.0.0.1", "--port", "4573", "--strictPort"],
  {
  cwd: "apps/stage",
  env: {
    ...process.env,
    NODE_ENV: "production",
    PROJECTION_GATEWAY_ORIGIN: GATEWAY_ORIGIN,
    STAGE_PUBLIC_API_ORIGIN: "",
  },
  stdout: "inherit",
  stderr: "inherit",
  },
);

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
  await waitForPreview();

  browser = await chromium.launch({ headless: true });
  async function newStagePage(): Promise<{ page: Page; context: BrowserContext }> {
    const isolated = await browser!.newContext({ bypassCSP: false });
    const page = await isolated.newPage();
    page.on("request", (request) => {
      if (!request.url().startsWith(PREVIEW_ORIGIN)) return;
      const url = new URL(request.url());
      if (url.pathname === "/v1/display-joins" && request.method() === "POST") {
        joinPosts.push({
          url: url.pathname + url.search,
          referer: request.headers()["referer"],
          postDataKeys: Object.keys(JSON.parse(request.postData() ?? "{}")),
        });
      }
      if (url.pathname.startsWith("/v1/")) {
        log(
          `NET ${request.method()} ${url.pathname} -> referer=${request.headers()["referer"] ?? "<none>"} origin=${request.headers()["origin"] ?? "<none>"}`,
        );
      }
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === "/v1/display-joins" && response.request().method() === "POST") {
        joinPostStatuses.push(response.status());
      }
      if (url.pathname.startsWith("/v1/")) {
        log(
          `NET ${response.status()} ${url.pathname} set-cookie=${response.headers()["set-cookie"] !== undefined ? "<present>" : "<absent>"}`,
        );
      }
    });
    return { page, context: isolated };
  }

  // --- Flow 1: bare Stage stays inert -------------------------------------------------------
  {
    const { page, context: c } = await newStagePage();
    const joinCountBefore = joinPosts.length;
    const response = await page.goto(`${PREVIEW_ORIGIN}/?deck=deck_alpha`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator(".stage-console-only").waitFor({ timeout: 5_000 });
    check("bare page ships Referrer-Policy no-referrer", response?.headers()["referrer-policy"] === "no-referrer");
    check("bare page ships Cache-Control no-store", response?.headers()["cache-control"] === "no-store");
    const notice = await page.locator(".stage-console-only").textContent();
    check("bare Stage shows the neutral inert notice", (notice ?? "").length > 0);
    check("bare Stage made no join request", joinPosts.length === joinCountBefore);
    await page.screenshot({ path: `${evidenceDir}/bare.png` });
    await c.close();
  }

  // --- Flow 2: valid invitation -> one pending join -> approval -> slides ---------------------
  const issued = await issueInvitation(clock.now);
  secrets.push(issued.token);
  let displayIdFromDom = "";
  {
    const { page, context: c } = await newStagePage();
    const joinCountBefore = joinPosts.length;
    const response = await page.goto(
      `${PREVIEW_ORIGIN}/?deck=deck_alpha#invite=${issued.token}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("[data-join-state='pending-approval']").waitFor({ timeout: 10_000 });

    check("invite page Referrer-Policy no-referrer", response?.headers()["referrer-policy"] === "no-referrer");
    check("invite page Cache-Control no-store", response?.headers()["cache-control"] === "no-store");
    check("exactly one join POST for the invited load", joinPosts.length - joinCountBefore === 1);
    const post = joinPosts[joinPosts.length - 1];
    check(
      "join POST carried the token in-body only",
      (post?.postDataKeys as string[] | undefined)?.includes("invitationToken") === true &&
        !post?.url?.toString().includes("dinv_"),
    );
    // The gateway's validMutationOrigin requires an exact Origin AND same-origin Referer, so a
    // 201 answer is itself proof both were sent; Chromium does not expose the Origin header to
    // request observers, which is why the wire check is the response status plus Referer.
    check(
      "join POST kept a same-origin Referer and the gateway accepted the mutation origin",
      post?.referer === `${PREVIEW_ORIGIN}/?deck=deck_alpha` &&
        joinPostStatuses[joinPostStatuses.length - 1] === 201,
      JSON.stringify(post),
    );
    check("referer never contained the fragment", !(post?.referer ?? "").includes("#"));
    check(
      "fragment scrubbed from the address bar",
      (await page.evaluate(() => window.location.href)) === `${PREVIEW_ORIGIN}/?deck=deck_alpha`,
    );
    const view = await pendingView(issued.invitationId);
    check("gateway recorded the pending join", view.status === "JOINED" && view.join !== null);
    displayIdFromDom = (await page.locator("[data-display-id]").textContent()) ?? "";
    check(
      "pending identity shown matches the join the owner sees",
      view.join !== null &&
        displayIdFromDom === view.join.displayId &&
        (await page.locator("[data-display-fingerprint]").textContent()) ===
          view.join.displayFingerprint,
    );
    const bodyText = (await page.locator("body").textContent()) ?? "";
    check("token never rendered into the DOM", !bodyText.includes(issued.token));
    await page.screenshot({ path: `${evidenceDir}/waiting.png` });

    // The presenter approves (private backend gesture -> internal bind).
    const bound = await approveJoin(issued.invitationId);
    check("approval bind succeeded", bound.status === 200, JSON.stringify(bound.body));
    await page.waitForURL(/\/display\//, { timeout: 15_000 });
    await page
      .locator(".stage-display[data-audience-readiness='READY']")
      .waitFor({ timeout: 15_000 });
    const cookies = await c.cookies();
    check(
      "a display session cookie was set only after approval",
      cookies.length === 1 && cookies[0]?.value.startsWith("audience_") === true,
    );
    await page.screenshot({ path: `${evidenceDir}/approved.png` });
    await c.close();
  }

  // --- Flow 3: replaying the consumed invitation is refused ---------------------------------
  {
    const { page, context: c } = await newStagePage();
    const joinCountBefore = joinPosts.length;
    await page.goto(`${PREVIEW_ORIGIN}/?deck=deck_alpha#invite=${issued.token}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("[data-join-state='failed']").waitFor({ timeout: 10_000 });
    check(
      "replayed token still sent exactly one POST (server is the single authority)",
      joinPosts.length - joinCountBefore === 1,
    );
    check("replayed token shows the invalid-link state", (await page.locator(".stage-invitation-status").textContent())?.includes("더 이상") === true);
    await page.screenshot({ path: `${evidenceDir}/replayed.png` });
    await c.close();
  }

  // --- Flow 4: expired invitation -> honest expired state ------------------------------------
  {
    const stale = await issueInvitation(clock.now);
    secrets.push(stale.token);
    clock.now += 95_000; // past the 90s invitation TTL
    const { page, context: c } = await newStagePage();
    await page.goto(`${PREVIEW_ORIGIN}/?deck=deck_alpha#invite=${stale.token}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("[data-join-state='failed']").waitFor({ timeout: 10_000 });
    const status = (await page.locator(".stage-invitation-status").textContent()) ?? "";
    check("expired token shows the expired state", status.includes("만료"));
    await page.screenshot({ path: `${evidenceDir}/expired.png` });
    await c.close();
  }
} finally {
  await browser?.close();
  vite.kill();
  server.stop();
}

const fs = await import("node:fs");
fs.writeFileSync(
  `${evidenceDir}/network-redacted.log`,
  redact(logLines.join("\n"), secrets) + "\n",
);
fs.writeFileSync(
  `${evidenceDir}/cleanup.txt`,
  [
    `vite preview pid=${vite.pid} killed`,
    "gateway Bun.serve on :3999 stopped",
    "chromium contexts closed",
    `exit: ${failures.length === 0 ? "all checks passed" : `${failures.length} FAILURES`}`,
  ].join("\n") + "\n",
);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All browser checks passed.");
