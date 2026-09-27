// G002/C001+C002 real-browser driver for the production Vercel aliases.
// Task-owned Playwright persistent profiles only (never the user's browser).
// Secret discipline: credentials are read from .env inside the process and are
// never written to logs or evidence. URLs are logged with query and fragment
// stripped. Response bodies are never captured; only status codes plus a small
// allowlist of non-secret public fields (epoch/slide counts).

import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/gahn/projects/impromptu-rev2";
const OUT = join(ROOT, ".omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G002/qa-browser");
const SHOTS = join(OUT, "screenshots");
const CONSOLE_ORIGIN = "https://impromptu-rev2-console.vercel.app";
const STAGE_ORIGIN = "https://impromptu-rev2-stage.vercel.app";
const PDF = join(ROOT, "docs/samples/impromptu-sample-deck.pdf");

mkdirSync(SHOTS, { recursive: true });

function env(name) {
  const line = readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  if (line === undefined) throw new Error(`${name} missing from .env`);
  return line.slice(name.length + 1).trim().replace(/^"|"$/g, "");
}
const USERNAME = env("CONTROLLER_USERNAME");
const PASSWORD = env("CONTROLLER_PASSWORD");
const chromeEnv = env("CHROME_EXECUTABLE_PATH");
const executablePath = chromeEnv === "" ? chromium.executablePath() : chromeEnv;

const actionLog = [];
const networkLog = [];
function act(step, detail) {
  const entry = { at: new Date().toISOString(), step, detail };
  actionLog.push(entry);
  console.log(`[act] ${step}: ${detail}`);
}
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}
function watch(page, tag) {
  page.on("response", (res) => {
    try {
      const u = new URL(res.url());
      if (!u.pathname.startsWith("/v1/") && !u.pathname.startsWith("/internal/")) return;
      networkLog.push({
        surface: tag,
        method: res.request().method(),
        host: u.host,
        path: u.pathname,
        status: res.status(),
      });
      console.log(`[net:${tag}] ${res.request().method()} ${u.host}${u.pathname} -> ${res.status()}`);
    } catch {}
  });
}

const profileA = join(OUT, ".profile-console-stage");
const profileB = join(OUT, ".profile-stage-alone");
rmSync(profileA, { recursive: true, force: true });
rmSync(profileB, { recursive: true, force: true });

const ctxA = await chromium.launchPersistentContext(profileA, {
  executablePath,
  headless: true,
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "allow",
});

