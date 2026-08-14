import { describe, expect, test } from "bun:test";
import {
  KOREAN_STT_BAKEOFF_CASES,
  createOfflineKoreanSttProviders,
  runKoreanSttBakeoff,
} from "../src/bakeoff.ts";

describe("offline Korean STT provider bakeoff", () => {
  test("compares fixed provider transcripts, accuracy, latency, and cost without network", async () => {
    const providers = createOfflineKoreanSttProviders();
    const matrix = await runKoreanSttBakeoff(KOREAN_STT_BAKEOFF_CASES, providers);

    expect(matrix).toEqual([
      { provider: "azure", accuracyPercent: 100, latencyP95Ms: 760, costPerMinuteUsd: 0.017 },
      { provider: "deepgram", accuracyPercent: 75, latencyP95Ms: 480, costPerMinuteUsd: 0.0043 },
      { provider: "google", accuracyPercent: 75, latencyP95Ms: 620, costPerMinuteUsd: 0.024 },
      { provider: "aws", accuracyPercent: 50, latencyP95Ms: 690, costPerMinuteUsd: 0.024 },
    ]);
    expect(Object.isFrozen(matrix)).toBe(true);
    expect(Object.isFrozen(providers[0]?.outputs)).toBe(true);
    expect(providers.every((provider) => provider.networkRequests === 0)).toBe(true);
  });

  test("returns immutable copies rather than exposing fake output fixtures", async () => {
    const provider = createOfflineKoreanSttProviders()[0]!;
    const first = await provider.transcribe("ko-case-1");
    const second = await provider.transcribe("ko-case-1");

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
