#!/usr/bin/env bun
// Task 12 browser QA: drives the REAL console dev build (worktree code) in Chromium with
// Playwright page.route mocks for the private /v1 API. The demo stack's backend enforces
// the deployed console origin, so browser-level mutation traffic must be stubbed; the UI,
// wiring, clipboard, and DOM assertions are the real artifact.
//
// Redaction: no cookies, tokens, or secrets are written. Invitation tokens are fixtures.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const EVID = new URL("..", import.meta.url).pathname;
mkdirSync(EVID, { recursive: true });
const CONSOLE = process.env.CONSOLE_URL ?? "http://127.0.0.1:4185";
const STAGE = "http://127.0.0.1:4174";
const TOKEN = `dinv_${"aa".repeat(32)}`;
const INVITATION_ID = `dinvite_${"bb".repeat(16)}`;

const log = [];
const notes = (line) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  log.push(stamped);
  console.log(stamped);
};

// ---- mocked private API ---------------------------------------------------------
let joined = false;
let expired = false;
const approvals = [];
const mints = [];
const checks = [];

function mockApi(route) {
  const url = new URL(route.request().url());
  const method = route.request().method();
  const path = url.pathname;
  const fulfill = (status, body, headers = {}) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers,
      body: JSON.stringify(body),
    });

  if (method === "POST" && path === "/v1/accounts") {
    return fulfill(201, { account: { accountId: "account_qa", actorId: "actor_qa" } });
  }
  if (method === "POST" && path === "/v1/account-sessions") {
    return fulfill(
      201,
      {
        account: { accountId: "account_qa", actorId: "actor_qa" },
        expiresAtMs: Date.now() + 3_600_000,
        csrfToken: "qa-csrf",
      },
      { "set-cookie": "__Host-account=qa; Path=/; HttpOnly; SameSite=Lax" },
    );
  }
  if (method === "GET" && path === "/v1/account-session") {
    return fulfill(200, {
      account: { accountId: "account_qa", actorId: "actor_qa" },
      expiresAtMs: Date.now() + 3_600_000,
      csrfToken: "qa-csrf",
    });
  }
  if (method === "POST" && path === "/v1/deck-uploads") {
    return fulfill(201, {
      presentationSessionId: "ps_qa",
      presentationSessionEpoch: "pse_1",
      deckVersion: "deck_qa",
      sourceHash: "f".repeat(64),
      privateDeck: { deckId: "private_qa" },
      publicDeck: {
        deckVersion: "deck_qa",
        manifestHash: "e".repeat(64),
        slides: [
          {
            publicSlideKey: "slide_one",
            ordinal: 1,
            accessibilityLabel: "Opening slide",
            image: {
              url: "https://public.example.test/one.png",
              contentHash: "c".repeat(64),
              width: 1920,
              height: 1080,
            },
          },
        ],
      },
    });
  }
  if (method === "GET" && path === "/v1/reference-documents") {
    return fulfill(200, { documents: [] });
  }
  if (method === "POST" && path === "/v1/display-invitations") {
    const body = JSON.parse(route.request().postData() ?? "{}");
    mints.push(body.presentationSessionId);
    return fulfill(201, {
      invitationId: INVITATION_ID,
      token: TOKEN,
      deckVersion: "deck_qa",
      expiresAtMs: Date.now() + 90_000,
      stagePath: `/?deck=deck_qa#invite=${TOKEN}`,
    });
  }
  if (method === "GET" && /\/v1\/display-invitations\/[^/]+\/pending$/.test(path)) {
    checks.push(path);
    if (expired) {
      return fulfill(200, {
        invitationId: INVITATION_ID,
        presentationSessionId: "ps_qa",
        deckVersion: "deck_qa",
        expiresAtMs: Date.now() - 1,
        status: "EXPIRED",
        displayBindingEpoch: "dbe_2",
        join: null,
      });
    }
    return fulfill(200, {
      invitationId: INVITATION_ID,
      presentationSessionId: "ps_qa",
      deckVersion: "deck_qa",
      expiresAtMs: Date.now() + 90_000,
      status: joined ? "JOINED" : "PENDING",
      displayBindingEpoch: "dbe_2",
      join: joined
        ? {
            displayJoinId: `join_${"dd".repeat(16)}`,
            displayId: "display_projector",
            displayFingerprint: "stage-browser-room-fp",
            deckVersion: "deck_qa",
            expiresAtMs: Date.now() + 60_000,
          }
        : null,
    });
  }
  if (method === "POST" && path === "/v1/display-bindings") {
    const body = JSON.parse(route.request().postData() ?? "{}");
    approvals.push(body);
    return fulfill(201, {
      binding: { displayBindingEpoch: "dbe_3" },
      displayBindingEpoch: "dbe_3",
    });
  }
  if (method === "GET" && path === "/v1/audio/events") {
    return route.fulfill({ status: 204, body: "" });
  }
  return fulfill(404, { error: "unmocked" });
}

