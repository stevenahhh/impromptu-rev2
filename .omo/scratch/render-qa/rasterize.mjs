// Rasterize our rendered SVG in real Chrome at an exact size, for golden comparison.
// Usage: node rasterize.mjs <renderDir> <slideIndex> <outPng> <width> <height>
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { chromium } from "playwright-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const [renderDir, slideArg, outPng, wArg, hArg] = process.argv.slice(2);
const width = Number(wArg ?? "1920");
const height = Number(hArg ?? "1080");
const manifest = JSON.parse(readFileSync(join(renderDir, "render.json"), "utf8"));
const slide = manifest.slides[Number(slideArg ?? "1") - 1];
if (!slide) throw new Error("slide not found in manifest");

const svgText = readFileSync(join(renderDir, slide.relative_path), "utf8");
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#fff;width:${width}px;height:${height}px;overflow:hidden}
#host{width:${width}px;height:${height}px}
#host svg{width:100%;height:100%;display:block}</style></head>
<body><div id="host">${svgText}</div></body></html>`;

const server = createServer((req, res) => {
  const url = req.url === "/" ? "/index.html" : (req.url ?? "/");
  if (url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  const assetPath = resolve(renderDir, "." + url);
  if (assetPath.startsWith(resolve(renderDir)) && existsSync(assetPath)) {
    const ext = extname(assetPath);
    res.writeHead(200, {
      "content-type":
        ext === ".png" ? "image/png" : ext === ".jpg" ? "image/jpeg" : "application/octet-stream",
    });
    res.end(readFileSync(assetPath));
    return;
  }
  res.writeHead(404).end("no");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.screenshot({ path: outPng });
  console.log(`rasterized -> ${outPng}${errors.length ? ` (page errors: ${errors.join("; ")})` : ""}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
