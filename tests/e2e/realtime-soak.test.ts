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
    // Stage is slide-only: card publication is refused fail-closed, no card frame reaches a
    // display socket, and a partition/reconnect cycle recovers slides with zero cards.
    expect(evidence.staleCardResurrections).toBe(0);
    expect(evidence.cardPublishStatus).toBe(410);
    expect(evidence.cardPublishRejection).toBe("stage_cards_disabled");
    expect(evidence.stageCardFrames).toBe(0);
    expect(evidence.stageCardsAfterPartition).toBe(0);
    expect(evidence.partitionRecoveryMs).toBeLessThanOrEqual(2_000);
    // The latency gates above are the SLA. This argument is only the runner budget for a
    // 500-command, 50-reconnect soak against real services, so it must stay well clear of
    // the measured runtime instead of tracking it.
  }, 180_000);
});
