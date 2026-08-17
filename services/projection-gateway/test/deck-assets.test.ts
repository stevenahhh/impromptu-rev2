import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectionGatewayConfig } from "../src/config.ts";
import {
  createDeckAssetReader,
  createProjectionGatewayHandler,
  type ProjectionGatewayHandler,
} from "../src/http.ts";
import { PreparedEvidenceProjectionGateway } from "../src/prepared-evidence.ts";

// Public deck artifact containment contract.
//
// GET /v1/deck-assets/:artifactId/*artifactPath must:
//   - serve only assets contained inside the deck store root as immutable bytes
//     with the exact MIME type for the extension and Stage CORS headers;
//   - reject encoded separators and traversal segments with 400
//     invalid_asset_path;
//   - reject unknown manifest hashes and unknown artifacts with 404
//     asset_not_found;
//   - reject artifacts whose resolved path escapes the deck store root
//     (symlink escape) with 403 asset_escape_forbidden.
//
const origin = "https://stage.example.test";
const service = "https://projection.example.test";
const MANIFEST_HASH = "a".repeat(64);
const UNKNOWN_HASH = "f".repeat(64);

const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WOFF2_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]);
const FONT_BYTES = new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0]);

let parentDir!: string;
let handler!: ProjectionGatewayHandler;

beforeAll(() => {
  parentDir = mkdtempSync(join(tmpdir(), "deck-assets-"));
  const storeRoot = join(parentDir, "store");
  const manifestDir = join(storeRoot, MANIFEST_HASH);
  mkdirSync(join(manifestDir, "slides"), { recursive: true });
  mkdirSync(join(manifestDir, "fonts"), { recursive: true });
  writeFileSync(join(manifestDir, "slides", "slide-01.svg"), SVG_BYTES);
  writeFileSync(join(manifestDir, "slides", "cover.png"), PNG_BYTES);
  writeFileSync(join(manifestDir, "fonts", "display-font.woff2"), WOFF2_BYTES);
  writeFileSync(join(manifestDir, "fonts", "display-font.woff"), FONT_BYTES);
  writeFileSync(join(manifestDir, "fonts", "display-font.ttf"), FONT_BYTES);
  writeFileSync(join(manifestDir, "fonts", "display-font.otf"), FONT_BYTES);
  // A symlink that resolves outside the store root: containment must reject it.
  const outsideSecret = join(parentDir, "outside-secret.txt");
  writeFileSync(outsideSecret, "not for public serving");
  symlinkSync(outsideSecret, join(manifestDir, "leak.svg"));

  const deps = {
    gateway: new PreparedEvidenceProjectionGateway(),
    internalAuthToken: "internal-test-token-alpha",
    now: () => 1_002,
    stageReceiptWriter: {
      async recordApplied() {
        return null;
      },
    },
    deckAssets: createDeckAssetReader(storeRoot),
  };

  handler = createProjectionGatewayHandler(
    parseProjectionGatewayConfig({ STAGE_ORIGIN: origin }),
    deps,
  );
});

afterAll(() => {
  rmSync(parentDir, { recursive: true, force: true });
});

describe("public deck artifact containment boundary", () => {
  test("serves a contained SVG immutably with Stage CORS", async () => {
    const url = `${service}/v1/deck-assets/${MANIFEST_HASH}/slides/slide-01.svg`;
    const response = await handler(new Request(url, { headers: { origin } }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(SVG_BYTES);

    const withoutOrigin = await handler(new Request(url));
    expect(withoutOrigin.status).toBe(200);
    expect(withoutOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("serves nested PNG and web font artifacts with exact MIME types", async () => {
    const assets = [
      ["slides/cover.png", "image/png", PNG_BYTES],
      ["fonts/display-font.woff2", "font/woff2", WOFF2_BYTES],
      ["fonts/display-font.woff", "font/woff", FONT_BYTES],
      ["fonts/display-font.ttf", "font/ttf", FONT_BYTES],
      ["fonts/display-font.otf", "font/otf", FONT_BYTES],
    ] as const;

    for (const [path, expectedType, expectedBytes] of assets) {
      const response = await handler(
        new Request(`${service}/v1/deck-assets/${MANIFEST_HASH}/${path}`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(expectedType);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(expectedBytes);
    }
  });

  test("rejects traversal attempts through encoded separators", async () => {
    for (const fileName of [
      "..%2Fslide-01.svg",
      "slides%2F..%2F..%2Foutside.svg",
      "slides/%2e%2e/%2e%2e/outside.svg",
      "%2e%2e%2Fslide-01.svg",
      "%2e%2e%2fslide-01.svg",
      "..%5Cslide-01.svg",
      "fonts%5C..%5Coutside.ttf",
      "%2Fetc%2Fpasswd",
    ]) {
      const response = await handler(
        new Request(`${service}/v1/deck-assets/${MANIFEST_HASH}/${fileName}`),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_asset_path" });
    }
  });

  test("rejects unknown manifest hashes and unknown artifacts", async () => {
    const unknownHash = await handler(
      new Request(`${service}/v1/deck-assets/${UNKNOWN_HASH}/slides/slide-01.svg`),
    );
    expect(unknownHash.status).toBe(404);
    expect(await unknownHash.json()).toEqual({ error: "asset_not_found" });

    const unknownFile = await handler(
      new Request(`${service}/v1/deck-assets/${MANIFEST_HASH}/slides/missing.svg`),
    );
    expect(unknownFile.status).toBe(404);
    expect(await unknownFile.json()).toEqual({ error: "asset_not_found" });
  });

  test("rejects symlink escapes from the deck store root", async () => {
    const response = await handler(
      new Request(`${service}/v1/deck-assets/${MANIFEST_HASH}/leak.svg`),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "asset_escape_forbidden" });
  });
});
