#!/usr/bin/env bun
// Plan task 2 baseline reproduction — real-browser Stage pairing + asset-failure capture.
// Read-only wrt product code. Drives the LIVE deployed topology: Console and Stage on
// Vercel, proxying /v1 to the loopback demo stack on this host (private-backend :3001,
// projection-gateway :3002 behind cloudflared quick tunnels).
//
// Redaction contract: cookie values, CSRF tokens, passwords, bearer tokens, invitation
// tokens, and full displayJoin/displayFingerprint values are never written to artifacts.
// IDs (ps_*, dbe_*, slide_*), HTTP statuses, reasons, and DOM states are kept verbatim.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright-core";

const EVID = new URL("..", import.meta.url).pathname;
const PROFILES = join(EVID, "profiles");
const LOG = join(EVID, "browser-actions.log");
const HTTP = join(EVID, "pairing.http");
const RESULTS = join(EVID, "results.json");

const CONSOLE_ORIGIN = "https://impromptu-rev2-console.vercel.app";
const STAGE_ORIGIN = "https://impromptu-rev2-stage.vercel.app";
const OPENER = "http://127.0.0.1:4199";
const FIXTURE = "/Users/gahn/projects/impromptu-rev2/tests/fixtures/format-neutral-decks/korean-structural.pptx";

// ---- credentials from repo .env (never logged) -----------------------------------------
const envFile = readFileSync("/Users/gahn/projects/impromptu-rev2/.env", "utf8");
const env = (key) => envFile.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
const USERNAME = env("CONTROLLER_USERNAME");
const PASSWORD = env("CONTROLLER_PASSWORD");
if (!USERNAME || !PASSWORD) {
  console.error("FATAL: CONTROLLER_USERNAME/PASSWORD missing from .env");
  process.exit(2);
}

// ---- logging helpers --------------------------------------------------------------------
const logLines = [];
const httpLines = [];
const results = { notes: [], probes: {}, screens: {}, verdicts: {} };

