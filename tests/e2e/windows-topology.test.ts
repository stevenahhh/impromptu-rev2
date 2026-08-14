import { describe, expect, test } from "bun:test";

interface TopologyVerifierEvidence {
  readonly modes: Record<
    string,
    {
      readonly rehearsals: number;
      readonly faultRecoveries: number;
      readonly realFaults: number;
      readonly simulatedFaults: number;
      readonly privatePixelCount: number;
      readonly maxRecoveryMs: number;
      readonly requestedTransitions: readonly string[];
      readonly observedTransitions: readonly string[];
    }
  >;
  readonly unrecoverableFailureCount: number;
  readonly privatePixelCount: number;
  readonly audienceReadySuccessRate: number;
  readonly audienceReadyMedianMs: number;
  readonly audienceReadyP90Ms: number;
  readonly maxRecoveryMs: number;
  readonly coResidentConvenienceDisabled: boolean;
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
      expect(modeEvidence.faultRecoveries).toBe(21);
      expect(modeEvidence.realFaults).toBe(12);
      expect(modeEvidence.simulatedFaults).toBe(9);
      expect(modeEvidence.privatePixelCount).toBe(0);
      expect(modeEvidence.maxRecoveryMs).toBeLessThanOrEqual(30_000);
      expect(modeEvidence.observedTransitions).toEqual(modeEvidence.requestedTransitions);
    }
    expect(result.unrecoverableFailureCount).toBe(0);
    expect(result.privatePixelCount).toBe(0);
    expect(result.audienceReadySuccessRate).toBeGreaterThanOrEqual(0.85);
    expect(result.audienceReadyMedianMs).toBeLessThanOrEqual(180_000);
    expect(result.audienceReadyP90Ms).toBeLessThanOrEqual(300_000);
    expect(result.maxRecoveryMs).toBeLessThanOrEqual(30_000);
    expect(result.coResidentConvenienceDisabled).toBe(true);
  }, 180_000);
});
