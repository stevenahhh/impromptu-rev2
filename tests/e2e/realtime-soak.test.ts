import { describe, expect, test } from "bun:test";
import { runRealtimeSoak } from "./realtime-soak.harness.ts";

describe("WP5 venue-like realtime and reconnect soak", () => {
  test("holds command, reconnect, dedupe, epoch, and lease gates", async () => {
    const evidence = await runRealtimeSoak();
    expect(evidence.profile).toBe("venue-like-real-network-exact-event");
    expect(evidence.transport).toBe("private-http+projection-wss+snapshot-http");
    expect(evidence.commandCount).toBeGreaterThanOrEqual(500);
    expect(evidence.reconnectCount).toBeGreaterThanOrEqual(50);
    expect(evidence.commandToStageAppliedP95Ms).toBeLessThanOrEqual(300);
    expect(evidence.reconnectToSnapshotP95Ms).toBeLessThanOrEqual(2_000);
    expect(evidence.observedVisibleEffects).toBe(499);
    expect(evidence.duplicateVisibleEffects).toBe(0);
    expect(evidence.staleEpochAcceptances).toBe(0);
    expect(evidence.staleCardResurrections).toBe(0);
    expect(evidence.liveLeaseMs).toBeLessThanOrEqual(3_000);
    expect(evidence.silentPartitionExposureMs).toBeLessThanOrEqual(3_000);
  }, 30_000);
});