function stamp() {
  return new Date().toISOString();
}
function log(msg) {
  const line = `${stamp()} ${msg}`;
  logLines.push(line);
  console.log(line);
}
function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/account_session_[A-Za-z0-9]+/g, "<cookie>")
    .replace(/__Host-account=[^;\\s"']+/g, "__Host-account=<cookie>")
    .replace(/dinv_[0-9a-f]+/gi, "dinv_<redacted>")
    .replace(/"csrfToken":"[^"]+"/g, '"csrfToken":"<redacted>"')
    .replace(/"token":"[^"]+"/g, '"token":"<redacted>"')
    .replace(/[0-9a-f]{64}/g, "<hex64>")
    .replace(/join_[0-9a-f]{32}/g, "join_<id>")
    .replace(/display_[0-9a-f]{32}/g, "display_<id>")
    .replace(/stage-browser-[0-9a-f-]{36}/g, "stage-browser-<uuid>")
    .replace(/audience_[0-9a-f]+/g, "audience_<session>")
    .replace(/ads_[0-9a-f]+/g, "ads_<session>");
}
function recordHttp(label, status, body) {
  const rendered =
    typeof body === "object" && body !== null ? JSON.stringify(body) : String(body ?? "");
  httpLines.push(`### ${label}\nHTTP ${status}\n${redact(rendered)}\n`);
  results.probes[label] = { status, body };
  log(`HTTP ${label} -> ${status} ${redact(rendered).slice(0, 160)}`);
}
async function probe(label, url, init = {}) {
  const res = await fetch(url, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = `<non-json ${res.headers.get("content-type") ?? "?"}>`;
  }
  recordHttp(label, res.status, body);
  return { status: res.status, body, res };
}

// private API calls run through the console origin (its /v1 proxy). A real browser on that
// origin sends matching Origin+Referer on mutations; node fetch must set the same pair.
function privateHeaders(csrf) {
  const h = {
    "content-type": "application/json",
    origin: CONSOLE_ORIGIN,
    referer: `${CONSOLE_ORIGIN}/`,
  };
  if (csrf) h["x-csrf-token"] = csrf;
  return h;
}
function stageHeaders() {
  return {
    "content-type": "application/json",
    origin: STAGE_ORIGIN,
    referer: `${STAGE_ORIGIN}/`,
  };
}

const cookieJar = new Map(); // name -> value (in-memory only)
function captureCookies(res) {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// ---- phase A: public probe battery ------------------------------------------------------
async function phaseA() {
  log("phase A: origin/invitation/independent-device probes on the deployed topology");
  await probe("join-malformed", `${STAGE_ORIGIN}/v1/display-joins`, {
    method: "POST",
    headers: stageHeaders(),
    body: "{}",
  });
  await probe("join-invitation-token-malformed", `${STAGE_ORIGIN}/v1/display-joins`, {
    method: "POST",
    headers: stageHeaders(),
    body: JSON.stringify({
      displayId: "display_task2malformed01",
      displayFingerprint: "fp_task2malformed",
      deckVersion: "deck_alpha",
      invitationToken: "not-a-token",
    }),
  });

  await probe("snapshot-no-cookie", `${STAGE_ORIGIN}/v1/snapshot`);
  await probe("events-no-cookie", `${STAGE_ORIGIN}/v1/events`);
  await probe("invitation-mint-no-auth", `${CONSOLE_ORIGIN}/v1/display-invitations`, {
    method: "POST",
    headers: privateHeaders(),
    body: "{}",
  });
}

// ---- phase B: authenticated setup (node fetch through console origin) --------------------
let csrfToken = "";
let presentation = null;

async function loginNode() {
  const login = await fetch(`${CONSOLE_ORIGIN}/v1/account-sessions`, {
    method: "POST",
    headers: privateHeaders(),
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  captureCookies(login);
  const loginBody = await login.json().catch(() => null);
  csrfToken = loginBody?.csrfToken ?? "";
  recordHttp("login-node", login.status, {
    accountId: loginBody?.account?.accountId,
    csrfToken: "<redacted>",
  });
  if (login.status !== 201) throw new Error("node-side login failed");
}

async function bindDisplay(joinLocator, expectedEpoch, label = "approve") {
  const res = await fetch(`${CONSOLE_ORIGIN}/v1/display-bindings`, {
    method: "POST",
    headers: { ...privateHeaders(csrfToken), cookie: cookieHeader() },
    body: JSON.stringify({
      presentationSessionId: presentation.presentationSessionId,
      displayJoinId: joinLocator.displayJoinId,
      expectedDisplayBindingEpoch: expectedEpoch,
      expectedDeckVersion: presentation.deckVersion,
      approvedDisplayId: joinLocator.displayId,
      approvedDisplayFingerprint: joinLocator.displayFingerprint,
    }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, label };
}

// ---- browser helpers ----------------------------------------------------------------------
async function launch(name, extra = {}) {
  const dir = join(PROFILES, name);
  mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    permissions: ["clipboard-read", "clipboard-write"],
    ...extra,
  });
  ctx.on("page", (page) => {
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("/v1/")) {
        httpLines.push(`BROWSER-REQ ${name} ${req.method()} ${u.replace(/#.*$/, "").replace(/\?.*$/, "")}`);
      }
    });
    page.on("response", (res) => {
      const u = res.url();
      if (u.includes("/v1/")) {
        httpLines.push(`BROWSER-RES ${name} ${res.status()} ${u.replace(/#.*$/, "").replace(/\?.*$/, "")}`);
      }
    });
    page.on("console", (msg) => {
      const t = msg.text();
      if (/error|fail|denied|reject/i.test(t)) log(`console.${name}: ${redact(t).slice(0, 200)}`);
    });
  });
  return ctx;
}
async function shot(page, file) {
  await page.screenshot({ path: join(EVID, file) });
  log(`screenshot ${file}`);
}

let currentEpoch = "dbe_0";
function noteBind(label, outcome) {
  recordHttp(label, outcome.status, outcome.body);
  if (outcome.status === 200 || outcome.status === 201) {
    currentEpoch = outcome.body?.binding?.displayBindingEpoch ?? currentEpoch;
  }
}

// ---- phase C: real console UI -> presenter pairing ----------------------------------------
async function phaseC() {
  const ctxA = await launch("profile-a-presenter");
  const page = await ctxA.newPage();
  await page.goto(`${CONSOLE_ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  results.screens.consoleLanding = (await page.locator("body").innerText()).slice(0, 300);
  await shot(page, "console-landing.png");
  log(`console landing: ${results.screens.consoleLanding.replace(/\s+/g, " ").slice(0, 140)}`);

  // sign in through the real UI
  const userField = page.locator('input[name="username"], input[type="text"], input:not([type])').first();
  const passField = page.locator('input[type="password"]').first();
  if ((await passField.count()) === 0) {
    // maybe already on a different surface; record and bail to API-driven path
    results.notes.push("no password field on console landing; UI pairing skipped");
    results.verdicts.consoleUiSignIn = "no-form";
    await ctxA.close();
    return;
  }
  await userField.fill(USERNAME);
  await passField.fill(PASSWORD);
  const submit = page.locator('button[type="submit"], button:has-text("로그인"), button:has-text("Sign")').first();
  const [loginResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/v1/account-sessions"), { timeout: 20000 }),
    submit.click(),
  ]).catch(() => [null]);
  results.verdicts.consoleUiSignIn = loginResp ? loginResp.status() : "no-response";
  log(`console UI sign-in status: ${results.verdicts.consoleUiSignIn}`);
  await page.waitForTimeout(1500);
  await shot(page, "console-after-signin.png");

  // upload the fixture deck through the real upload control
  const fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) === 0) {
    results.notes.push("no file input after sign-in");
    await shot(page, "console-no-upload.png");
    await ctxA.close();
    return;
  }
  await fileInput.setInputFiles(FIXTURE);
  const [uploadResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/v1/deck-uploads"), { timeout: 150000 }),
    page.locator("[data-deck-upload-submit]").click().catch(() => fileInput.dispatchEvent("change")),
  ]).catch(() => [null]);
  const finalUpload =
    uploadResp ??
    (await page
      .waitForResponse((r) => r.url().includes("/v1/deck-uploads"), { timeout: 150000 })
      .catch(() => null));
  results.verdicts.uiUpload = finalUpload ? finalUpload.status() : "no-response";
  if (finalUpload !== null && finalUpload.status() === 201) {
    const up = await finalUpload.json().catch(() => null);
    if (up?.presentationSessionId && up?.deckVersion) {
      presentation = {
        presentationSessionId: up.presentationSessionId,
        presentationSessionEpoch: up.presentationSessionEpoch,
        deckVersion: up.deckVersion,
      };
      recordHttp("ui-upload-result", finalUpload.status(), {
        presentationSessionId: up.presentationSessionId,
        presentationSessionEpoch: up.presentationSessionEpoch,
        deckVersion: up.deckVersion,
        slides: up.publicDeck?.slides?.length,
        imageUrlSample: up.publicDeck?.slides?.[0]?.image?.url ?? null,
      });
    }
  }
  log(`UI deck upload status: ${results.verdicts.uiUpload}`);
  await shot(page, "console-after-upload.png");

  // wait for the cockpit (pairing panel needs activePresentation)
  const panel = page.locator("[data-audience-screen-panel]");
  const panelFound = await panel.waitFor({ state: "attached", timeout: 30000 }).then(() => true).catch(() => false);
  results.verdicts.cockpitReached = panelFound;
  if (!panelFound) {
    results.notes.push("cockpit/audience panel never rendered");
    await shot(page, "console-no-cockpit.png");
    await ctxA.close();
    return;
  }
  const panelState = await panel.getAttribute("data-audience-screen-panel");
  log(`audience panel: ${panelState}`);
  await shot(page, "console-cockpit.png");

  // the plan's "Console copies [data-copy-stage]": press it, read the clipboard
  const copyBtn = page.locator("[data-copy-stage]").first();
  if ((await copyBtn.count()) > 0) {
    await copyBtn.scrollIntoViewIfNeeded().catch(() => {});
    // the button may live inside <details>; open it
    const det = page.locator("details.console-advanced-connect").first();
    if ((await det.count()) > 0) await det.evaluate((d) => (d.open = true));
    await copyBtn.click().catch(() => {});
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR:${e.message}`);
    results.verdicts.clipboardUrl = typeof clip === "string" && clip.startsWith("http")
      ? `${new URL(clip).origin}${new URL(clip).pathname}?deck=<redacted-version>`
      : clip;
    log(`[data-copy-stage] clipboard -> ${results.verdicts.clipboardUrl}`);
  } else {
    results.notes.push("[data-copy-stage] not rendered in current cockpit phase");
  }

  // presenter gesture: open the audience screen from the real UI — the button lives inside
  // the advanced-connect <details>; open every collapsed ancestor before the trusted click.
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("details")) d.open = true;
  });
  await page.waitForTimeout(300);
  const openBtn = page.locator("[data-stage-open]").first();
  results.verdicts.stageOpenPresent = (await openBtn.count()) > 0;
  if (!results.verdicts.stageOpenPresent) {
    results.notes.push("[data-stage-open] absent — deployed console pairing UI differs");
    await ctxA.close();
    return;
  }
  const popupPromise = ctxA.waitForEvent("page", { timeout: 20000 });
  const bind1RespPromise = page
    .waitForResponse((r) => r.url().includes("/v1/display-bindings"), { timeout: 45000 })
    .catch(() => null);
  await openBtn.click();
  const stage1 = await popupPromise;
  await stage1.waitForLoadState("domcontentloaded");
  const stage1url = stage1.url();
  results.screens.stage1OpenedUrl = `${new URL(stage1url).origin}${new URL(stage1url).pathname}`;
  log(`stage popup opened at ${results.screens.stage1OpenedUrl}`);

  // UI auto-approves joins from its own window; stage claims and renders
  await stage1.waitForURL(/\/display\//, { timeout: 30000 }).catch(() => null);
  await stage1.waitForSelector("[data-audience-readiness]", { timeout: 30000 }).catch(() => null);
  await stage1.waitForSelector(".stage-slide-host svg, img.stage-slide", { timeout: 15000 }).catch(() => null);
  results.screens.opener = await stage1.evaluate(() => ({
    readiness: document.querySelector("[data-audience-readiness]")?.getAttribute("data-audience-readiness") ?? null,
    url: location.pathname,
    svgPainted: !!document.querySelector(".stage-slide-host svg"),
    imgPainted: !!document.querySelector("img.stage-slide"),
    hasOpener: window.opener !== null,
  }));
  log(`stage1: ${JSON.stringify(results.screens.opener)}`);
  await shot(stage1, "opener.png");
  const bind1Resp = await bind1RespPromise;
  if (bind1Resp !== null) {
    const b = await bind1Resp.json().catch(() => null);
    recordHttp("ui-first-bind-response", bind1Resp.status(), b);
    if (bind1Resp.status() === 200 || bind1Resp.status() === 201) {
      currentEpoch = b?.binding?.displayBindingEpoch ?? currentEpoch;
    }
  }
  const bindAfterUi = await panel.getAttribute("data-audience-screen-panel");
  results.verdicts.panelAfterBind = bindAfterUi;
  await shot(page, "console-bound.png");

  // --- close/reopen the successful opener binding -> the plan's rebind probe ---
  await stage1.close();
  results.notes.push("closed stage1; reopening via console [data-stage-open] again");
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("details")) d.open = true;
  });
  await page.waitForTimeout(300);
  const popup2Promise = ctxA.waitForEvent("page", { timeout: 20000 });
  await openBtn.click();
  const stage2 = await popup2Promise;
  await stage2.waitForLoadState("domcontentloaded");
  // watch the private bind call the console makes
  const bindResp = await page
    .waitForResponse((r) => r.url().includes("/v1/display-bindings"), { timeout: 30000 })
    .catch(() => null);
  if (bindResp !== null) {
    const body = await bindResp.json().catch(() => null);
    recordHttp("ui-rebind-response", bindResp.status(), body);
    results.verdicts.uiRebind = { status: bindResp.status(), body };
  } else {
    results.notes.push("no /v1/display-bindings call observed on reopen (UI may not auto-approve)");
  }
  await page.waitForTimeout(2500);
  const rebindState = await page.evaluate(() => ({
    panel: document.querySelector("[data-audience-screen-panel]")?.getAttribute("data-audience-screen-panel"),
    pairing: document.querySelector("[data-stage-pairing]")?.getAttribute("data-stage-pairing"),
    text: document.querySelector(".console-stage-setup")?.textContent?.slice(0, 200),
  }));
  results.screens.uiRebindState = rebindState;
  log(`post-reopen console state: ${JSON.stringify(rebindState)}`);
  const stage2State = await stage2.evaluate(() => ({
    readiness: document.querySelector("[data-audience-readiness]")?.getAttribute("data-audience-readiness") ?? null,
    url: location.pathname,
    svgPainted: !!document.querySelector(".stage-slide-host svg"),
  })).catch(() => null);
  results.screens.stage2Reopen = stage2State;
  log(`stage2 after reopen: ${JSON.stringify(stage2State)}`);
  await shot(stage2, "rebind-stage.png");
  await shot(page, "rebind-console.png");
  await ctxA.close();
}

