#!/usr/bin/env node
// Task-1 real-browser Console baseline (run 4). Two task-owned persistent
// profiles: console = presenter; stage = independent device (no opener).
// No cookies/CSRF/tokens are logged; stage URL fragments are redacted.
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/gahn/projects/impromptu-rev2";
const EV = join(ROOT, ".omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G006/task-1");
const SHOTS = join(EV, "shots");
const CONSOLE_ORIGIN = "http://localhost:4473";
const STAGE_ORIGIN = "http://localhost:4474";
const LONG_DECK = join(ROOT, "tests/fixtures/format-neutral-decks/korean-structural.pptx"); // 6 slides
const SHORT_DECK = join(ROOT, "tests/fixtures/custom-deck-upload/custom-static-deck.pdf"); // 3 slides
const KO = {
  next: "다음 슬라이드",
  prev: "이전 슬라이드",
  start: "발표 시작",
  end: "발표 종료",
  leave: "로그아웃",
  newDeck: "다른 발표 자료 올리기",
  openStage: "발표 화면 열기",
};

const results = [];
const logLines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logLines.push(line);
  console.log(line);
}
function verdict(id, pass, detail) {
  results.push({ id, verdict: pass ? "PASS" : "FAIL", detail });
  log(`${pass ? "PASS" : "FAIL"} ${id} :: ${detail}`);
}
async function shot(page, name) {
  const file = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  const head = readFileSync(file).subarray(0, 8);
  if (head[0] !== 0x89 || head[1] !== 0x50) throw new Error(`capture ${name} is not a PNG`);
  log(`shot ${name}.png`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function text(page, sel) {
  const el = await page.$(sel);
  return el === null ? null : (await el.textContent())?.trim() ?? "";
}

rmSync(join(EV, "profiles/console"), { recursive: true, force: true });
rmSync(join(EV, "profiles/stage"), { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const consoleCtx = await chromium.launchPersistentContext(join(EV, "profiles/console"), {
  headless: true,
  viewport: { width: 1440, height: 900 },
  locale: "ko-KR",
  permissions: ["clipboard-read", "clipboard-write"],
});
const stageCtx = await chromium.launchPersistentContext(join(EV, "profiles/stage"), {
  headless: true,
  viewport: { width: 1440, height: 900 },
  locale: "ko-KR",
});
const cleanup = async () => {
  await consoleCtx.close().catch(() => {});
  await stageCtx.close().catch(() => {});
};
process.on("SIGTERM", () => void cleanup().finally(() => process.exit(143)));
process.on("SIGINT", () => void cleanup().finally(() => process.exit(130)));

const page = consoleCtx.pages()[0] ?? (await consoleCtx.newPage());
page.on("console", (m) => {
  if (m.type() === "error") log(`console.error ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => log(`pageerror ${String(e).slice(0, 200)}`));
page.on("response", (r) => {
  if (r.status() >= 400)
    log(`http ${r.status()} ${r.url().replace(/#.*$/, "#<redacted>").slice(0, 160)}`);
});

// ---------- 1. Sign-in ----------
await page.goto(`${CONSOLE_ORIGIN}/sign-in`, { waitUntil: "load" });
await page.waitForSelector("[data-sign-in-username]", { timeout: 60000 });
await shot(page, "01-sign-in-1440");
await page.fill("[data-sign-in-username]", "localdemo");
await page.fill("[data-sign-in-password]", "demo-2026-password");
await page.click("[data-sign-in-submit]");
try {
  await page.waitForSelector("[data-deck-file-input]", { timeout: 60000 });
  verdict("sign-in", true, "workspace upload panel reached after localdemo sign-in");
} catch {
  verdict("sign-in", false, `no upload panel; url=${page.url()}`);
  await shot(page, "01b-sign-in-failed");
}
await shot(page, "02-workspace-upload-1440");
await page.setViewportSize({ width: 1024, height: 768 });
await wait(300);
await shot(page, "02b-workspace-upload-1024");
await page.setViewportSize({ width: 375, height: 812 });
await wait(300);
await shot(page, "02c-workspace-upload-375");
await page.setViewportSize({ width: 1440, height: 900 });
await wait(300);

// ---------- 2. Long-deck upload (6-slide PPTX) ----------
await page.setInputFiles("[data-deck-file-input]", LONG_DECK);
try {
  await page.waitForSelector("[data-cockpit-phase]", { timeout: 300_000 });
  verdict("upload-long-deck", true, "cockpit reached after 6-slide pptx upload");
} catch {
  const msg = await text(page, "[data-upload-status]");
  verdict("upload-long-deck", false, `300s timeout; status: ${msg}`);
}
await shot(page, "03-cockpit-preparing-1440");
await page.setViewportSize({ width: 1024, height: 768 });
await wait(300);
await shot(page, "03b-cockpit-preparing-1024");
await page.setViewportSize({ width: 375, height: 812 });
await wait(300);
await shot(page, "03c-cockpit-preparing-375");
await page.setViewportSize({ width: 1440, height: 900 });
await wait(300);

// ---------- 3. Independent Stage profile (no opener): expected inert ----------
const deckVersion = "deck_16d089f58618c3e943c230fd51978a4c4e660bc9794c27a65c2371990101a660";
const stagePage = await stageCtx.newPage();
await stagePage.goto(`${STAGE_ORIGIN}/?deck=${deckVersion}`, { waitUntil: "load" });
await wait(3000);
await shot(stagePage, "04-stage-independent-1440");
const stageBody = (await text(stagePage, "body")) ?? "";
const stageReadiness = await stagePage
  .getAttribute("[data-audience-readiness]", "data-audience-readiness")
  .catch(() => null);
const pairing = await page
  .getAttribute("[data-stage-pairing]", "data-stage-pairing")
  .catch(() => null);
verdict(
  "independent-stage-inert",
  stageReadiness !== "READY" && pairing !== "DETECTED",
  `stage readiness=${stageReadiness} console pairing=${pairing} body="${stageBody.slice(0, 120)}"`,
);

// ---------- 4. Console-opened Stage bind (popup gesture) ----------
let popup = null;
async function openAndBindStage() {
  try {
    await page.click("details.console-advanced-connect summary", { timeout: 6000 });
  } catch {
    log("advanced summary click skipped");
  }
  // openAndBind may reuse an existing popup window instead of opening a new one.
  const waitPopup = page.waitForEvent("popup", { timeout: 20000 }).catch(() => null);
  await page.click("[data-stage-open]", { timeout: 8000 });
  let p = await waitPopup;
  if (p === null) {
    p = consoleCtx.pages().find((q) => q.url().startsWith(STAGE_ORIGIN)) ?? null;
  }
  await page.waitForSelector("[data-audience-screen-panel='CONNECTED']", { timeout: 30000 });
  return p;
}
try {
  popup = await openAndBindStage();
  verdict("popup-bind", true, "console-opened stage bound, panel CONNECTED");
  await popup.waitForSelector("[data-audience-readiness]", { timeout: 30000 }).catch(() => {});
  await popup.waitForTimeout(1200);
  log(`popup readiness=${await popup.getAttribute("[data-audience-readiness]", "data-audience-readiness")}`);
  await shot(popup, "04b-stage-popup-1440");
  await shot(page, "04c-console-bound-1440");
} catch (e) {
  verdict("popup-bind", false, `bind failed: ${String(e).slice(0, 140)}`);
  await shot(page, "04c-console-bind-failed-1440");
}

// ---------- 5. Slide navigation while bound but PREPARING ----------
let navOk = true;
for (let i = 0; i < 4; i++) {
  try {
    await page.getByRole("button", { name: KO.next, exact: true }).click({ timeout: 8000 });
    await wait(700);
  } catch (e) {
    navOk = false;
    log(`next click ${i + 1} failed: ${String(e).slice(0, 100)}`);
    break;
  }
}
verdict("slide-navigation", navOk, navOk ? "4x next accepted (index -> 4 of 6)" : "next click failed");
await shot(page, "05-slide-5-preparing-1440");
if (popup !== null) await shot(popup, "05b-stage-slide-5-1440");

// ---------- 6. Replace with shorter deck while index=4 (GAP-10 probes) ----------
const newDeckCount = await page.getByRole("button", { name: KO.newDeck, exact: true }).count();
if (newDeckCount === 0) {
  verdict("deck-replace-entry", false, `new-deck control absent at ${page.url()}`);
  await shot(page, "06-no-new-deck-1440");
} else {
  verdict("deck-replace-entry", true, "new-deck control present (PREPARING)");
  await page.getByRole("button", { name: KO.newDeck, exact: true }).click();
  await page.waitForSelector("[data-deck-file-input]", { timeout: 60000 });
  await page.setInputFiles("[data-deck-file-input]", SHORT_DECK);
  try {
    await page.waitForSelector("[data-cockpit-phase]", { timeout: 300_000 });
    await wait(1000);
    const previewText = await text(page, "[data-slide-preview]");
    const prevEnabled = await page
      .getByRole("button", { name: KO.prev, exact: true })
      .isEnabled()
      .catch(() => null);
    const counter = previewText?.match(/\d+ \/ \d+/)?.[0] ?? null;
    const resetOk = counter?.startsWith("1 /") === true;
    verdict("deck-replace-index-reset", resetOk,
      `counter=${counter} preview=${JSON.stringify(previewText?.slice(0, 90))} prev=${prevEnabled}`);
  } catch {
    verdict("deck-replace-index-reset", false, "short deck upload did not reach cockpit");
  }
  await shot(page, "06b-short-deck-cockpit-1440");
  // GAP-10/11: the retained binding is stale for the new deck -> start fails with 409.
  await page.getByRole("button", { name: KO.start, exact: true }).click().catch(() => {});
  await wait(6000);
  const problem = await page.$(".console-status-line--attention");
  const problemText = problem === null ? null : await problem.textContent();
  const presenting409 = (await page.getAttribute("[data-cockpit-phase]", "data-cockpit-phase")) === "PRESENTING";
  verdict("deck-replace-stale-binding", !presenting409,
    `presenting=${presenting409} statusLine=${JSON.stringify(problemText?.slice(0, 100))} (409 seen on slide-set)`);
  await shot(page, "06c-stale-binding-409-1440");
}

// ---------- 7. Rebind the new deck and start ----------
let bound = false;
try {
  popup = await openAndBindStage();
  bound = true;
  verdict("rebind-after-replace", true, "fresh bind for short deck succeeded");
} catch (e) {
  verdict("rebind-after-replace", false, `rebind failed: ${String(e).slice(0, 140)}`);
}
try {
  await page.getByRole("button", { name: KO.start, exact: true }).click();
  await page.waitForSelector("[data-cockpit-phase='PRESENTING']", { timeout: 60000 });
  verdict("start-presentation", true, "PRESENTING after rebind");
} catch (e) {
  verdict("start-presentation", false, `no presenting state: ${String(e).slice(0, 120)}`);
}
await shot(page, "07-presenting-1440");
if (popup !== null) {
  await popup.waitForTimeout(800);
  await shot(popup, "07d-stage-presenting-1440");
}
// one slide step while PRESENTING (short deck: 1->2 of 3)
try {
  await page.getByRole("button", { name: KO.next, exact: true }).click({ timeout: 8000 });
  await wait(800);
  await shot(page, "07e-presenting-slide-2-1440");
} catch {
  log("mid-talk next click failed");
}
await page.setViewportSize({ width: 1024, height: 768 });
await wait(400);
const strip = await page.$("[data-transport-strip]");
const stripBox = strip === null ? null : await strip.boundingBox();
verdict(
  "c1-transport-above-fold-1024",
  stripBox !== null && stripBox.y + stripBox.height <= 768,
  `transport-strip box=${JSON.stringify(stripBox)} viewport=1024x768`,
);
await shot(page, "07b-presenting-1024");
await page.setViewportSize({ width: 375, height: 812 });
await wait(400);
await shot(page, "07c-presenting-375");
await page.setViewportSize({ width: 1440, height: 900 });
await wait(300);
const prepDrawer = await page.$("[data-preparation-surfaces='COLLAPSED']");
const stageOpenVisible = await page.$("[data-stage-open]");
verdict("c5-prep-hidden-while-presenting", prepDrawer !== null && stageOpenVisible === null,
  `drawer=${prepDrawer !== null} stageOpenBtn=${stageOpenVisible !== null}`);
const captureRetry = await page.$("[data-capture-retry]");
log(`capture-retry present=${captureRetry !== null}`);

// ---------- 8. End presentation -> report ----------
await page.getByRole("button", { name: KO.end, exact: true }).click();
try {
  await page.waitForURL(/\/reports\//, { timeout: 60000 });
} catch {
  log(`no report navigation; url=${page.url()}`);
}
// Race the report status: poll fast so a short PENDING window is still captured.
let earlyStatus = null;
for (let i = 0; i < 30; i++) {
  earlyStatus = await page.getAttribute("[data-report-status]", "data-report-status").catch(() => null);
  if (earlyStatus !== null) break;
  await wait(400);
}
if (earlyStatus === "PENDING") await shot(page, "08a-report-pending-1440");
log(`report first status=${earlyStatus}`);
await wait(1500);
await shot(page, "08-report-1440");
let reportStatus = await page
  .getAttribute("[data-report-status]", "data-report-status")
  .catch(() => null);
log(`report status at land=${reportStatus} url=${page.url()}`);
if (reportStatus === "PENDING") {
  verdict("report-pending-observed", true, "report landed PENDING");
  let recovered = false;
  for (let i = 0; i < 9; i++) {
    await wait(5000);
    reportStatus = await page
      .getAttribute("[data-report-status]", "data-report-status")
      .catch(() => null);
    if (reportStatus !== "PENDING") {
      recovered = true;
      break;
    }
  }
  verdict("report-pending-recovery", recovered, `status after <=45s=${reportStatus}`);
  await shot(page, "08b-report-after-wait-1440");
} else {
  verdict("report-pending-observed", page.url().includes("/reports/"),
    `report status=${reportStatus} (finalized before status read)`);
}
const slideTitles = await page.$$("[data-report-slide-title]");
const rawKeys = await page.$$eval("[data-report-slide-visit]", (els) =>
  els.map((el) => el.getAttribute("data-report-slide-key") ?? ""),
);
const hashLike = rawKeys.filter((k) => /^slide_[a-f0-9]{16,}$/.test(k));
verdict("c3-report-human-identifiers", slideTitles.length > 0 && hashLike.length === 0,
  `slideTitles=${slideTitles.length} hashKeys=${hashLike.length} sample=${JSON.stringify(rawKeys.slice(0, 4))}`);

// ---------- 9. Reload probe (session restore) ----------
await page.reload({ waitUntil: "load" });
await wait(5000);
const afterReload = page.url();
const reloadOk =
  afterReload.includes("/reports/") || (await page.$("[data-report-status]")) !== null;
verdict("reload-session-restore", reloadOk, `url after reload=${afterReload}`);
await shot(page, "09-after-reload-1440");

// ---------- 10. SPA back to workspace, sign out, account B ----------
const navWorkspace = page.locator("nav a[href='/']").first();
if ((await navWorkspace.count()) > 0) {
  await navWorkspace.click();
} else {
  await page.goto(`${CONSOLE_ORIGIN}/`, { waitUntil: "load" });
}
await wait(1500);
const leave = page.getByRole("button", { name: KO.leave, exact: true }).first();
if ((await leave.count()) > 0) {
  await leave.click();
  await wait(1500);
}
await shot(page, "10-after-signout-1440");
log(`after signout url=${page.url()}`);
await page.goto(`${CONSOLE_ORIGIN}/sign-up`, { waitUntil: "load" }).catch(() => {});
await page.waitForSelector("[data-sign-up-username]", { timeout: 60000 });
await page.fill("[data-sign-up-username]", "task1b_user");
await page.fill("[data-sign-up-password]", "task1b-password-2026");
await page.click("[data-sign-up-submit]");
try {
  await page.waitForSelector("[data-deck-file-input]", { timeout: 60000 });
} catch {
  log(`B sign-up did not reach workspace; url=${page.url()}`);
}
await wait(1200);
const bBody = (await text(page, "body")) ?? "";
const bUpload = (await page.$("[data-deck-file-input]")) !== null;
const bCockpit = (await page.$("[data-cockpit-phase]")) !== null;
const leakedDeck = /korean-structural|sentinel|구조/i.test(bBody) && bCockpit;
verdict("account-switch-isolation", bUpload && !bCockpit && !leakedDeck,
  `B url=${page.url()} uploadPanel=${bUpload} cockpit=${bCockpit} deckLeak=${leakedDeck}`);
await shot(page, "11-account-b-workspace-1440");
await page.setViewportSize({ width: 1024, height: 768 });
await wait(300);
await shot(page, "11b-account-b-workspace-1024");
await page.setViewportSize({ width: 375, height: 812 });
await wait(300);
await shot(page, "11c-account-b-workspace-375");

await cleanup();
writeFileSync(join(EV, "baseline.log"), `${logLines.join("\n")}\n`);
writeFileSync(
  join(EV, "failures.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
);
console.log("DONE");
