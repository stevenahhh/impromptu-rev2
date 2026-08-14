import { runPreparedEvidenceE2E } from "../tests/e2e/prepared-evidence.harness.ts";

const evidence = await runPreparedEvidenceE2E();
if (evidence.tombstoneP95Ms > 500) {
  throw new Error(`connected tombstone p95 ${evidence.tombstoneP95Ms.toFixed(3)}ms exceeds 500ms`);
}
if (
  evidence.reconnectActiveCardCount !== 0 ||
  evidence.browserStorageEntries !== 0 ||
  evidence.publicCorrelationMatches !== 0 ||
  JSON.stringify(evidence.acceptedCommandIds) !== JSON.stringify(evidence.appliedCommandIds)
) {
  throw new Error("WP3 real-browser E2E terminal invariants failed");
}

console.log(
  JSON.stringify({
    flow: evidence.milestones,
    acceptedCommandPrefix: evidence.acceptedCommandIds,
    appliedCommandPrefix: evidence.appliedCommandIds,
    cardEventCount: evidence.cardEvents.length,
    connectedTombstoneP95Ms: Number(evidence.tombstoneP95Ms.toFixed(3)),
    reconnectActiveCardCount: evidence.reconnectActiveCardCount,
    reconnectTombstoneStatuses: evidence.reconnectTombstoneStatuses,
    browserStorageEntries: evidence.browserStorageEntries,
    samples: evidence.latencySamples,
    livePublicationRetractP95Ms: Number(evidence.livePublicationRetractP95Ms.toFixed(3)),
    livePublicationRetractSamples: evidence.livePublicationRetractSamples,
    publicCorrelationMatches: evidence.publicCorrelationMatches,
    surface: "real-service-mains+clean-chrome-stage",
  }),
);
