import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  COACHING_ROLLING_WINDOW_MS,
  CoachingEventSchema,
  CoachingMeasurementSchema,
} from "@impromptu/contracts/private";

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("private coaching contract", () => {
  test("fixes the rolling window at 30 seconds and keeps boundary objects closed", () => {
    expect(COACHING_ROLLING_WINDOW_MS).toBe(30_000);
    expect(
      CoachingMeasurementSchema.parse({
        outcome: "AVAILABLE",
        currentWordsPerMinute: 8,
        previousWordsPerMinute: 4,
        deltaWordsPerMinute: 4,
      }),
    ).toEqual({
      outcome: "AVAILABLE",
      currentWordsPerMinute: 8,
      previousWordsPerMinute: 4,
      deltaWordsPerMinute: 4,
    });
    expect(
      CoachingMeasurementSchema.safeParse({
        outcome: "MEASUREMENT_UNAVAILABLE",
        severity: "forbidden",
      }).success,
    ).toBe(false);
    expect(
      CoachingEventSchema.safeParse({
        kind: "FINAL",
        sessionGeneration: 1,
        sequence: 1,
        segmentId: "segment_one",
        finalSegmentId: "final_one",
        finalizedAtSessionMs: 1_000,
        words: [],
        toast: true,
      }).success,
    ).toBe(false);
  });

  test("exports coaching from the private surface only", async () => {
    const privateContracts: Record<string, unknown> = await import("@impromptu/contracts/private");
    const publicContracts: Record<string, unknown> = await import("@impromptu/contracts/public");
    const rootContracts: Record<string, unknown> = await import("@impromptu/contracts");

    expect("CoachingEventSchema" in privateContracts).toBe(true);
    expect("CoachingEventSchema" in publicContracts).toBe(false);
    expect("CoachingEventSchema" in rootContracts).toBe(false);
  });

  test("keeps coaching out of the Stage source import graph", () => {
    const stageSource = sourceFiles("apps/stage/src")
      .filter((path) => /\.(?:ts|tsx)$/.test(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(stageSource.match(/coaching/gi) ?? []).toHaveLength(0);
  });

  test("omits judgment and presentation-policy fields from coaching schema and state", () => {
    const implementation = [
      "packages/contracts/src/coaching.ts",
      "packages/state/src/coaching.ts",
      "packages/state/src/audio-fusion.ts",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const forbiddenNames = ["SILENCE", "threshold", "severity", "color", "toast"];
    for (const name of forbiddenNames) {
      expect(new RegExp(`\\b${name}\\b`, "i").test(implementation)).toBe(false);
    }
  });
});
