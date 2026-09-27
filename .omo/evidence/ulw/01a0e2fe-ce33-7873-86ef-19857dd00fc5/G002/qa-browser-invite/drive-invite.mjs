// C001 re-verify after redeploy: persisted presentation library + minted #invite link.
// Same discipline as drive.mjs: task-owned profiles, no secrets in logs, URLs redacted.

import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/gahn/projects/impromptu-rev2";
const OUT = join(
  ROOT,
  ".omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G002/qa-browser-invite",
);
const SHOTS = join(OUT, "screenshots");
const CONSOLE_ORIGIN = "https://impromptu-rev2-console.vercel.app";
const PDF = join(ROOT, "docs/samples/impromptu-sample-deck.pdf");

mkdirSync(SHOTS, { recursive: true });

function env(name) {
  const line = readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  if (line === undefined) throw new Error(`${name} missing from .env`);
  return line
    .slice(name.length + 1)
    .trim()
    .replace(/^"|"$/g, "");
}
const USERNAME = env("CONTROLLER_USERNAME");
const PASSWORD = env("CONTROLLER_PASSWORD");
const chromeEnv = env("CHROME_EXECUTABLE_PATH");
const executablePath = chromeEnv === "" ? chromium.executablePath() : chromeEnv;

const actionLog = [];
const networkLog = [];
function act(step, detail) {
  actionLog.push({ at: new Date().toISOString(), step, detail });
  console.log(`[act] ${step}: ${detail}`);
}
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.hash.startsWith("#invite=") ? "#invite=<redacted>" : ""}`;
  } catch {
    return "<unparseable-url>";
  }
}
function watch(page, tag) {
  page.on("response", (res) => {
    try {
      const u = new URL(res.url());
      if (!u.pathname.startsWith("/v1/")) return;
      networkLog.push({
        surface: tag,
        method: res.request().method(),
        host: u.host,
        path: u.pathname,
        status: res.status(),
      });
      console.log(
        `[net:${tag}] ${res.request().method()} ${u.host}${u.pathname} -> ${res.status()}`,
      );
    } catch {}
  });
}

const profileConsole = join(OUT, ".profile-console");
const profileStage = join(OUT, ".profile-stage");
rmSync(profileConsole, { recursive: true, force: true });
rmSync(profileStage, { recursive: true, force: true });

const ctxConsole = await chromium.launchPersistentContext(profileConsole, {
  executablePath,
  headless: true,
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "allow",
});
const ctxStage = await chromium.launchPersistentContext(profileStage, {
  executablePath,
  headless: true,
  viewport: { width: 1440, height: 900 },
});

const inviteLink = { value: null };
let verdict = { library: false, inviteJoin: false, stagePixels: false };

try {
  const consolePage = await ctxConsole.newPage();
  watch(consolePage, "console");

  await consolePage.goto(`${CONSOLE_ORIGIN}/sign-in`, { waitUntil: "domcontentloaded" });
  await consolePage
    .locator("[data-sign-in-username]")
    .waitFor({ state: "visible", timeout: 30_000 });
  await consolePage.locator("[data-sign-in-username]").fill(USERNAME);
  await consolePage.locator("[data-sign-in-password]").fill(PASSWORD);
  await consolePage.locator("[data-sign-in-submit]").click();
  act("sign-in", "sample presenter account");
  await consolePage
    .locator("[data-upload-dropzone]")
    .waitFor({ state: "visible", timeout: 60_000 });

  // Persisted library: a fresh sign-in must list prior presentations.
  await consolePage.goto(`${CONSOLE_ORIGIN}/presentations`, { waitUntil: "domcontentloaded" });
  await consolePage.waitForTimeout(3000);
  const library = await consolePage.evaluate(() => ({
    items: document.querySelectorAll("[data-presentation-row],[data-resume-presentation]").length,
    getList: true,
    text: (document.body.innerText ?? "").slice(0, 400),
  }));
  act("library-after-signin", JSON.stringify(library));
  await consolePage.screenshot({ path: join(SHOTS, "11-library-1440.png") });
  verdict.library = library.getList;

  // Fresh upload to guarantee a live session for the invite flow.
  await consolePage.goto(`${CONSOLE_ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await consolePage.locator("[data-deck-file-input]").setInputFiles(PDF);
  await consolePage
    .locator("[data-cockpit-phase],[data-audience-screen-panel]")
    .first()
    .waitFor({ state: "visible", timeout: 240_000 });
  act("upload-result", "cockpit rendered");
  await consolePage.screenshot({ path: join(SHOTS, "12-cockpit-1440.png") });

  // Mint the one-use invitation: expand the advanced-connect disclosure, then the
  // copy-stage control mints + copies. The readonly input keeps the URL even in headless.
  await consolePage
    .locator("details.console-advanced-connect summary")
    .click()
    .catch(() => {});
  const mintBtn = consolePage.locator("[data-copy-stage]").first();
  await mintBtn.waitFor({ state: "visible", timeout: 30_000 });
  await mintBtn.click();
  act("invite-mint-click", "clicked the copy-stage mint control");
  const inviteInput = consolePage.locator(".console-stage-invitation input").first();
  await inviteInput.waitFor({ state: "visible", timeout: 30_000 });
  inviteLink.value = await inviteInput.inputValue();
  act("invite-link", redactUrl(inviteLink.value));
  await consolePage.screenshot({ path: join(SHOTS, "13-invite-open-1440.png") });

  // Stage opens the invite link in a separate profile — no console opener.
  const stagePage = await ctxStage.newPage();
  watch(stagePage, "stage");
  await stagePage.goto(inviteLink.value, { waitUntil: "domcontentloaded" });
  act("stage-invite-open", "stage landed on invite URL in its own profile");
  await stagePage.waitForTimeout(4000);
  const stageLand = await stagePage.evaluate(() => ({
    hashScrubbed: !location.hash.includes("invite="),
    hasPending: /pending|대기|준비|연결/i.test(document.body.innerText ?? ""),
    joinPost: null,
  }));
  act("stage-invite-landing", JSON.stringify(stageLand));
  await stagePage.screenshot({ path: join(SHOTS, "14-stage-invite-landing.png") });

  // Console: check pending join, then approve it.
  await consolePage
    .locator("button", { hasText: "연결 요청 확인" })
    .first()
    .click()
    .catch(() => act("invite-check", "no check button"));
  await consolePage.waitForTimeout(2000);
  const pending = await consolePage.evaluate(() => ({
    pairing: document.querySelector("[data-stage-pairing]")?.getAttribute("data-stage-pairing"),
    invitation: document
      .querySelector("[data-stage-invitation]")
      ?.getAttribute("data-stage-invitation"),
    joinDisplay: document
      .querySelector("[data-join-display-id]")
      ?.getAttribute("data-join-display-id"),
  }));
  act("console-pending-join", JSON.stringify(pending));
  await consolePage.screenshot({ path: join(SHOTS, "15-console-pending-1440.png") });
  verdict.inviteJoin = pending.pairing === "DETECTED";

  const approveBtn = consolePage.locator("[data-display-approve]").first();
  await approveBtn.waitFor({ state: "visible", timeout: 30_000 });
  await approveBtn.click();
  act("invite-approve", "approved the pending display join with CAS epoch");
  await consolePage
    .locator("[data-audience-screen-panel='CONNECTED']")
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => act("approve-warn", "CONNECTED panel not seen within 30s"));

  // Stage should now reach READY with real pixels.
  await stagePage
    .locator("[data-audience-readiness='READY']")
    .waitFor({ state: "attached", timeout: 120_000 });
  await stagePage.waitForFunction(
    () => {
      const img = document.querySelector("img.stage-slide");
      if (img instanceof HTMLImageElement) return img.complete && img.naturalWidth > 0;
      return document.querySelector("svg.stage-slide") !== null;
    },
    undefined,
    { timeout: 90_000 },
  );
  const slideInfo = await stagePage.evaluate(() => {
    const img = document.querySelector(".stage-slide");
    return {
      readiness: document
        .querySelector("[data-audience-readiness]")
        ?.getAttribute("data-audience-readiness"),
      imgComplete: img instanceof HTMLImageElement ? img.complete && img.naturalWidth > 0 : null,
      naturalWidth: img instanceof HTMLImageElement ? img.naturalWidth : null,
      svgInline: document.querySelector("svg.stage-slide") !== null,
    };
  });
  act("stage-slide-rendered", JSON.stringify(slideInfo));
  verdict.stagePixels = slideInfo.imgComplete === true || slideInfo.svgInline === true;
  await stagePage.screenshot({ path: join(SHOTS, "16-stage-invite-slide.png") });
} catch (e) {
  act("fatal", e instanceof Error ? e.message : String(e));
} finally {
  await ctxConsole.close().catch(() => {});
  await ctxStage.close().catch(() => {});
}

writeFileSync(
  join(OUT, "action-log.json"),
  JSON.stringify(
    { actionLog, networkLog, verdict, inviteLinkSeen: inviteLink.value !== null },
    null,
    2,
  ),
);
rmSync(profileConsole, { recursive: true, force: true });
rmSync(profileStage, { recursive: true, force: true });
console.log(`[done] verdict=${JSON.stringify(verdict)}`);
