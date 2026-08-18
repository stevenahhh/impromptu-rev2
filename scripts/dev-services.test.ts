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

  test("provides the Console with a usable local sign-in code", () => {
    const backend = developmentServices[0];
    expect(backend?.env.CONTROLLER_AUTHORIZATION_CODE).toBe("demo-2026");
    expect(backend?.env.CONSOLE_ORIGIN).toBe("http://localhost:4173");
  });
});
