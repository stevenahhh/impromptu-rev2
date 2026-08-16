// Drive the running system through the real user flow and capture screenshots.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const privateOrigin = "http://127.0.0.1:4173"; // console-origin proxies /v1 to the private backend
const projectionOrigin = "http://127.0.0.1:4174"; // stage-origin proxies /v1 to the projection gateway
const consoleOrigin = "http://127.0.0.1:4173";
const stageOrigin = "http://127.0.0.1:4174";
const evidence = process.argv[2] ?? join(process.env.TEMP ?? ".", "impromptu-system-evidence");
mkdirSync(evidence, { recursive: true });

const log = [];
function say(line) {
  log.push(line);
  console.log(line);
}
function headers(csrf, cookie) {
  return {
    origin: consoleOrigin,
    referer: `${consoleOrigin}/`,
    "content-type": "application/json",
    ...(csrf === undefined ? {} : { "x-csrf-token": csrf }),
    ...(cookie === undefined ? {} : { cookie }),
  };
}
async function json(response) {
  const body = await response.json();
  return body;
}

// 1) sign in as the controller
const signIn = await fetch(`${privateOrigin}/v1/account-sessions`, {
  method: "POST",
  headers: headers(),
  body: JSON.stringify({ authorizationCode: "local-code" }),
});
const signInBody = await json(signIn);
const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
const csrf = signInBody.csrfToken;
say(`1) 로그인: ${signIn.status} csrf=${typeof csrf === "string" ? "발급" : "없음"}`);
if (!signIn.ok || cookie === undefined) throw new Error("sign-in failed");

// 2) upload a private deck artifact
const upload = await fetch(`${privateOrigin}/v1/deck-artifacts`, {
  method: "POST",
  headers: headers(csrf, cookie),
  body: JSON.stringify({ title: "시스템 점검 덱", content: "렌더러 통합 확인" }),
});
const uploadBody = await json(upload);
say(`2) 덱 업로드: ${upload.status} private=${uploadBody.privateDeck?.privateDeckId ?? "-"} public=${uploadBody.publicDeck?.publicDeckId ?? "-"}`);

// 3) open a presentation lifecycle
const lifecycleResponse = await fetch(`${privateOrigin}/v1/presentation-sessions`, {
  method: "POST",
  headers: headers(csrf, cookie),
  body: JSON.stringify({
    privateDeck: uploadBody.privateDeck,
    publicDeck: uploadBody.publicDeck,
  }),
});
const lifecycle = await json(lifecycleResponse);
say(`3) 발표 세션: ${lifecycleResponse.status} id=${lifecycle.presentationSessionId ?? JSON.stringify(lifecycle).slice(0, 120)}`);

// 4) browser: console + stage
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const consolePage = await context.newPage();
  const consoleErrors = [];
  consolePage.on("pageerror", (error) => consoleErrors.push(error.message));
  await consolePage.goto(consoleOrigin, { waitUntil: "networkidle" });
  await consolePage.screenshot({ path: join(evidence, "console.png"), fullPage: false });
  const consoleTitle = await consolePage.title();
  const consoleText = (await consolePage.locator("body").innerText()).slice(0, 400);
  say(`4) Console 로드: title="${consoleTitle}" errors=${consoleErrors.length}${consoleErrors.length ? " :: " + consoleErrors[0].slice(0, 160) : ""}`);
  say(`   화면 텍스트: ${consoleText.replace(/\n+/g, " | ").slice(0, 240)}`);

  const stagePage = await context.newPage();
  const stageErrors = [];
  stagePage.on("pageerror", (error) => stageErrors.push(error.message));
  await stagePage.goto(stageOrigin, { waitUntil: "networkidle" });
  await stagePage.screenshot({ path: join(evidence, "stage.png"), fullPage: false });
  const stageTitle = await stagePage.title();
  const stageText = (await stagePage.locator("body").innerText()).slice(0, 400);
  say(`5) Stage 로드: title="${stageTitle}" errors=${stageErrors.length}${stageErrors.length ? " :: " + stageErrors[0].slice(0, 160) : ""}`);
  say(`   화면 텍스트: ${stageText.replace(/\n+/g, " | ").slice(0, 240)}`);

  // 5) public surface must refuse private data without a display session
  const unauth = await fetch(`${projectionOrigin}/v1/snapshot`);
  say(`6) 공개 게이트웨이 무인증 접근: ${unauth.status} ${JSON.stringify(await json(unauth))}`);

  say(`SCREENSHOTS: ${join(evidence, "console.png")} , ${join(evidence, "stage.png")}`);
} finally {
  await browser.close();
}
