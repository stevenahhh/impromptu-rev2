import { describe, expect, test } from "bun:test";
import {
  evaluateWp8AdversarialSuite,
  evaluateWp8SafetyGate,
  type Wp8AdversarialSuite,
  type Wp8GateThresholds,
  type Wp8RepresentativeHoldout,
} from "@impromptu/test-harness";

interface GateManifest {
  readonly status: "FROZEN";
  readonly scope: string;
  readonly representativeArtifact: Readonly<{ path: string; sha256: string }>;
  readonly adversarialArtifact: Readonly<{
    path: string;
    sha256: string;
    separateFromRepresentative: boolean;
  }>;
  readonly thresholds: Wp8GateThresholds;
  readonly failureMode: Readonly<{
    livePublicEnabled: boolean;
    privateLiveVerifiedEnabled: boolean;
    curatedPublicEnabled: boolean;
  }>;
}

async function jsonFile<Value>(path: string): Promise<Value> {
  return (await Bun.file(path).json()) as Value;
}

async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

describe("WP8 frozen deterministic safety gate", () => {
  test("pins disjoint representative and adversarial artifacts by hash", async () => {
    const manifest = await jsonFile<GateManifest>("tests/corpus/wp8-gate-manifest.json");
    expect(manifest).toMatchObject({
      status: "FROZEN",
      scope: "DETERMINISTIC_GUARDED_PILOT_HARNESS",
      adversarialArtifact: { separateFromRepresentative: true },
    });
    expect(await sha256(manifest.representativeArtifact.path)).toBe(
      manifest.representativeArtifact.sha256,
    );
    expect(await sha256(manifest.adversarialArtifact.path)).toBe(
      manifest.adversarialArtifact.sha256,
    );
    expect(manifest.representativeArtifact.path).not.toBe(manifest.adversarialArtifact.path);
  });

  test("passes every preregistered representative quality, latency, and interaction threshold", async () => {
    const manifest = await jsonFile<GateManifest>("tests/corpus/wp8-gate-manifest.json");
    const holdout = await jsonFile<Wp8RepresentativeHoldout>(manifest.representativeArtifact.path);
    const evidence = evaluateWp8SafetyGate(holdout, manifest.thresholds);
    expect(evidence).toEqual({
      passed: true,
      falseSupportRate: 0,
      falseSupportUpper95: 1 - 0.05 ** (1 / 300),
      falseConflictRate: 0.05,
      wrongNumeric: 0,
      wrongDate: 0,
      wrongEntity: 0,
      authoritativeConflictAutoPublished: 0,
      eligibleYield: 0.65,
      usefulness: 0.82,
      abstention: 0.96,
      approvalMedianMs: 1_400,
      approvalP90Ms: 3_200,
      inducedSpeechPausesPerTenMinutes: 10 / 12,
      effortDelta: 90 / 700,
    });
    console.log(JSON.stringify({ suite: "wp8-holdout", ...evidence }));
  });

  test("has zero critical adversarial escapes and selects the guarded fallback on failure", async () => {
    const manifest = await jsonFile<GateManifest>("tests/corpus/wp8-gate-manifest.json");
    const adversarial = await jsonFile<Wp8AdversarialSuite>(manifest.adversarialArtifact.path);
    expect(evaluateWp8AdversarialSuite(adversarial)).toBe(true);
    expect(adversarial).toMatchObject({ criticalCases: 120, criticalEscapes: 0 });

    const failedHoldout = await jsonFile<Wp8RepresentativeHoldout>(
      manifest.representativeArtifact.path,
    );
    const failed = evaluateWp8SafetyGate(
      {
        ...failedHoldout,
        representative: { ...failedHoldout.representative, falseSupport: 1 },
      },
      manifest.thresholds,
    );
    expect(failed.passed).toBe(false);
    expect(manifest.failureMode).toEqual({
      livePublicEnabled: false,
      privateLiveVerifiedEnabled: true,
      curatedPublicEnabled: true,
    });
    console.log(
      JSON.stringify({
        suite: "wp8-adversarial",
        criticalCases: adversarial.criticalCases,
        criticalEscapes: adversarial.criticalEscapes,
      }),
    );
  });
});
