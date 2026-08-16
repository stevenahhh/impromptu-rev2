// Walk the Console's real navigation to find and complete the display approval flow.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const consoleOrigin = "http://127.0.0.1:4173";
const stageOrigin = "http://127.0.0.1:4174";
const evidence = process.argv[2] ?? join(process.env.TEMP ?? ".", "impromptu-approval-evidence");
mkdirSync(evidence, { recursive: true });
const say = (line) => console.log(line);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const stage = await context.newPage();
  await stage.goto(stageOrigin, { waitUntil: "domcontentloaded" });
  await stage.waitForTimeout(1500);
  const stageText = await stage.locator("body").innerText();
  const joinCode = stageText.match(/DISPLAY JOIN CODE\s*\n?\s*([0-9A-F]{8})/)?.[1];
  say(`1) Stage 조인 코드: ${joinCode ?? "미발급"}`);

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(consoleOrigin, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await page.getByLabel(/One-time sign-in code/i).fill("local-code");
  await page.getByRole("button", { name: /Enter private workspace/i }).click();
  await page.waitForTimeout(2000);

  for (const section of ["Session setup", "Live approval"]) {
    const link = page.getByRole("button", { name: section }).or(page.getByText(section, { exact: true })).first();
    if ((await link.count()) === 0) {
      say(`2) "${section}" 진입 실패: 요소 없음`);
      continue;
    }
    await link.click();
    await page.waitForTimeout(1800);
    const text = (await page.locator("body").innerText()).replace(/\n+/g, " | ");
    say(`2) "${section}" 화면: ${text.slice(0, 420)}`);
    await page.screenshot({ path: join(evidence, `console-${section.replace(/\s+/g, "-").toLowerCase()}.png`) });

    // Try to complete an approval on this screen.
    const inputs = page.locator("input:visible");
    const inputCount = await inputs.count();
    for (let i = 0; i < inputCount; i += 1) {
      const label = (await inputs.nth(i).getAttribute("aria-label")) ?? (await inputs.nth(i).getAttribute("placeholder")) ?? "";
      say(`   입력 필드[${i}]: "${label}"`);
      if (joinCode !== undefined && /code|디스플레이|display|join/i.test(label)) {
        await inputs.nth(i).fill(joinCode);
        say(`   -> 조인 코드 입력함`);
      }
    }
    const buttons = page.getByRole("button");
    const names = [];
    for (let i = 0; i < (await buttons.count()); i += 1) {
      const name = (await buttons.nth(i).innerText()).trim();
      if (name) names.push(name);
    }
    say(`   버튼: ${names.join(" / ").slice(0, 300)}`);
    const approve = page.getByRole("button", { name: /approve|승인|bind|pair|confirm/i }).first();
    if ((await approve.count()) > 0) {
      await approve.click();
      await page.waitForTimeout(2500);
      say(`   -> 승인 버튼 클릭`);
      await page.screenshot({ path: join(evidence, "console-approved.png") });
      break;
    }
  }

  await stage.reload({ waitUntil: "domcontentloaded" });
  await stage.waitForTimeout(2500);
  await stage.screenshot({ path: join(evidence, "stage-final.png") });
  const finalText = (await stage.locator("body").innerText()).replace(/\n+/g, " | ");
  say(`3) Stage 최종: ${finalText.slice(0, 400)}`);
  say(`   Console pageerror: ${errors.length}`);
  say(`EVIDENCE ${evidence}`);
} finally {
  await browser.close();
}
