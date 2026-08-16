import { readFile, writeFile } from "node:fs/promises";

import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { z } from "zod";

import { parsePrivateBackendConfig } from "../../services/private-backend/src/config.ts";
import { createPrivateBackendHandler } from "../../services/private-backend/src/http.ts";
import { PreparedEvidenceCoordinator } from "../../services/private-backend/src/prepared-evidence.ts";

const origin = "https://console.example.test";
const manifestPath =
  "C:/Users/steve/AppData/Local/Temp/impromptu-render-qa/final-render/render.json";
const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
const handler = createPrivateBackendHandler(parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin }), {
  coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
  identityVerifier: {
    async exchangeAuthorizationCode() {
      return { accountId: "account_render_qa", actorId: "actor_render_qa" };
    },
  },
  internalAuthToken: "render-qa-internal-token",
  now: () => 1_000,
});

function request(path: string, init: RequestInit): Request {
  return new Request(`https://private.example.test${path}`, {
    ...init,
    headers: {
      Origin: origin,
      Referer: `${origin}/render-qa`,
      ...init.headers,
    },
  });
}

const signedIn = await handler(
  request("/v1/account-sessions", {
    method: "POST",
    body: JSON.stringify({ authorizationCode: "render-qa-code" }),
  }),
);
const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const session = z.object({ csrfToken: z.string() }).parse(await signedIn.json());
const response = await handler(
  request("/v1/deck-artifacts", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": session.csrfToken },
    body: JSON.stringify({
      title: "Korean adversarial renderer QA",
      publicBaseUrl: "http://localhost:4188/final-render",
      renderManifest: manifest,
    }),
  }),
);
const payload = z
  .object({
    publicDeck: PublishedDeckArtifactSchema,
    sourceHash: z.string(),
  })
  .parse(await response.json());
const evidence = {
  httpStatus: response.status,
  manifestPath,
  deckVersion: payload.publicDeck.deckVersion,
  slideCount: payload.publicDeck.slides.length,
  slides: payload.publicDeck.slides.map((slide) => ({
    ordinal: slide.ordinal,
    publicSlideKey: slide.publicSlideKey,
    imageUrl: slide.image.url,
    contentHash: slide.image.contentHash,
  })),
};
await writeFile(".omo/scratch/render-seam-http-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
