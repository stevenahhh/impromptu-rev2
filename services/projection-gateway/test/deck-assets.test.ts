import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { parseProjectionGatewayConfig } from "../src/config.ts";
import {
  createProjectionGatewayHandler,
  type ProjectionGatewayHandler,
  type ProjectionGatewayHttpDependencies,
} from "../src/http.ts";
import { PreparedEvidenceProjectionGateway } from "../src/prepared-evidence.ts";

// Public deck artifact containment contract.
//
// GET /v1/deck-assets/:manifestHash/:fileName must:
//   - serve only assets contained inside the deck store root as immutable bytes
//     with the exact MIME type for the extension and Stage CORS headers;
//   - reject encoded path traversal and non-basename file names with 400
//     invalid_asset_path;
//   - reject unknown manifest hashes and unknown artifacts with 404
//     asset_not_found;
//   - reject artifacts whose resolved path escapes the deck store root
//     (symlink escape) with 403 asset_escape_forbidden.
//
// The handler is expected to accept an injected asset reader on its
// dependencies; the reader below is the reference containment implementation
// the gateway route must delegate to.

interface DeckAsset {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

type DeckAssetReadResult =
  | { readonly outcome: "FOUND"; readonly asset: DeckAsset }
  | { readonly outcome: "UNKNOWN" }
  | { readonly outcome: "ESCAPE" };

interface DeckAssetReader {
  readonly read: (manifestHash: string, fileName: string) => Promise<DeckAssetReadResult>;
}

// The gateway handler is expected to accept the injected asset reader through
// its HTTP dependencies once the deck-assets route lands.
interface DeckAssetGatewayDependencies extends ProjectionGatewayHttpDependencies {
  readonly deckAssets: DeckAssetReader;
}

function contentTypeFor(fileName: string): string | null {
  if (fileName.endsWith(".svg")) return "image/svg+xml";
  if (fileName.endsWith(".png")) return "image/png";
  if (fileName.endsWith(".woff2")) return "font/woff2";
  return null;
}

function createDeckAssetReader(root: string): DeckAssetReader {
  return {
    async read(manifestHash, fileName) {
      if (
        manifestHash === "" ||
        manifestHash === "." ||
        manifestHash === ".." ||
        manifestHash.includes("/") ||
        manifestHash.includes("\\") ||
        fileName === "" ||
        fileName === "." ||
        fileName === ".." ||
        fileName.includes("/") ||
        fileName.includes("\\")
      ) {
        return { outcome: "UNKNOWN" };
      }
      const manifestDir = join(root, manifestHash);
      if (!existsSync(manifestDir)) return { outcome: "UNKNOWN" };
      const candidate = join(manifestDir, fileName);
      if (!existsSync(candidate)) return { outcome: "UNKNOWN" };
      let resolved: string;
      try {
        resolved = realpathSync(candidate);
      } catch {
        return { outcome: "UNKNOWN" };
      }
      const rootReal = realpathSync(root);
      if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${sep}`)) {
        return { outcome: "ESCAPE" };
      }
      const contentType = contentTypeFor(fileName);
      if (contentType === null) return { outcome: "UNKNOWN" };
      return { outcome: "FOUND", asset: { bytes: readFileSync(candidate), contentType } };
    },
  };
}

const origin = "https://stage.example.test";
const service = "https://projection.example.test";
const MANIFEST_HASH = "a".repeat(64);
const UNKNOWN_HASH = "f".repeat(64);

const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WOFF2_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]);

let parentDir!: string;
let handler!: ProjectionGatewayHandler;

beforeAll(() => {
  parentDir = mkdtempSync(join(tmpdir(), "deck-assets-"));
  const storeRoot = join(parentDir, "store");
  const manifestDir = join(storeRoot, MANIFEST_HASH);
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "slide-01.svg"), SVG_BYTES);
  writeFileSync(join(manifestDir, "cover.png"), PNG_BYTES);
  writeFileSync(join(manifestDir, "display-font.woff2"), WOFF2_BYTES);
  // A symlink that resolves outside the store root: containment must reject it.
  const outsideSecret = join(parentDir, "outside-secret.txt");
  writeFileSync(outsideSecret, "not for public serving");
  symlinkSync(outsideSecret, join(manifestDir, "leak.svg"));

  const deps: DeckAssetGatewayDependencies = {
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
    const url = `${service}/v1/deck-assets/${MANIFEST_HASH}/slide-01.svg`;
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

  test("serves PNG and WOFF2 artifacts with exact MIME types", async () => {
    const png = await handler(new Request(`${service}/v1/deck-assets/${MANIFEST_HASH}/cover.png`));
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG_BYTES);

    const font = await handler(
      new Request(`${service}/v1/deck-assets/${MANIFEST_HASH}/display-font.woff2`),
    );
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(new Uint8Array(await font.arrayBuffer())).toEqual(WOFF2_BYTES);
  });

  test("rejects traversal attempts through encoded separators", async () => {
    for (const fileName of [
      "..%2Fslide-01.svg",
      "%2e%2e%2Fslide-01.svg",
      "%2e%2e%2fslide-01.svg",
      "..%5Cslide-01.svg",
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
      new Request(`${service}/v1/deck-assets/${UNKNOWN_HASH}/slide-01.svg`),
    );
    expect(unknownHash.status).toBe(404);
    expect(await unknownHash.json()).toEqual({ error: "asset_not_found" });

    const unknownFile = await handler(
      new Request(`${service}/v1/deck-assets/${MANIFEST_HASH}/missing.svg`),
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
