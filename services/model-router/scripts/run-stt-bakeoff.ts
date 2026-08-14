import {
  createOfflineKoreanSttProviders,
  KOREAN_STT_BAKEOFF_CASES,
  runKoreanSttBakeoff,
} from "../src/bakeoff.ts";

const matrix = await runKoreanSttBakeoff(
  KOREAN_STT_BAKEOFF_CASES,
  createOfflineKoreanSttProviders(),
);

console.log("provider\taccuracy\tp95_ms\tusd_per_minute");
for (const row of matrix) {
  console.log(
    `${row.provider}\t${row.accuracyPercent.toFixed(0)}%\t${row.latencyP95Ms}\t${row.costPerMinuteUsd}`,
  );
}
