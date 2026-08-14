import { describe, expect, test } from "bun:test";
import {
  createOfflineKoreanSttProviders,
  KOREAN_STT_BAKEOFF_CASES,
  OfflineBakeoffNetworkError,
  type OfflineKoreanSttProvider,
  runKoreanSttBakeoff,
} from "../src/bakeoff.ts";

describe("offline Korean STT provider bakeoff", () => {
  test("compares fixed provider transcripts, accuracy, latency, and cost without network", async () => {
    const providers = createOfflineKoreanSttProviders();
    const matrix = await runKoreanSttBakeoff(KOREAN_STT_BAKEOFF_CASES, providers);

    expect(matrix).toEqual([
      {
        provider: "azure",
        accuracyPercent: 100,
        latencyP95Ms: 760,
        costPerMinuteUsd: 0.017,
        interceptedNetworkRequests: 0,
      },
      {
        provider: "deepgram",
        accuracyPercent: 75,
        latencyP95Ms: 480,
        costPerMinuteUsd: 0.0043,
        interceptedNetworkRequests: 0,
      },
      {
        provider: "google",
        accuracyPercent: 75,
        latencyP95Ms: 620,
        costPerMinuteUsd: 0.024,
        interceptedNetworkRequests: 0,
      },
      {
        provider: "aws",
        accuracyPercent: 50,
        latencyP95Ms: 690,
        costPerMinuteUsd: 0.024,
        interceptedNetworkRequests: 0,
      },
    ]);
    expect(Object.isFrozen(matrix)).toBe(true);
    expect(Object.isFrozen(providers[0]?.outputs)).toBe(true);
    expect(matrix.every((row) => row.interceptedNetworkRequests === 0)).toBe(true);
  });

  test("fails when a provider invokes the intercepted network primitive despite claiming offline", async () => {
    const provider: OfflineKoreanSttProvider = {
      name: "aws",
      costPerMinuteUsd: 0,
      outputs: Object.freeze({}),
      async transcribe() {
        try {
          await fetch("https://network-must-not-run.invalid");
        } catch {
          // A provider cannot hide a network attempt by swallowing its transport failure.
        }
        return Object.freeze({ transcript: "고정", latencyMs: 1 });
      },
    };

    await expect(
      runKoreanSttBakeoff([{ id: "network-probe", expectedTranscript: "고정" }], [provider]),
    ).rejects.toBeInstanceOf(OfflineBakeoffNetworkError);
  });

  test("returns immutable copies rather than exposing fake output fixtures", async () => {
    const provider = createOfflineKoreanSttProviders()[0];
    if (provider === undefined) throw new Error("provider fixture is required");
    const first = await provider.transcribe("ko-case-1");
    const second = await provider.transcribe("ko-case-1");

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
