export type Wp9PublicationArm = "CURATED" | "SUPERVISED_LIVE";

export interface Wp9AudienceCase {
  readonly caseId: string;
  readonly arm: Wp9PublicationArm;
  readonly answerable: boolean;
  readonly eligible: boolean;
  readonly useful: boolean | null;
  readonly abstained: boolean;
  readonly observedPublication: "CURATED_PUBLISHED" | "BLOCKED_BY_DEFAULT_OFF" | "ABSTAINED";
  readonly gateManifestState: "CURATED_AVAILABLE" | "WP0_BLOCKED_LIVE_DEFAULT_OFF";
}

export interface Wp9AudienceFixture {
  readonly schemaVersion: 1;
  readonly evidenceKind: "DETERMINISTIC_SIMULATION_NOT_AUDIENCE_COLLECTION";
  readonly collectionStatus: "NOT_COLLECTED";
  readonly gateStatus: "BLOCKED";
  readonly cases: readonly Wp9AudienceCase[];
}

export interface Wp9AudienceThresholds {
  readonly eligibleYieldMinimum: number;
  readonly usefulnessMinimum: number;
  readonly abstentionMinimum: number;
}

export interface Wp9AudienceArmEvidence {
  readonly caseCount: number;
  readonly eligibleYield: number;
  readonly usefulness: number;
  readonly abstention: number;
}

export interface Wp9AudienceEvidence {
  readonly machineThresholdsPassed: boolean;
  readonly productAcceptanceEligible: false;
  readonly collectionStatus: "NOT_COLLECTED";
  readonly gateStatus: "BLOCKED";
  readonly arms: Readonly<Record<Wp9PublicationArm, Wp9AudienceArmEvidence>>;
  readonly cases: readonly Wp9AudienceCase[];
}

export type Wp9ApprovalEvent =
  | Readonly<{ type: "SNAPSHOT_LOADED"; atMs: number }>
  | Readonly<{ type: "APPROVAL_REQUESTED"; approvalId: string; atMs: number }>
  | Readonly<{ type: "APPROVAL_SETTLED"; approvalId: string; atMs: number }>
  | Readonly<{ type: "PRESENTER_SPEECH_PAUSE"; atMs: number }>;

export interface Wp9ApprovalLoadFixture {
  readonly schemaVersion: 1;
  readonly evidenceKind: "DETERMINISTIC_VENUE_LENGTH_APPROVAL_SIMULATION";
  readonly sessionDurationMs: number;
  readonly baselineControlActions: number;
  readonly events: readonly Wp9ApprovalEvent[];
}

export interface Wp9ApprovalLoadThresholds {
  readonly approvalCountMaximum: number;
  readonly approvalP50MaximumMs: number;
  readonly approvalP90MaximumMs: number;
  readonly effortProxyMaximum: number;
  readonly inducedPauseRateMaximumPerTenMinutes: number;
  readonly approvalTimeoutMs: number;
}

export interface Wp9ApprovalLoadEvidence {
  readonly passed: boolean;
  readonly sessionDurationMs: number;
  readonly approvalCount: number;
  readonly latenciesMs: readonly number[];
  readonly approvalP50Ms: number;
  readonly approvalP90Ms: number;
  readonly effortProxy: number;
  readonly inducedPauseCount: number;
  readonly inducedPauseRatePerTenMinutes: number;
  readonly timedOutApprovalIds: readonly string[];
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? Number.POSITIVE_INFINITY : numerator / denominator;
}

function nearestRank(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? Number.POSITIVE_INFINITY;
}