let stagePage = null;
let independentStageFinding = null;
try {
  const consolePage = await ctxA.newPage();
  watch(consolePage, "console");

  act("navigate", `GET ${CONSOLE_ORIGIN}/sign-in`);
  const signinResp = await consolePage.goto(`${CONSOLE_ORIGIN}/sign-in`, {
    waitUntil: "domcontentloaded",
  });
  act("sign-in-page", `HTTP ${signinResp?.status()}`);
  await consolePage.locator("[data-sign-in-username]").waitFor({ state: "visible", timeout: 30_000 });
  await consolePage.screenshot({ path: join(SHOTS, "01-console-sign-in-1440x900.png") });

  await consolePage.locator("[data-sign-in-username]").fill(USERNAME);
  await consolePage.locator("[data-sign-in-password]").fill(PASSWORD);
  await consolePage.locator("[data-sign-in-submit]").click();
  act("sign-in-submit", "sample presenter account from .env (value not logged)");
  await consolePage.locator("[data-upload-dropzone]").waitFor({ state: "visible", timeout: 60_000 });
  act("sign-in-result", `url=${redactUrl(consolePage.url())}`);

  const h1 = (await consolePage.locator("h1").first().textContent()) ?? "";
  const dropzoneCount = await consolePage.locator("[data-upload-dropzone]").count();
  const sessionListCount = await consolePage
    .locator("[data-session-reentry],[data-presentation-list],[data-resume-presentation]")
    .count();
  act(
    "post-sign-in-surface",
    `h1=${JSON.stringify(h1.trim())} uploadDropzone=${dropzoneCount} reentryControls=${sessionListCount}`,
  );
  await consolePage.screenshot({ path: join(SHOTS, "02-console-workspace-1440x900.png") });

  await consolePage.locator("[data-deck-file-input]").setInputFiles(PDF);
  act("deck-upload", "docs/samples/impromptu-sample-deck.pdf via [data-deck-file-input]");
  await consolePage
    .locator("[data-cockpit-phase],[data-audience-screen-panel]")
    .first()
    .waitFor({ state: "visible", timeout: 240_000 });
  act("upload-result", "cockpit rendered; active presentation set client-side");
  await consolePage.screenshot({ path: join(SHOTS, "03-console-cockpit-1440x900.png") });

  // The deployed Stage only pairs through the Console-opener handshake: click
  // the primary action, which calls window.open as its first statement.
  const popupPromise = ctxA.waitForEvent("page", { timeout: 60_000 });
  await consolePage.locator(".console-primary-action button").first().click();
  act("start-presentation", "clicked primary action (opens Stage window + binds)");
  stagePage = await popupPromise;
  watch(stagePage, "stage");
  act("stage-popup", `opened url=${redactUrl(stagePage.url())}`);

  await stagePage.waitForLoadState("domcontentloaded");
  await stagePage
    .locator("[data-audience-readiness='READY']")
    .waitFor({ state: "attached", timeout: 120_000 });
  act("stage-ready", "data-audience-readiness=READY (snapshot validated, hash-checked)");

  // READY means the snapshot parsed; the raster fetch is separate. Wait for real pixels.
  await stagePage.waitForFunction(
    () => {
      const img = document.querySelector("img.stage-slide");
      if (img instanceof HTMLImageElement) return img.complete && img.naturalWidth > 0;
      return document.querySelector("svg.stage-slide") !== null;
    },
    undefined,
    { timeout: 90_000 },
  );
  act("stage-pixels", "slide image complete with naturalWidth>0 (or inline svg)");

  const slideInfo = await stagePage.evaluate(() => {
    const img = document.querySelector(".stage-slide");
    const surface = document.querySelector("[data-stage-slide-surface]");
    return {
      readiness: document.querySelector("[data-audience-readiness]")?.getAttribute("data-audience-readiness"),
      blackout: document.querySelector("[data-blackout]")?.getAttribute("data-blackout"),
      surface: surface?.getAttribute("data-stage-slide-surface") ?? null,
      ariaLabel: surface?.getAttribute("aria-label") ?? null,
      imgTag: img?.tagName ?? null,
      imgPath: img instanceof HTMLImageElement ? new URL(img.src).pathname : null,
      imgComplete: img instanceof HTMLImageElement ? img.complete && img.naturalWidth > 0 : null,
      naturalWidth: img instanceof HTMLImageElement ? img.naturalWidth : null,
      svgInline: document.querySelector("svg.stage-slide") !== null,
    };
  });
  act("stage-slide-rendered", JSON.stringify(slideInfo));
  if (slideInfo.imgComplete !== true && slideInfo.svgInline !== true) {
    throw new Error("Stage reached READY but no slide pixels: " + JSON.stringify(slideInfo));
  }

  await stagePage.screenshot({ path: join(SHOTS, "04-stage-slide-1440x900.png") });
  await consolePage.screenshot({ path: join(SHOTS, "05-console-presenting-1440x900.png") });
  act("screenshot", "desktop 1440x900 captured for stage + console");

  // Advance one slide from the presenter side to prove presenter->audience control.
  const firstImgPath = slideInfo.imgPath;
  const nextBtn = consolePage.locator(".console-playback-actions button").nth(1);
  await nextBtn.click();
  act("next-slide", "clicked next slide in console");
  await stagePage
    .waitForFunction(
      (prev) => {
        const img = document.querySelector("img.stage-slide");
        return img && new URL(img.src).pathname !== prev;
      },
      firstImgPath,
      { timeout: 30_000 },
    )
    .catch(() => act("next-slide-warn", "slide image did not change within 30s"));
  const slide2 = await stagePage.evaluate(() => {
    const img = document.querySelector("img.stage-slide");
    return img instanceof HTMLImageElement ? new URL(img.src).pathname : null;
  });
  act("next-slide-result", `stage img path ${firstImgPath} -> ${slide2}`);
  await stagePage.screenshot({ path: join(SHOTS, "06-stage-slide2-1440x900.png") });

  // Mobile viewport evidence.
  await stagePage.setViewportSize({ width: 375, height: 812 });
  await stagePage.evaluate(async () => {
    await Promise.race([
      Promise.allSettled(document.getAnimations().map((a) => a.finished)),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  });
  await stagePage.screenshot({ path: join(SHOTS, "07-stage-slide-375x812.png") });
  await consolePage.setViewportSize({ width: 375, height: 812 });
  await consolePage.screenshot({ path: join(SHOTS, "08-console-375x812.png") });
  act("screenshot", "mobile 375x812 captured for stage + console");

  // Snapshot endpoint verification from inside the bound stage page (redacted).
  const snap = await stagePage.evaluate(async () => {
    const r = await fetch("/v1/snapshot", { credentials: "include" });
    if (!r.ok) return { status: r.status };
    const b = await r.json();
    return {
      status: r.status,
      role: b.role,
      slideCount: Array.isArray(b.deck?.slides) ? b.deck.slides.length : null,
      occurrenceKey: b.occurrence?.publicSlideKey ?? null,
      blackout: b.blackout,
      displayBindingEpoch: b.displayBindingEpoch,
      presentationSessionId: b.presentationSessionId,
    };
  });
  act("stage-snapshot-authenticated", JSON.stringify(snap));
} finally {
  await ctxA.close().catch(() => {});
}

// Independent task-owned profile: prove a Stage window that was NOT opened by
// the console stays inert (the deployed build has no #invite consumption).
try {
  const ctxB = await chromium.launchPersistentContext(profileB, {
    executablePath,
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await ctxB.newPage();
    watch(page, "stage-alone");
    await page.goto(`${STAGE_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const landing = await page.evaluate(() => ({
      consoleOnly: document.querySelector("main.stage-console-only") !== null,
      joinAttempts: performance.getEntriesByType("resource").filter((e) => e.name.includes("/v1/")).length,
      bodyText: (document.body.innerText ?? "").trim().slice(0, 160),
    }));
    act("stage-alone-landing", JSON.stringify(landing));
    await page.screenshot({ path: join(SHOTS, "09-stage-alone-1440x900.png") });

    const snapProbe = await page.evaluate(async () => {
      const r = await fetch("/v1/snapshot", { credentials: "include" });
      return { status: r.status };
    });
    act("stage-alone-snapshot-probe", `GET /v1/snapshot (no display cookie) -> ${snapProbe.status}`);

    await page.goto(`${STAGE_ORIGIN}/display/rehearsal`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const disp = await page.evaluate(() => ({
      readiness: document.querySelector("[data-audience-readiness]")?.getAttribute("data-audience-readiness") ?? null,
      heading: document.querySelector("h1")?.textContent ?? null,
    }));
    act("stage-alone-display-route", JSON.stringify(disp));
    await page.screenshot({ path: join(SHOTS, "10-stage-alone-display-1440x900.png") });
    independentStageFinding = { landing, snapProbe, disp };
  } finally {
    await ctxB.close().catch(() => {});
  }
} catch (e) {
  act("stage-alone-error", e instanceof Error ? e.message : String(e));
}

writeFileSync(join(OUT, "action-log.json"), JSON.stringify({ actionLog, networkLog, independentStageFinding }, null, 2));
rmSync(profileA, { recursive: true, force: true });
rmSync(profileB, { recursive: true, force: true });
console.log("[done] evidence written; profiles removed");
