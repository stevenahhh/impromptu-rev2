import { describe, expect, test } from "bun:test";

import { developmentServices } from "./dev-services";

describe("local development topology", () => {
  test("starts every service required by the upload-first flow", () => {
    expect(developmentServices.map((service) => service.name)).toEqual([
      "private-backend",
      "projection-gateway",
      "console",
      "stage",
    ]);
    expect(developmentServices.map((service) => service.port)).toEqual([3001, 3002, 4173, 4174]);
  });

  test("provides the Console with usable local credentials", () => {
    const backend = developmentServices[0];
    expect(backend?.env.CONTROLLER_USERNAME).toBe("localdemo");
    expect(backend?.env.CONTROLLER_PASSWORD).toBe("demo-2026-password");
    expect(backend?.env.CONSOLE_ORIGIN).toBe("http://localhost:4173");
    expect(backend?.env.CHAT_MODEL_BASE_URL).toBe("https://opencode.ai/zen/go/v1");
    expect(backend?.env.EMBEDDING_MODEL_BASE_URL).toBe("https://127.0.0.1:8443/v1");
    expect(backend?.env.EMBEDDING_MODEL).toBe("embeddinggemma");
    expect(backend?.env.EMBEDDING_MODEL_API_KEY).toBe("local-embedding-token");
    expect(backend?.env.NODE_EXTRA_CA_CERTS).toBe(
      "/Users/gahn/Library/Application Support/mkcert/rootCA.pem",
    );
  });
});
