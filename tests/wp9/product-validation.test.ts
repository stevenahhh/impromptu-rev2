import { describe, expect, test } from "bun:test";
import {
  evaluateWp9ApprovalLoad,
  evaluateWp9AudienceExperiment,
  type Wp9ApprovalEvent,
  type Wp9ApprovalLoadFixture,
  type Wp9ApprovalLoadThresholds,
  type Wp9AudienceFixture,
  type Wp9AudienceThresholds,
  type Wp9PublicationArm,
} from "@impromptu/test-harness";

interface Registration {
  readonly registeredBeforeExecution: true;
  readonly claimBoundary: {
    readonly wp0CollectionStatus: "NOT_COLLECTED";
    readonly wp0GateStatus: "BLOCKED";
    readonly productAcceptanceEligible: false;
    readonly superiorityClaimPermitted: false;
    readonly livePublicationRuntimeDefault: string;
  };
  readonly audienceValue: {
    readonly fixture: Artifact;
    readonly wp8GateManifest: Artifact;
    readonly thresholds: Readonly<Record<Wp9PublicationArm, Wp9AudienceThresholds>>;
  };
  readonly presenterApprovalLoad: {
    readonly fixture: Artifact;
    readonly sessionDurationMs: number;
    readonly exactEvents: readonly Wp9ApprovalEvent["type"][];
    readonly thresholds: Wp9ApprovalLoadThresholds;
  };
}
interface Artifact {
  readonly path: string;
  readonly sha256: string;
}
interface Wp8Manifest {
  readonly wp0KoreanAcceptance: {
    readonly collectionStatus: "NOT_COLLECTED";
    readonly gateStatus: "BLOCKED";
    readonly eligibleToEnableLivePublication: false;
  };
  readonly failureMode: { readonly livePublicEnabled: false };
}

const registrationPath = "tests/corpus/wp9-product-validation-registration.json";
const json = async <Value>(path: string) => (await Bun.file(path).json()) as Value;
const checksum = async (path: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");

describe("WP9 preregistered product validation", () => {
  test("pins fixed offline fixtures while retaining the blocked WP0 and live-public gates", async () => {
    const registration = await json<Registration>(registrationPath);
    const wp8 = await json<Wp8Manifest>(registration.audienceValue.wp8GateManifest.path);
    expect(registration).toMatchObject({
      registeredBeforeExecution: true,
      claimBoundary: {
        wp0CollectionStatus: "NOT_COLLECTED",
        wp0GateStatus: "BLOCKED",
        productAcceptanceEligible: false,
        superiorityClaimPermitted: false,
        livePublicationRuntimeDefault: "OFF_UNLESS_LIVE_PUBLICATION_GATE_STATE_PASSED",
      },
    });
    expect(await checksum(registration.audienceValue.fixture.path)).toBe(
      registration.audienceValue.fixture.sha256,
    );
    expect(await checksum(registration.presenterApprovalLoad.fixture.path)).toBe(
      registration.presenterApprovalLoad.fixture.sha256,
    );
    expect(await checksum(registration.audienceValue.wp8GateManifest.path)).toBe(
      registration.audienceValue.wp8GateManifest.sha256,
    );
    expect(wp8.wp0KoreanAcceptance).toEqual({
      collectionStatus: "NOT_COLLECTED",
      gateStatus: "BLOCKED",
      eligibleToEnableLivePublication: false,
    });
    expect(wp8.failureMode.livePublicEnabled).toBe(false);
  });

  test("records case-level yield, usefulness, abstention, and gate states without claiming collection", async () => {
    const registration = await json<Registration>(registrationPath);
    const fixture = await json<Wp9AudienceFixture>(registration.audienceValue.fixture.path);
    const evidence = evaluateWp9AudienceExperiment(fixture, registration.audienceValue.thresholds);
    expect(evidence).toMatchObject({
      machineThresholdsPassed: true,
      productAcceptanceEligible: false,
      collectionStatus: "NOT_COLLECTED",
      gateStatus: "BLOCKED",
      arms: {
        CURATED: { caseCount: 25, eligibleYield: 0.6, usefulness: 10 / 12, abstention: 1 },
        SUPERVISED_LIVE: {
          caseCount: 25,
          eligibleYield: 0.7,
          usefulness: 12 / 14,
          abstention: 1,
        },
      },
    });
    expect(new Set(evidence.cases.map(({ caseId }) => caseId)).size).toBe(50);
    expect(
      evidence.cases
        .filter(({ arm }) => arm === "SUPERVISED_LIVE")
        .every(
          ({ gateManifestState, observedPublication }) =>
            gateManifestState === "WP0_BLOCKED_LIVE_DEFAULT_OFF" &&
            observedPublication !== "CURATED_PUBLISHED",
        ),
    ).toBe(true);
  });

  test("measures the exact-event venue session with bounded approvals and no clock waits", async () => {
    const registration = await json<Registration>(registrationPath);
    const fixture = await json<Wp9ApprovalLoadFixture>(
      registration.presenterApprovalLoad.fixture.path,
    );
    expect(fixture.sessionDurationMs).toBe(registration.presenterApprovalLoad.sessionDurationMs);
    expect([...new Set(fixture.events.map(({ type }) => type))].sort()).toEqual(
      [...registration.presenterApprovalLoad.exactEvents].sort(),
    );
    expect(evaluateWp9ApprovalLoad(fixture, registration.presenterApprovalLoad.thresholds)).toEqual(
      {
        passed: true,
        sessionDurationMs: 3_600_000,
        approvalCount: 12,
        latenciesMs: [900, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1900, 2200, 2800, 3600],
        approvalP50Ms: 1500,
        approvalP90Ms: 2800,
        effortProxy: 12 / 70,
        inducedPauseCount: 3,
        inducedPauseRatePerTenMinutes: 0.5,
        timedOutApprovalIds: [],
      },
    );
  });

  test("rejects an approval that exceeds the preregistered bounded timeout", () => {
    const fixture: Wp9ApprovalLoadFixture = {
      schemaVersion: 1,
      evidenceKind: "DETERMINISTIC_VENUE_LENGTH_APPROVAL_SIMULATION",
      sessionDurationMs: 10_000,
      baselineControlActions: 10,
      events: [
        { type: "SNAPSHOT_LOADED", atMs: 0 },
        { type: "APPROVAL_REQUESTED", approvalId: "approval-timeout", atMs: 1_000 },
        { type: "APPROVAL_SETTLED", approvalId: "approval-timeout", atMs: 7_000 },
      ],
    };
    const evidence = evaluateWp9ApprovalLoad(fixture, {
      approvalCountMaximum: 2,
      approvalP50MaximumMs: 10_000,
      approvalP90MaximumMs: 10_000,
      effortProxyMaximum: 1,
      inducedPauseRateMaximumPerTenMinutes: 1,
      approvalTimeoutMs: 5_000,
    });
    expect(evidence.passed).toBe(false);
    expect(evidence.timedOutApprovalIds).toEqual(["approval-timeout"]);
  });
});
