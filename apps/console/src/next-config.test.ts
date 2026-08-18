import { describe, expect, test } from "bun:test";

import { consolePrivateApiOrigin } from "./next-runtime-config";

describe("Console Next.js private API boundary", () => {
  test("uses the local private backend when no origin is configured", () => {
    expect(consolePrivateApiOrigin({})).toBe("http://127.0.0.1:3001");
    expect(consolePrivateApiOrigin({ CONSOLE_PRIVATE_API_ORIGIN: " " })).toBe(
      "http://127.0.0.1:3001",
    );
  });
});
