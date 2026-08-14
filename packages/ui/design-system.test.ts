import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const tokenPath = "packages/ui/src/tokens.css";

const tokenGroups = {
  color: [
    "--color-ink",
    "--color-paper",
    "--color-accent",
    "--color-success",
    "--color-warning",
    "--color-danger",
    "--color-info",
  ],
  space: ["--space-1", "--space-2", "--space-3", "--space-4", "--space-6", "--space-8"],
  type: ["--text-caption", "--text-body", "--text-title", "--text-display"],
  shape: ["--radius-sm", "--radius-md", "--radius-lg", "--shadow-panel"],
  motion: ["--duration-fast", "--duration-reveal", "--ease-out"],
} as const;

const primitiveFiles = [
  "Badge.tsx",
  "Brand.tsx",
  "Button.tsx",
  "Panel.tsx",
  "Shell.tsx",
  "SkipLink.tsx",
  "StatusDot.tsx",
] as const;

describe("shared visual system", () => {
  test("defines every semantic token group centrally", () => {
    expect(existsSync(tokenPath)).toBe(true);
    const tokens = readFileSync(tokenPath, "utf8");

    for (const [group, names] of Object.entries(tokenGroups)) {
      for (const name of names) {
        expect(tokens, `${group} token ${name}`).toContain(`${name}:`);
      }
    }
  });

  test("provides the agreed composition primitives", () => {
    for (const file of primitiveFiles) {
      expect(existsSync(`packages/ui/src/${file}`), file).toBe(true);
    }
  });
});
