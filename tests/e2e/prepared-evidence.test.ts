import { describe, expect, test } from "bun:test";
import { runPreparedEvidenceE2E } from "./prepared-evidence.harness.ts";

function percentile95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * 0.95) - 1);
  const value = ordered[index];
  if (value === undefined) throw new Error("latency sample set is empty");
  return value;
}

describe("WP3 prepared evidence E2E", () => {
  test("runs upload through reconnect on a clean Stage profile using exact events", async () => {
    const evidence = await runPreparedEvidenceE2E();

    expect(evidence.milestones).toEqual([
      "upload",
      "deck-artifacts",
      "authenticated-controller",
      "presentation-session",
      "display-join",
      "display-bound",
      "authority-restarted",
      "slide-set-accepted",
      "stage-applied",
      "candidate-approved",
      "published-card-visible",
      "ordered-retract-tombstone",
      "ordered-expiry-tombstone",
      "reconnect-snapshot",
    ]);
    expect(evidence.appliedCommandIds).toEqual(evidence.acceptedCommandIds);
    expect(evidence.cardEvents).toEqual([
      "pcr_1:PUBLISHED",
      "pcr_2:RETRACTED",
      "pcr_3:PUBLISHED",
      "pcr_4:EXPIRED",
    ]);
    expect(evidence.reconnectActiveCardCount).toBe(0);
    expect(evidence.reconnectTombstoneStatuses).toEqual(["RETRACTED", "EXPIRED"]);
    expect(evidence.browserStorageEntries).toBe(0);
  });

  test("keeps connected tombstone delivery p95 within 500ms", async () => {
    const samples = await Promise.all(
      Array.from(
        { length: 20 },
        async () => (await runPreparedEvidenceE2E()).connectedTombstoneLatencyMs,
      ),
    );
    expect(percentile95(samples)).toBeLessThanOrEqual(500);
  });
});
