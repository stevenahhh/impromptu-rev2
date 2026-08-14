import { describe, expect, test } from "bun:test";

interface TopologyVerifierEvidence {
  readonly modes: Record<
    string,
    {
      readonly rehearsals: number;
      readonly successfulRehearsals: number;
      readonly failedRehearsals: number;
      readonly faultRecoveries: number;
      readonly realFaults: number;
      readonly simulatedFaults: number;
      readonly privatePixelCount: number;
      readonly maxRecoveryMs: number;
      readonly requestedTransitions: readonly string[];
      readonly observedTransitions: readonly string[];
      readonly privateContentVerdicts: readonly string[];
      readonly privatePixelVerdicts: readonly string[];
      readonly screenshotChecksums: readonly string[];
      readonly manualPlacementFallback: readonly string[];
      readonly targetScreenLossRecovery: readonly string[];
    }
  >;
  readonly unrecoverableFailureCount: number;
  readonly privatePixelCount: number;
  readonly audienceReadySuccessRate: number;
  readonly audienceReadyMedianMs: number;
  readonly audienceReadyP90Ms: number;
  readonly maxRecoveryMs: number;
  readonly coResidentConvenienceDisabled: boolean;
  readonly coResidentCycle: {
    readonly enabledObserved: boolean;
    readonly leakPrivatePixelCount: number;
    readonly disabledObserved: boolean;
    readonly postDisablePrivatePixelCount: number;
  };
  readonly evidenceArtifactPath: string;
  readonly evidenceArtifactChecksum: string;
}

function evidence(value: unknown): TopologyVerifierEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("WP4 verifier evidence is not an object");
  }
  return value as TopologyVerifierEvidence;
}

describe("WP4 Windows topology real-browser E2E", () => {
  test("completes three full rehearsals in every public Stage mode", async () => {
    const verifier = Bun.spawn({
      cmd: ["node", "--experimental-strip-types", "scripts/verify-wp4-topology-e2e.ts"],
      env: Bun.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      verifier.exited,
      new Response(verifier.stdout).text(),
      new Response(verifier.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = evidence(JSON.parse(stdout.trim()));
    for (const mode of ["extend", "duplicate", "single"]) {
      const modeEvidence = result.modes[mode];
      if (modeEvidence === undefined) throw new Error(`missing ${mode} evidence`);
      expect(modeEvidence.rehearsals).toBe(3);
      expect(modeEvidence.successfulRehearsals).toBe(3);
      expect(modeEvidence.failedRehearsals).toBe(0);
      expect(modeEvidence.faultRecoveries).toBe(24);
      expect(modeEvidence.realFaults).toBe(12);
      expect(modeEvidence.simulatedFaults).toBe(12);
      expect(modeEvidence.privatePixelCount).toBe(0);
      expect(modeEvidence.maxRecoveryMs).toBeLessThanOrEqual(30_000);
      expect(modeEvidence.observedTransitions).toEqual(modeEvidence.requestedTransitions);
      expect(modeEvidence.privateContentVerdicts).toEqual(["CLEAN", "CLEAN", "CLEAN"]);
      expect(modeEvidence.privatePixelVerdicts).toEqual(["CLEAN", "CLEAN", "CLEAN"]);
      expect(modeEvidence.targetScreenLossRecovery).toEqual([
        "MANUAL_FALLBACK",
        "MANUAL_FALLBACK",
        "MANUAL_FALLBACK",
      ]);
      expect(modeEvidence.manualPlacementFallback).toEqual(
        mode === "extend"
          ? ["NOT_REQUIRED", "NOT_REQUIRED", "NOT_REQUIRED"]
          : ["VERIFIED", "VERIFIED", "VERIFIED"],
      );
      expect(modeEvidence.screenshotChecksums.every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(
        true,
      );
    }
    expect(result.unrecoverableFailureCount).toBe(0);
    expect(result.privatePixelCount).toBe(0);
    expect(result.audienceReadySuccessRate).toBeGreaterThanOrEqual(0.85);
    expect(result.audienceReadyMedianMs).toBeLessThanOrEqual(180_000);
    expect(result.audienceReadyP90Ms).toBeLessThanOrEqual(300_000);
    expect(result.maxRecoveryMs).toBeLessThanOrEqual(30_000);
    expect(result.coResidentCycle.enabledObserved).toBe(true);
    expect(result.coResidentCycle.leakPrivatePixelCount).toBeGreaterThan(0);
    expect(result.coResidentCycle.disabledObserved).toBe(true);
    expect(result.coResidentCycle.postDisablePrivatePixelCount).toBe(0);
    expect(result.coResidentConvenienceDisabled).toBe(true);
    expect(result.evidenceArtifactPath).toBe("artifacts/wp4-topology/manifest.json");
    expect(result.evidenceArtifactChecksum).toMatch(/^[a-f0-9]{64}$/);
  }, 180_000);
});
