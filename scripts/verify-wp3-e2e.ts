import { runPreparedEvidenceE2E } from "../tests/e2e/prepared-evidence.harness.ts";

const samples = await Promise.all(Array.from({ length: 20 }, () => runPreparedEvidenceE2E()));
const latencies = samples
  .map((sample) => sample.connectedTombstoneLatencyMs)
  .sort((left, right) => left - right);
const p95 = latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)];
const representative = samples[0];
if (representative === undefined || p95 === undefined)
  throw new Error("WP3 E2E produced no evidence");
if (p95 > 500) throw new Error(`connected tombstone p95 ${p95.toFixed(3)}ms exceeds 500ms`);
if (
  representative.reconnectActiveCardCount !== 0 ||
  representative.browserStorageEntries !== 0 ||
  JSON.stringify(representative.acceptedCommandIds) !==
    JSON.stringify(representative.appliedCommandIds)
) {
  throw new Error("WP3 E2E terminal invariants failed");
}

console.log(
  JSON.stringify({
    flow: representative.milestones,
    acceptedCommandPrefix: representative.acceptedCommandIds,
    appliedCommandPrefix: representative.appliedCommandIds,
    cardEvents: representative.cardEvents,
    connectedTombstoneP95Ms: Number(p95.toFixed(3)),
    reconnectActiveCardCount: representative.reconnectActiveCardCount,
    reconnectTombstoneStatuses: representative.reconnectTombstoneStatuses,
    browserStorageEntries: representative.browserStorageEntries,
    samples: samples.length,
  }),
);
