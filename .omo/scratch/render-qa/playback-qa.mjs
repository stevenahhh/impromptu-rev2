// Criterion 4 QA: play a rendered slide's timeline in real Chrome and capture the visual delta.
// Usage: node playback-qa.mjs <renderOutputDir> <slideIndex> <evidenceDir>
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { chromium } from "playwright-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const REPO = "C:/Users/steve/Desktop/projects/impromptu-r2";

const [renderDir, slideArg, evidenceDir] = process.argv.slice(2);
if (!renderDir || !evidenceDir) {
  console.error("usage: node playback-qa.mjs <renderOutputDir> <slideIndex> <evidenceDir>");
  process.exit(2);
}
const slideIndex = Number(slideArg ?? "1");
mkdirSync(evidenceDir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(renderDir, "render.json"), "utf8"));
const slide = manifest.slides[slideIndex - 1];
if (!slide) throw new Error(`slide ${slideIndex} missing from manifest`);
const timeline =
  (manifest.timelines ?? []).find((t) => t.slide_key === slide.slide_key) ?? {
    slide_key: slide.slide_key,
    click_groups: [],
    transition: null,
    unsupported: [],
  };
console.log(
  `slide ${slideIndex}: ${slide.relative_path} | click groups: ${timeline.click_groups.length} | unsupported: ${timeline.unsupported.length}`,
);

const playerBundle = join(evidenceDir, "player.js");
const { spawnSync } = await import("node:child_process");
const build = spawnSync(
  "bun",
  [
    "build",
    join(REPO, "packages/slide-runtime/src/index.ts"),
    "--outfile",
    playerBundle,
    "--format",
    "esm",
    "--target",
    "browser",
  ],
  { encoding: "utf8", shell: true },
);
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  throw new Error("player bundle build failed");
}
console.log(`player bundle: ${playerBundle}`);

const page_html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>slide playback qa</title>
<style>html,body{margin:0;background:#fff}#host{width:100vw;height:100vh}svg{width:100%;height:100%}</style>
</head><body><div id="host"></div>
<script type="module">
import { createSlidePlayer, parseSlideTimeline } from "./player.js";
const svgText = await (await fetch("./slide.svg")).text();
document.getElementById("host").innerHTML = svgText;
const svgRoot = document.querySelector("#host svg");
const timeline = parseSlideTimeline(await (await fetch("./timeline.json")).json());
const player = createSlidePlayer({ svgRoot, timeline });
window.__player = player;
window.__ready = true;
</script></body></html>`;

const svgText = readFileSync(join(renderDir, slide.relative_path), "utf8");
const files = new Map([
  ["/index.html", { body: page_html, type: "text/html; charset=utf-8" }],
  ["/slide.svg", { body: svgText, type: "image/svg+xml" }],
  ["/timeline.json", { body: JSON.stringify(timeline), type: "application/json" }],
  ["/player.js", { body: readFileSync(playerBundle, "utf8"), type: "text/javascript" }],
]);

const server = createServer((req, res) => {
  const url = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
  const direct = files.get(url);
  if (direct) {
    res.writeHead(200, { "content-type": direct.type });
    res.end(direct.body);
    return;
  }
  // assets referenced by the SVG (externalized images) resolve from the render dir
  const assetPath = resolve(renderDir, "." + url);
  if (assetPath.startsWith(resolve(renderDir)) && existsSync(assetPath)) {
    const ext = extname(assetPath);
    const type =
      ext === ".png" ? "image/png" : ext === ".jpg" ? "image/jpeg" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(readFileSync(assetPath));
    return;
  }
  res.writeHead(404).end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}/`;
console.log(`serving ${origin}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const log = [];
let failures = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (m) => log.push(`[console:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => {
    log.push(`[pageerror] ${e.message}`);
    failures += 1;
  });
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction("window.__ready === true", null, { timeout: 15000 });

  const shots = [];
  const shot = async (name) => {
    const file = join(evidenceDir, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
    log.push(`screenshot ${name} -> ${file}`);
    return file;
  };
  await shot("00-initial");

  const groups = await page.evaluate("window.__player.groupCount");
  log.push(`groupCount=${groups}`);
  for (let i = 1; i <= groups; i += 1) {
    await page.evaluate("window.__player.advance()");
    await page.waitForFunction(`window.__player.currentGroup === ${i}`, null, { timeout: 15000 });
    await shot(`${String(i).padStart(2, "0")}-after-click-${i}`);
  }

  // pixel delta between consecutive screenshots proves something actually animated
  const deltas = [];
  for (let i = 1; i < shots.length; i += 1) {
    const a = readFileSync(shots[i - 1]);
    const b = readFileSync(shots[i]);
    const changed = a.length !== b.length || !a.equals(b);
    deltas.push(`${i}: ${changed ? "CHANGED" : "IDENTICAL"}`);
    if (!changed) failures += 1;
  }
  log.push(`frame deltas: ${deltas.join(", ")}`);
  writeFileSync(join(evidenceDir, "action-log.txt"), log.join("\n"), "utf8");
  console.log(log.join("\n"));
  console.log(failures === 0 ? "PLAYBACK QA: PASS" : `PLAYBACK QA: FAIL (${failures})`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
process.exit(failures === 0 ? 0 : 1);
