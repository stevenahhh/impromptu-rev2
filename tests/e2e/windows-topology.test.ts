import { describe, expect, test } from "bun:test";

interface TopologyVerifierEvidence {
  readonly modes: Record<
    string,
    {
      readonly rehearsals: number;
      readonly faultRecoveries: number;
      readonly privatePixelCount: number;
      readonly maxRecoveryMs: number;
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
      expect(result.modes[mode]?.rehearsals).toBe(3);
      expect(result.modes[mode]?.faultRecoveries).toBe(21);
      expect(result.modes[mode]?.privatePixelCount).toBe(0);
      expect(result.modes[mode]?.maxRecoveryMs).toBeLessThanOrEqual(30_000);
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
