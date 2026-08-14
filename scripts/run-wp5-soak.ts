import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { runRealtimeSoak } from "../tests/e2e/realtime-soak.harness.ts";

const outputPath = "tests/evidence/wp5-realtime-soak.json";
const checksumPath = `${outputPath}.sha256`;
const evidence = await runRealtimeSoak();
if (
  evidence.commandCount < 500 ||
  evidence.reconnectCount < 50 ||
  evidence.commandToStageAppliedP95Ms > 300 ||
  evidence.reconnectToSnapshotP95Ms > 2_000 ||
  evidence.duplicateVisibleEffects !== 0 ||
  evidence.staleEpochAcceptances !== 0 ||
  evidence.staleCardResurrections !== 0 ||
  evidence.liveLeaseMs > 3_000 ||
  evidence.silentPartitionExposureMs > 3_000
) {
  throw new Error(`WP5 soak gate failed: ${JSON.stringify(evidence)}`);
}
const payload = `${JSON.stringify(evidence, null, 2)}\n`;
const checksum = createHash("sha256").update(payload).digest("hex");
await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, payload);
await Bun.write(checksumPath, `${checksum}  wp5-realtime-soak.json\n`);
console.log(JSON.stringify({ ...evidence, sha256: checksum }));
