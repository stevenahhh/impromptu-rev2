// G004 design-sweep capture harness. Task-owned; evidence-only file, never shipped.
// Usage: bun .omo/evidence/ulw/<root>/G004/shots.mjs <scenario> [outDir]
// Scenarios: surfaces | stage | console-flow | full
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const OUT = process.argv[3] ? join(ROOT, process.argv[3]) : join(ROOT, "shots");
const SCENARIO = process.argv[2] ?? "surfaces";
const FAIL_ASSETS = SCENARIO === "stage-failure";
const CHROME =
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const CONSOLE_ORIGIN = process.env.G004_CONSOLE ?? "http://localhost:4180";
const STAGE_ORIGIN = process.env.G004_STAGE ?? "http://localhost:4181";
const DECK = process.env.G004_DECK ?? "tests/fixtures/custom-deck-upload/custom-static-deck.pdf";

const viewports = {
  desktop: { width: 1440, height: 900 },
  present: { width: 1024, height: 768 },
  mobile: { width: 375, height: 812 },
};

const log = (...a) => console.log(`[shots ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function newContext(browser, vp, locale) {
  return browser.newContext({
    viewport: viewports[vp],
    locale,
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
  });
}

async function shot(page, name) {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  log("saved", name);
}

async function signIn(page) {
  await page.goto(`${CONSOLE_ORIGIN}/sign-in`, { waitUntil: "networkidle" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.locator("[data-sign-in-username]").fill("localdemo");
    await page.locator("[data-sign-in-password]").fill("demo-2026-password");
    await page.locator("[data-sign-in-submit]").click();
    const ok = await page
      .waitForSelector("[data-upload-dropzone]", { timeout: 12_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
    // POST /v1/account-sessions throttles repeated sign-ins (429); wait out the window.
    log("sign-in attempt", attempt + 1, "rejected; waiting out the throttle");
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error("sign-in still failing after retries");
}

async function uploadDeck(page) {
  const input = page.locator("[data-deck-file-input]");
  await input.setInputFiles(join(ROOT, "../../../../..", DECK));
  // Upload happens on file selection or via the submit label depending on build; wait for the
  // cockpit preview or an explicit failure status rather than a fixed delay.
  await page.waitForFunction(
    () =>
      document.querySelector(".console-cockpit") !== null ||
      (document.querySelector("[data-upload-status]")?.getAttribute("data-upload-status") ===
        "ERROR"),
    { timeout: 120_000 },
  );
}

// ---------- scenarios ----------

async function surfaces(browser) {
  // Deployed surfaces (before-state of the live build) + local dev surfaces.
  for (const target of [
    { name: "live-console", origin: "http://localhost:4173", path: "/sign-in" },
    { name: "live-stage", origin: "http://localhost:4174", path: "/" },
    { name: "dev-console", origin: CONSOLE_ORIGIN, path: "/sign-in" },
    { name: "dev-stage", origin: STAGE_ORIGIN, path: "/" },
  ]) {
    for (const vp of ["desktop", "mobile"]) {
      const ctx = await newContext(browser, vp, "ko-KR");
      const page = await ctx.newPage();
      try {
        await page.goto(`${target.origin}${target.path}`, {
          waitUntil: "networkidle",
          timeout: 30_000,
        });
        await shot(page, `${target.name}-${vp}-${target.path === "/" ? "root" : target.path.slice(1)}`);
        log(target.name, vp, "title:", await page.title());
      } catch (e) {
        log(target.name, vp, "FAILED:", e.message.split("\n")[0]);
      }
      await ctx.close();
    }
  }
}

async function stage(browser) {
  for (const [vp, locale, tag] of [
    ["desktop", "ko-KR", "ko"],
    ["desktop", "en-US", "en"],
    ["mobile", "ko-KR", "ko"],
    ["mobile", "en-US", "en"],
    ["present", "ko-KR", "ko"],
  ]) {
    for (const suffix of ["", "?lang=en", "?lang=ko"]) {
      const ctx = await newContext(browser, vp, locale);
      const page = await ctx.newPage();
      try {
        await page.goto(`${STAGE_ORIGIN}/${suffix}`, { waitUntil: "networkidle" });
        await shot(page, `stage-landing-${vp}-${tag}${suffix.replace(/[^a-z]/g, "") || "-auto"}`);
      } catch (e) {
        log("stage", vp, tag, suffix, "FAILED:", e.message.split("\n")[0]);
      }
      await ctx.close();
    }
  }
}

async function consoleFlow(browser) {
  const ctx = await newContext(browser, "desktop", "ko-KR");
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") log("console-error:", m.text().slice(0, 160));
  });
  try {
    await page.goto(`${CONSOLE_ORIGIN}/sign-in`, { waitUntil: "networkidle" });
    await shot(page, "console-signin-ko-desktop");
    await page.goto(`${CONSOLE_ORIGIN}/sign-up`, { waitUntil: "networkidle" });
    await shot(page, "console-signup-ko-desktop");
    // English pass
    await page.goto(`${CONSOLE_ORIGIN}/sign-in`, { waitUntil: "networkidle" });
    const enButton = page.locator("button", { hasText: "EN" });
    if (await enButton.count()) {
      await enButton.first().click();
      await shot(page, "console-signin-en-desktop");
    }
    const koButton = page.locator("button", { hasText: "KO" });
    if (await koButton.count()) await koButton.first().click();
    await signIn(page);
    await shot(page, "console-upload-ko-desktop");
    // Retired route compatibility surface — reached via in-app navigation (auth is session
    // state, so a hard reload always lands on sign-in; the interstitial covers the back button).
    await page.evaluate(() => {
      window.history.pushState({}, "", "/live-publication");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page
      .waitForSelector("[data-live-publication-interstitial]", { timeout: 10_000 })
      .catch(() => {});
    await shot(page, "console-interstitial-ko-desktop");
    await page.evaluate(() => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.waitForSelector("[data-upload-dropzone]", { timeout: 10_000 });
    await uploadDeck(page);
    await shot(page, "console-cockpit-ko-desktop");
    // Open the advanced connect disclosure for pairing chrome
    const advanced = page.locator(".console-advanced-connect summary");
    if (await advanced.count()) {
      await advanced.click();
      await shot(page, "console-pairing-ko-desktop");
    }
    // Drive the real opener pairing: data-stage-open pops a Stage window.
    const openBtn = page.locator("[data-stage-open]");
    if (await openBtn.count()) {
      const [popup] = await Promise.all([
        ctx.waitForEvent("page", { timeout: 15_000 }).catch(() => null),
        openBtn.click(),
      ]);
      if (popup !== null) {
        await popup.waitForLoadState("networkidle").catch(() => {});
        await shot(popup, "stage-popup-pairing-desktop");
        // Asset-failure lane: kill every image the Stage fetches so the SLIDE_FAILED
        // recovery state can be photographed live (the snapshot channel is untouched).
        if (FAIL_ASSETS) {
          await ctx.route(
            (url) =>
              url.origin === STAGE_ORIGIN &&
              /\.(png|svg|webp|jpe?g)(\?.*)?$/i.test(url.pathname),
            (route) => route.abort(),
          );
        }
        // Opener-led joins may auto-bind (the open click is the gesture); a pending join
        // still needs the explicit approve press. Take whichever arrives first.
        const approve = page.locator("[data-display-approve]");
        const ready = popup
          .waitForSelector('[data-audience-readiness="READY"]', { timeout: 30_000 })
          .then(() => "ready")
          .catch(() => null);
        const approveSeen = approve
          .waitFor({ timeout: 30_000 })
          .then(() => "approve")
          .catch(() => null);
        const first = await Promise.race([ready, approveSeen]);
        if (first === "approve") {
          await approve.click();
          await popup
            .waitForSelector('[data-audience-readiness="READY"]', { timeout: 30_000 })
            .catch(() => {});
        }
        await shot(popup, "stage-display-ready-desktop");
        await shot(page, "console-bound-ko-desktop");
        if (first !== null) {
          // Start the presentation, then end it to reach the report.
          const startBtn = page.locator("[data-transport-strip] button").first();
          await startBtn.click();
          await page
            .waitForFunction(
              () =>
                document
                  .querySelector("[data-presentation-state]")
                  ?.getAttribute("data-presentation-state") === "PRESENTING",
              { timeout: 20_000 },
            )
            .catch(() => {});
          await shot(page, "console-presenting-ko-desktop");
          await shot(popup, "stage-live-slide-desktop");
          // Advance one slide so the Stage shows slide 2 (playback proof).
          const nextBtn = page
            .locator("[data-transport-strip] button")
            .filter({ hasText: /다음|Next/i });
          if (await nextBtn.count()) {
            await nextBtn.first().click();
            await popup
              .waitForFunction(
                () => (document.body.textContent ?? "").length > 0,
                { timeout: 10_000 },
              )
              .catch(() => {});
            if (FAIL_ASSETS) {
              await popup
                .waitForSelector('[data-audience-readiness="SLIDE_FAILED"]', { timeout: 15_000 })
                .catch(() => {});
            }
            await shot(popup, FAIL_ASSETS ? "stage-slide-failed-desktop" : "stage-slide-two-desktop");
            if (FAIL_ASSETS) {
              // Mobile twin for G006/task-2's asset-failure-mobile.png.
              await popup.setViewportSize(viewports.mobile);
              await shot(popup, "stage-slide-failed-mobile");
            }
          }
          const endBtn = page
            .locator("[data-transport-strip] button")
            .filter({ hasText: /종료|End/i });
          if (await endBtn.count()) {
            await endBtn.first().click();
            await page.waitForURL(/\/reports\//, { timeout: 30_000 }).catch(() => {});
            await page.waitForLoadState("networkidle").catch(() => {});
            await shot(page, "console-report-ko-desktop");
          }
        }
      }
    }
    // English cockpit pass: same flow but in EN to verify translated layout.
    const enToggle = page.locator(".console-language-picker button", { hasText: "EN" });
    if (await enToggle.count()) {
      await enToggle.first().click();
      await page
        .waitForFunction(() => document.body.textContent?.includes("Sign out"), {
          timeout: 5_000,
        })
        .catch(() => {});
      await shot(page, "console-report-en-desktop");
    }
  } catch (e) {
    log("console-flow FAILED:", e.message.split("\n")[0]);
    await shot(page, "console-flow-error");
  }
  await ctx.close();
}

async function consoleFlowCompact(browser) {
  for (const vp of ["present", "mobile"]) {
    const ctx = await newContext(browser, vp, "ko-KR");
    const page = await ctx.newPage();
    try {
      await signIn(page);
      await shot(page, `console-upload-ko-${vp}`);
      await uploadDeck(page);
      await shot(page, `console-cockpit-ko-${vp}`);
      const enToggle = page.locator(".console-language-picker button", { hasText: "EN" });
      if (await enToggle.count()) {
        await enToggle.first().click();
        await shot(page, `console-cockpit-en-${vp}`);
      }
    } catch (e) {
      log(`console-flow-${vp} FAILED:`, e.message.split("\n")[0]);
      await shot(page, `console-${vp}-error`);
    }
    await ctx.close();
  }
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
try {
  if (SCENARIO === "surfaces" || SCENARIO === "full") await surfaces(browser);
  if (SCENARIO === "stage" || SCENARIO === "full") await stage(browser);
  if (SCENARIO === "console-flow" || SCENARIO === "full" || FAIL_ASSETS)
    await consoleFlow(browser);
  if (SCENARIO === "console-flow-compact" || SCENARIO === "full")
    await consoleFlowCompact(browser);
} finally {
  await browser.close();
}
log("done");