async function run() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE_PATH ?? chromium.executablePath(),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
    locale: "en-US",
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") notes(`console.error: ${msg.text().slice(0, 200)}`);
  });
  await page.route("**/v1/**", mockApi);

  await page.goto(`${CONSOLE}/sign-in`);
  await page.locator("[data-sign-in-username]").fill("qa_presenter");
  await page.locator("[data-sign-in-password]").fill("qa-password-123");
  await page.locator("[data-sign-in-submit]").click();
  await page.locator("[data-deck-file-input]").waitFor({ timeout: 15_000 });
  notes("signed in; upload panel reached");

  // The console defaults to Korean; switch to English so the QA reads plainly.
  await page.getByRole("button", { name: "English" }).click();

  await page.locator("[data-deck-file-input]").setInputFiles({
    name: "demo-deck.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 qa fixture"),
  });
  await page.locator("[data-audience-screen-panel]").waitFor({ timeout: 15_000 });
  await page.screenshot({ path: join(EVID, "qa-01-workspace.png") });
  notes("deck uploaded; audience panel visible");

  // 1) Open the connection options disclosure, then copy the invitation link.
  await page.locator("summary", { hasText: "Connect another device or display" }).click();
  await page.screenshot({ path: join(EVID, "qa-01b-advanced.png") });
  await page.getByRole("button", { name: "Copy presentation screen link" }).click();
  await page.locator("[data-stage-invitation='OPEN']").waitFor({ timeout: 10_000 });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const copiedUrl = new URL(copied);
  if (copiedUrl.origin !== STAGE) throw new Error(`unexpected stage origin ${copiedUrl.origin}`);
  if (copiedUrl.searchParams.get("invite") !== null) throw new Error("token leaked into query");
  if (copiedUrl.hash !== `#invite=${TOKEN}`) throw new Error(`bad fragment ${copiedUrl.hash}`);
  notes(`copied invitation url = ${STAGE}/?deck=deck_qa#invite=<token>`);
  await page.screenshot({ path: join(EVID, "qa-02-invite-open.png") });

  // 2) Check with nothing joined.
  await page.locator("[data-invitation-check]").click();
  await page.getByText("No connection request yet").waitFor({ timeout: 10_000 });
  notes("pending check shows waiting state");

  // 3) Second Stage consumes the invitation -> pending read returns the join + CAS.
  joined = true;
  await page.locator("[data-invitation-check]").click();
  await page.locator("[data-stage-invitation='JOINED']").waitFor({ timeout: 10_000 });
  const identity = {
    displayId: await page.locator("[data-identity-display-id]").textContent(),
    fingerprint: await page.locator("[data-identity-fingerprint]").textContent(),
    deck: await page.locator("[data-identity-deck]").textContent(),
    epoch: await page.locator("[data-identity-epoch]").textContent(),
  };
  notes(`pending identity ${JSON.stringify(identity)}`);
  if (identity.displayId !== "display_projector") throw new Error("wrong display id");
  if (identity.fingerprint !== "stage-browser-room-fp") throw new Error("wrong fingerprint");
  if (identity.epoch !== "dbe_2") throw new Error("wrong CAS epoch");
  await page.locator("[data-audience-screen-panel]").screenshot({ path: join(EVID, "qa-03-invite-joined.png") });

  // 4) Explicit approve -> binding POST carries the read CAS, badge lands.
  await page.locator("[data-display-approve]").click();
  await page.locator("[data-audience-screen-panel='CONNECTED']").waitFor({ timeout: 10_000 });
  if (approvals.length !== 1) throw new Error("approve did not fire exactly once");
  const approval = approvals[0];
  if (approval.expectedDisplayBindingEpoch !== "dbe_2") {
    throw new Error(`approval epoch ${approval.expectedDisplayBindingEpoch} !== dbe_2`);
  }
  if (approval.approvedDisplayFingerprint !== "stage-browser-room-fp") {
    throw new Error("approval fingerprint mismatch");
  }
  notes("approval POST carried the read CAS dbe_2 and the exact display identity");
  await page.screenshot({ path: join(EVID, "qa-04-connected.png") });

  // 5) Expired invitation: mint again, pending read EXPIRED -> recovery copy, no success.
  joined = false;
  expired = true;
  await page.getByRole("button", { name: "Copy presentation screen link" }).first().click();
  await page.locator("[data-stage-invitation='OPEN']").waitFor({ timeout: 10_000 });
  await page.locator("[data-invitation-check]").click();
  await page.locator("[data-stage-invitation='EXPIRED']").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(EVID, "qa-05-expired.png") });
  notes("expired invitation renders recovery copy, no connected claim");

  await context.close();
  await browser.close();
  writeFileSync(join(EVID, "browser-qa.log"), `${log.join("\n")}\n`);
  console.log("BROWSER_QA_PASS");
}

run().catch((error) => {
  writeFileSync(join(EVID, "browser-qa.log"), `${log.join("\n")}\nFATAL ${String(error)}\n`);
  console.error(error);
  process.exit(1);
});
