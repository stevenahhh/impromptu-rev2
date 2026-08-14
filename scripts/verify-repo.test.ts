import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("repository policy", () => {
  test("uses the impromptu-r2 private workspace identity", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      name?: unknown;
      private?: unknown;
    };

    expect(manifest).toMatchObject({
      name: "impromptu-r2",
      private: true,
    });
  });

  test("ships the application, approved plan, research, and server-only AI boundary", () => {
    expect(existsSync("docs/신청서.pdf")).toBe(true);
    expect(existsSync("docs/PWA-구현-최적화-연구보고서.md")).toBe(true);
    expect(existsSync("docs/PWA-구현-최적화-연구보고서.html")).toBe(true);
    expect(existsSync(".omo/plans/impromptu-r2-hyperplan.md")).toBe(true);
    expect(existsSync(".omo/ulw-research/20260814-040838/sources-ledger.md")).toBe(true);

    const boundary = readFileSync("docs/AI-BOUNDARY.md", "utf8");
    expect(boundary).toContain("All model execution");
    expect(boundary).toContain("Browser bundles may not contain or invoke");
  });

  test("ignores secrets, runtime state, uploads, and model artifacts", () => {
    const gitignore = readFileSync(".gitignore", "utf8");

    for (const entry of [".env", ".senpi/", ".omo/senpi-task/", "uploads/", "models/"]) {
      expect(gitignore).toContain(entry);
    }
  });
});