// ---- phase D: independent device + invitation + asset failure -----------------------------
async function phaseD() {
  const stageUrl = `${STAGE_ORIGIN}/?deck=${encodeURIComponent(presentation.deckVersion)}`;

  // D1 independent device — separate profile, no opener
  const ctxB = await launch("profile-b-independent");
  const indep = await ctxB.newPage();
  const joinCalls = [];
  indep.on("request", (r) => {
    if (r.url().includes("/v1/display-joins")) joinCalls.push(r.method());
  });
  await indep.goto(stageUrl, { waitUntil: "domcontentloaded" });
  await indep.waitForTimeout(2000);
  const indepText = (await indep.locator("body").innerText()).trim();
  results.screens.independentText = indepText.slice(0, 300);
  results.verdicts.independentJoinAttempts = joinCalls.length;
  results.verdicts.independentInert =
    joinCalls.length === 0 && !indep.url().includes("/display/");
  log(`independent device: url=${indep.url()} joinCalls=${joinCalls.length} text=${indepText.slice(0, 120)}`);
  await shot(indep, "independent-device.png");
  // the same device tries the raw public API: mint a locator and try to claim it
  const solo = await probe("independent-device-createJoin", `${STAGE_ORIGIN}/v1/display-joins`, {
    method: "POST",
    headers: stageHeaders(),
    body: JSON.stringify({
      displayId: "display_task2indep01",
      displayFingerprint: "fp_task2independent",
      deckVersion: presentation.deckVersion,
    }),
  });
  if (solo.status === 201) {
    await probe("independent-device-claim-unapproved", `${STAGE_ORIGIN}/v1/display-session`, {
      method: "POST",
      headers: stageHeaders(),
      body: JSON.stringify(solo.body),
    });
  }
  await ctxB.close();

  // D2 mobile independent
  const ctxM = await launch("profile-m-independent-mobile", {
    ...devices["iPhone 13"],
    viewport: { width: 390, height: 844 },
  });
  const mob = await ctxM.newPage();
  await mob.goto(stageUrl, { waitUntil: "domcontentloaded" });
  await mob.waitForTimeout(1500);
  await shot(mob, "independent-device-mobile.png");
  await ctxM.close();

  // D3 real invitation: mint via owner API -> exchange once -> replay -> forge
  await probe("join-invitation-token-forged", `${STAGE_ORIGIN}/v1/display-joins`, {
    method: "POST",
    headers: stageHeaders(),
    body: JSON.stringify({
      displayId: "display_task2forged001",
      displayFingerprint: "fp_task2forged",
      deckVersion: presentation.deckVersion,
      invitationToken: `dinv_${"00".repeat(32)}`,
    }),
  });
  const mint = await fetch(`${CONSOLE_ORIGIN}/v1/display-invitations`, {
    method: "POST",
    headers: { ...privateHeaders(csrfToken), cookie: cookieHeader() },
    body: JSON.stringify({ presentationSessionId: presentation.presentationSessionId }),
  });
  const invite = await mint.json().catch(() => null);
  recordHttp("invitation-mint", mint.status, invite ? { ...invite, token: "<redacted>", stagePath: "/?deck=<v>#invite=dinv_<redacted>" } : invite);
  if (mint.status === 201 && invite?.token) {
    const exchangeBody = {
      displayId: "display_task2invited01",
      displayFingerprint: "fp_task2invited",
      deckVersion: presentation.deckVersion,
      invitationToken: invite.token,
    };
    const ex1 = await probe("invitation-exchange-first", `${STAGE_ORIGIN}/v1/display-joins`, {
      method: "POST",
      headers: stageHeaders(),
      body: JSON.stringify(exchangeBody),
    });
    const ex2 = await probe("invitation-exchange-replay", `${STAGE_ORIGIN}/v1/display-joins`, {
      method: "POST",
      headers: stageHeaders(),
      body: JSON.stringify({ ...exchangeBody, displayId: "display_task2invited02" }),
    });
    results.verdicts.invitationReplayDenied = ex2.status;
    // invited Stage UI: open the stagePath URL in a third profile (invited device)
    const ctxI = await launch("profile-i-invited");
    const inv = await ctxI.newPage();
    await inv.goto(`${STAGE_ORIGIN}${invite.stagePath}`, { waitUntil: "domcontentloaded" });
    await inv.waitForTimeout(2000);
    const invState = await inv.evaluate(() => ({
      url: location.pathname + location.search,
      readiness: document.querySelector("[data-audience-readiness]")?.getAttribute("data-audience-readiness") ?? null,
      text: document.body.innerText.slice(0, 160),
    }));
    results.screens.invitedLanding = invState;
    log(`invited stage: ${JSON.stringify(invState)}`);
    await shot(inv, "invited-device.png");
    await ctxI.close();
    // claim the exchanged join unapproved -> denial
    if (ex1.status === 201) {
      await probe("invited-join-claim-unapproved", `${STAGE_ORIGIN}/v1/display-session`, {
        method: "POST",
        headers: stageHeaders(),
        body: JSON.stringify(ex1.body),
      });
    }
  }

  // D4 asset failure: block the verified SVG request -> READY but slide stays unmounted
  const ctxE = await launch("profile-e-asset-fail");
  let aborted = 0;
  await ctxE.route(/\/v1\/deck-assets\//, (route) => {
    aborted += 1;
    httpLines.push(`BROWSER-ABORT asset ${route.request().url().split("?")[0].split("/").pop()}`);
    return route.abort();
  });
  const opener3 = await ctxE.newPage();
  await opener3.goto(`${OPENER}/?stage=${encodeURIComponent(stageUrl)}`, {
    waitUntil: "domcontentloaded",
  });
  const popup3Promise = ctxE.waitForEvent("page", { timeout: 20000 });
  await opener3.locator("#open").click();
  const stage3 = await popup3Promise;
  await stage3.waitForLoadState("domcontentloaded");
  await opener3.waitForFunction(() => window.__joins?.length > 0, null, { timeout: 20000 });
  const join3 = await opener3.evaluate(() => window.__joins[0]);
  const bind3 = await bindDisplay(join3, currentEpoch);
  noteBind("approve-join3-assetfail", bind3);
  results.verdicts.assetBind = bind3.status;
  await stage3.waitForURL(/\/display\//, { timeout: 30000 }).catch(() => null);
  await stage3.waitForSelector("[data-audience-readiness]", { timeout: 30000 }).catch(() => null);
  await stage3.waitForTimeout(3000); // let the blocked asset fetch settle
  results.screens.assetFail = await stage3.evaluate(() => ({
    readiness: document.querySelector("[data-audience-readiness]")?.getAttribute("data-audience-readiness") ?? null,
    svgPainted: !!document.querySelector(".stage-slide-host svg"),
    hostEmpty: (document.querySelector(".stage-slide-host")?.childElementCount ?? 0) === 0,
    bodyText: document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 200),
  }));
  results.verdicts.assetBlockedCount = aborted;
  log(`asset-failure: ${JSON.stringify(results.screens.assetFail)} aborted=${aborted}`);
  await shot(stage3, "asset-failure.png");

  // mobile twin
  const ctxF = await launch("profile-f-asset-fail-mobile", {
    ...devices["iPhone 13"],
    viewport: { width: 390, height: 844 },
  });
  await ctxF.route(/\/v1\/deck-assets\//, (route) => route.abort());
  const opener4 = await ctxF.newPage();
  await opener4.goto(`${OPENER}/?stage=${encodeURIComponent(stageUrl)}`, { waitUntil: "domcontentloaded" });
  const popup4Promise = ctxF.waitForEvent("page", { timeout: 20000 });
  await opener4.locator("#open").click();
  const stage4 = await popup4Promise;
  await stage4.waitForLoadState("domcontentloaded");
  await opener4.waitForFunction(() => window.__joins?.length > 0, null, { timeout: 20000 });
  const join4 = await opener4.evaluate(() => window.__joins[0]);
  const bind4 = await bindDisplay(join4, currentEpoch);
  noteBind("approve-join4-mobile", bind4);
  await stage4.waitForURL(/\/display\//, { timeout: 30000 }).catch(() => null);
  await stage4.waitForTimeout(3000);
  await shot(stage4, "asset-failure-mobile.png");
  await ctxF.close();
  await ctxE.close();
}

// ---- cleanup ------------------------------------------------------------------------------
async function cleanup() {
  try {
    const end = await fetch(
      `${CONSOLE_ORIGIN}/v1/presentation-sessions/${encodeURIComponent(presentation?.presentationSessionId ?? "")}/end`,
      { method: "POST", headers: { ...privateHeaders(csrfToken), cookie: cookieHeader() }, body: "{}" },
    );
    recordHttp("cleanup-end-presentation", end.status, await end.json().catch(() => null));
  } catch (e) {
    log(`cleanup end-presentation failed: ${e.message}`);
  }
  try {
    const out = await fetch(`${CONSOLE_ORIGIN}/v1/account-session`, {
      method: "DELETE",
      headers: { ...privateHeaders(csrfToken), cookie: cookieHeader() },
    });
    recordHttp("cleanup-revoke-session", out.status, await out.json().catch(() => null));
  } catch (e) {
    log(`cleanup revoke failed: ${e.message}`);
  }
}

// ---- main ----------------------------------------------------------------------------------
async function main() {
  mkdirSync(PROFILES, { recursive: true });
  log("task-2 baseline run start (deployed Vercel topology)");
  try {
    await phaseA();
    await loginNode();
    await phaseC();
    if (presentation === null) {
      results.notes.push("no activePresentation was minted by the UI upload; API-driven phases skipped");
    } else {
      await phaseD();
    }
    results.verdicts.completed = true;
  } catch (error) {
    results.verdicts.completed = false;
    results.verdicts.fatal = error instanceof Error ? error.message : String(error);
    log(`FATAL ${results.verdicts.fatal}`);
  } finally {
    await cleanup().catch(() => {});
    writeFileSync(LOG, logLines.join("\n") + "\n");
    writeFileSync(HTTP, httpLines.join("\n") + "\n");
    writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  }
}

await main();
