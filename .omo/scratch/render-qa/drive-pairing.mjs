// End-to-end: sign in on Console, join a display from Stage, approve it, and drive a slide command.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const consoleOrigin = "http://127.0.0.1:4173";
const stageOrigin = "http://127.0.0.1:4174";
const evidence = process.argv[2] ?? join(process.env.TEMP ?? ".", "impromptu-pairing-evidence");
mkdirSync(evidence, { recursive: true });

const say = (line) => console.log(line);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // Stage first: it must produce a join code before anything can be approved.
  const stage = await context.newPage();
  const stageErrors = [];
  stage.on("pageerror", (e) => stageErrors.push(e.message));
  await stage.goto(stageOrigin, { waitUntil: "domcontentloaded" });
  await stage.waitForSelector("body", { state: "attached" });
  await stage.waitForTimeout(1500);
  const codeText = await stage.locator("body").innerText();
  const joinCode = codeText.match(/\b[0-9A-Z]{8}\b/)?.[0];
  say(`1) Stage 조인 코드: ${joinCode ?? "없음"} (pageerror ${stageErrors.length})`);

  // Console: sign in through the real UI.
  const consolePage = await context.newPage();
  const consoleErrors = [];
  consolePage.on("pageerror", (e) => consoleErrors.push(e.message));
  await consolePage.goto(consoleOrigin, { waitUntil: "domcontentloaded" });
  await consolePage.waitForTimeout(1200);
  await consolePage.getByLabel(/One-time sign-in code/i).fill("local-code");
  await consolePage.getByRole("button", { name: /Enter private workspace/i }).click();
  await consolePage.waitForTimeout(2500);
  await consolePage.screenshot({ path: join(evidence, "console-signed-in.png") });
  const afterSignIn = (await consolePage.locator("body").innerText()).replace(/\n+/g, " | ");
  say(`2) Console 로그인 후: ${afterSignIn.slice(0, 300)}`);
  say(`   pageerror ${consoleErrors.length}${consoleErrors[0] ? " :: " + consoleErrors[0].slice(0, 140) : ""}`);

  // Approve the display if the UI exposes it.
  if (joinCode !== undefined) {
    const codeField = consolePage.getByLabel(/display|join|code/i).first();
    if ((await codeField.count()) > 0) {
      await codeField.fill(joinCode);
      const approve = consolePage
        .getByRole("button", { name: /approve|bind|connect|승인/i })
        .first();
      if ((await approve.count()) > 0) {
        await approve.click();
        await consolePage.waitForTimeout(2000);
        say("3) 디스플레이 승인 버튼 클릭됨");
      } else {
        say("3) 승인 버튼을 UI에서 찾지 못함");
      }
    } else {
      say("3) 조인 코드 입력 필드를 UI에서 찾지 못함");
    }
  }

  await consolePage.screenshot({ path: join(evidence, "console-after-approval.png") });
  await stage.reload({ waitUntil: "domcontentloaded" });
  await stage.waitForTimeout(2000);
  await stage.screenshot({ path: join(evidence, "stage-after-approval.png") });
  const stageAfter = (await stage.locator("body").innerText()).replace(/\n+/g, " | ");
  say(`4) Stage 승인 후: ${stageAfter.slice(0, 300)}`);
  say(`EVIDENCE ${evidence}`);
} finally {
  await browser.close();
}
