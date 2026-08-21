/**
 * Captures one official realtime soak evidence JSON into .omo/evidence/task-30/.
 * Usage: PRIVATE_DATABASE_URL=... PROJECTION_DATABASE_URL=... bun .omo/evidence/task-30/capture-evidence.ts <output.json>
 */
import { runRealtimeSoak } from "../../../tests/e2e/realtime-soak.harness.ts";

const outputPath = process.argv[2];
if (outputPath === undefined || outputPath.length === 0) {
  throw new Error("usage: bun capture-evidence.ts <output.json>");
}
const evidence = await runRealtimeSoak();
await Bun.write(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