export function evaluateWp9AudienceExperiment(
  fixture: Wp9AudienceFixture,
  thresholds: Readonly<Record<Wp9PublicationArm, Wp9AudienceThresholds>>,
): Wp9AudienceEvidence {
  const armEvidence = (arm: Wp9PublicationArm): Wp9AudienceArmEvidence => {
    const cases = fixture.cases.filter((testCase) => testCase.arm === arm);
    const answerable = cases.filter((testCase) => testCase.answerable);
    const eligible = answerable.filter((testCase) => testCase.eligible);
    const unanswerable = cases.filter((testCase) => !testCase.answerable);
    return {
      caseCount: cases.length,
      eligibleYield: rate(eligible.length, answerable.length),
      usefulness: rate(
        eligible.filter((testCase) => testCase.useful === true).length,
        eligible.length,
      ),
      abstention: rate(
        unanswerable.filter((testCase) => testCase.abstained).length,
        unanswerable.length,
      ),
    };
  };
  const arms = {
    CURATED: armEvidence("CURATED"),
    SUPERVISED_LIVE: armEvidence("SUPERVISED_LIVE"),
  };
  const passes = (arm: Wp9PublicationArm) =>
    arms[arm].eligibleYield >= thresholds[arm].eligibleYieldMinimum &&
    arms[arm].usefulness >= thresholds[arm].usefulnessMinimum &&
    arms[arm].abstention >= thresholds[arm].abstentionMinimum;
  const gateStatesValid = fixture.cases.every((testCase) =>
    testCase.arm === "CURATED"
      ? testCase.gateManifestState === "CURATED_AVAILABLE" &&
        testCase.observedPublication !== "BLOCKED_BY_DEFAULT_OFF"
      : testCase.gateManifestState === "WP0_BLOCKED_LIVE_DEFAULT_OFF" &&
        testCase.observedPublication !== "CURATED_PUBLISHED",
  );
  return {
    machineThresholdsPassed: gateStatesValid && passes("CURATED") && passes("SUPERVISED_LIVE"),
    productAcceptanceEligible: false,
    collectionStatus: fixture.collectionStatus,
    gateStatus: fixture.gateStatus,
    arms,
    cases: fixture.cases,
  };
}

export function evaluateWp9ApprovalLoad(
  fixture: Wp9ApprovalLoadFixture,
  thresholds: Wp9ApprovalLoadThresholds,
): Wp9ApprovalLoadEvidence {
  const pending = new Map<string, number>();
  const latencies = new Map<string, number>();
  let snapshotAvailable = false;
  let pauseCount = 0;
  let lastAtMs = -1;
  for (const event of fixture.events) {
    if (
      !Number.isSafeInteger(event.atMs) ||
      event.atMs < lastAtMs ||
      event.atMs > fixture.sessionDurationMs
    ) {
      throw new Error("approval events must be ordered integer offsets within the session");
    }
    lastAtMs = event.atMs;
    if (event.type === "SNAPSHOT_LOADED") snapshotAvailable = true;
    if (event.type === "PRESENTER_SPEECH_PAUSE") pauseCount += 1;
    if (event.type === "APPROVAL_REQUESTED") {
      if (!snapshotAvailable || pending.has(event.approvalId) || latencies.has(event.approvalId)) {
        throw new Error(`invalid approval request ${event.approvalId}`);
      }
      pending.set(event.approvalId, event.atMs);
      snapshotAvailable = false;
    }
    if (event.type === "APPROVAL_SETTLED") {
      const startedAt = pending.get(event.approvalId);
      if (startedAt === undefined)
        throw new Error(`approval settled without request ${event.approvalId}`);
      pending.delete(event.approvalId);
      latencies.set(event.approvalId, event.atMs - startedAt);
    }
  }
  const timedOutApprovalIds = [
    ...pending.keys(),
    ...[...latencies]
      .filter(([, latency]) => latency > thresholds.approvalTimeoutMs)
      .map(([id]) => id),
  ].sort();
  const latenciesMs = [...latencies.values()];
  const approvalCount = latenciesMs.length;
  const approvalP50Ms = nearestRank(latenciesMs, 0.5);
  const approvalP90Ms = nearestRank(latenciesMs, 0.9);
  const effortProxy = rate(approvalCount, fixture.baselineControlActions);
  const inducedPauseRatePerTenMinutes = rate(pauseCount * 600_000, fixture.sessionDurationMs);
  return {
    passed:
      timedOutApprovalIds.length === 0 &&
      approvalCount <= thresholds.approvalCountMaximum &&
      approvalP50Ms <= thresholds.approvalP50MaximumMs &&
      approvalP90Ms <= thresholds.approvalP90MaximumMs &&
      effortProxy <= thresholds.effortProxyMaximum &&
      inducedPauseRatePerTenMinutes <= thresholds.inducedPauseRateMaximumPerTenMinutes,
    sessionDurationMs: fixture.sessionDurationMs,
    approvalCount,
    latenciesMs,
    approvalP50Ms,
    approvalP90Ms,
    effortProxy,
    inducedPauseCount: pauseCount,
    inducedPauseRatePerTenMinutes,
    timedOutApprovalIds,
  };
}
