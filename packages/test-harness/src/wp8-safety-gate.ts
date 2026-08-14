export type Wp8QualityMetric =
  | "NON_SUPPORTABLE"
  | "CONFLICT"
  | "NUMERIC"
  | "DATE"
  | "ENTITY"
  | "AUTHORITATIVE_CONFLICT"
  | "SUPPORTABLE_FETCHABLE"
  | "ANSWERABLE"
  | "UNANSWERABLE";

export interface Wp8RepresentativeHoldout {
  readonly schemaVersion: 2;
  readonly collectionStatus: "COLLECTED";
  readonly freezeStatus: "FROZEN";
  readonly suiteKind: "DETERMINISTIC_GUARDED_PILOT_HARNESS";
  readonly qualityCases: readonly Readonly<{
    caseId: string;
    metric: Wp8QualityMetric;
    observedOutcome: string;
  }>[];
  readonly approvalCases: readonly Readonly<{
    caseId: string;
    milliseconds: number;
  }>[];
  readonly interactionCases: readonly Readonly<{
    caseId: string;
    observedMinutes: number;
    inducedSpeechPauses: number;
    baselineActions: number;
    supervisedAdditionalActions: number;
  }>[];
}

export interface Wp8GateThresholds {
  readonly falseSupportMaximum: number;
  readonly falseSupportUpper95MaximumExclusive: number;
  readonly falseConflictMaximum: number;
  readonly eligibleYieldMinimum: number;
  readonly usefulnessMinimum: number;
  readonly abstentionMinimum: number;
  readonly approvalMedianMaximumMs: number;
  readonly approvalP90MaximumMs: number;
  readonly inducedSpeechPausesMaximumPerTenMinutes: number;
  readonly effortDeltaMaximumExclusive: number;
}

export interface Wp8GateEvidence {
  readonly passed: boolean;
  readonly falseSupportRate: number;
  readonly falseSupportUpper95: number;
  readonly falseConflictRate: number;
  readonly wrongNumeric: number;
  readonly wrongDate: number;
  readonly wrongEntity: number;
  readonly authoritativeConflictAutoPublished: number;
  readonly eligibleYield: number;
  readonly usefulness: number;
  readonly abstention: number;
  readonly approvalMedianMs: number;
  readonly approvalP90Ms: number;
  readonly inducedSpeechPausesPerTenMinutes: number;
  readonly effortDelta: number;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? Number.POSITIVE_INFINITY : numerator / denominator;
}

function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const ordered = [...values].sort((left, right) => left - right);
  return (
    ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)] ?? Number.POSITIVE_INFINITY
  );
}

function casesFor(holdout: Wp8RepresentativeHoldout, metric: Wp8QualityMetric) {
  return holdout.qualityCases.filter((testCase) => testCase.metric === metric);
}

function countOutcome(
  holdout: Wp8RepresentativeHoldout,
  metric: Wp8QualityMetric,
  outcome: string,
): number {
  return casesFor(holdout, metric).filter((testCase) => testCase.observedOutcome === outcome)
    .length;
}

/** Exact one-sided 95% Clopper-Pearson upper bound for the preregistered zero-event gate. */
export function zeroEventUpper95(sampleSize: number): number {
  return Number.isSafeInteger(sampleSize) && sampleSize > 0
    ? 1 - 0.05 ** (1 / sampleSize)
    : Number.POSITIVE_INFINITY;
}

export function evaluateWp8SafetyGate(
  holdout: Wp8RepresentativeHoldout,
  thresholds: Wp8GateThresholds,
): Wp8GateEvidence {
  const nonSupportable = casesFor(holdout, "NON_SUPPORTABLE");
  const falseSupport = countOutcome(holdout, "NON_SUPPORTABLE", "FALSE_SUPPORT");
  const conflicts = casesFor(holdout, "CONFLICT");
  const falseConflict = countOutcome(holdout, "CONFLICT", "FALSE_CONFLICT");
  const supportable = casesFor(holdout, "SUPPORTABLE_FETCHABLE");
  const answerable = casesFor(holdout, "ANSWERABLE");
  const unanswerable = casesFor(holdout, "UNANSWERABLE");
  const falseSupportRate = rate(falseSupport, nonSupportable.length);
  const falseSupportUpper95 =
    falseSupport === 0 ? zeroEventUpper95(nonSupportable.length) : Number.POSITIVE_INFINITY;
  const falseConflictRate = rate(falseConflict, conflicts.length);
  const wrongNumeric = countOutcome(holdout, "NUMERIC", "WRONG");
  const wrongDate = countOutcome(holdout, "DATE", "WRONG");
  const wrongEntity = countOutcome(holdout, "ENTITY", "WRONG");
  const authoritativeConflictAutoPublished = countOutcome(
    holdout,
    "AUTHORITATIVE_CONFLICT",
    "AUTO_PUBLISHED",
  );
  const eligibleYield = rate(
    countOutcome(holdout, "SUPPORTABLE_FETCHABLE", "ELIGIBLE_WITHIN_5S"),
    supportable.length,
  );
  const usefulness = rate(
    countOutcome(holdout, "ANSWERABLE", "USEFUL_TOP_THREE"),
    answerable.length,
  );
  const abstention = rate(countOutcome(holdout, "UNANSWERABLE", "ABSTAINED"), unanswerable.length);
  const approvalLatencies = holdout.approvalCases.map((testCase) => testCase.milliseconds);
  const approvalMedianMs = nearestRank(approvalLatencies, 0.5);
  const approvalP90Ms = nearestRank(approvalLatencies, 0.9);
  const observedMinutes = holdout.interactionCases.reduce(
    (total, testCase) => total + testCase.observedMinutes,
    0,
  );
  const inducedSpeechPauses = holdout.interactionCases.reduce(
    (total, testCase) => total + testCase.inducedSpeechPauses,
    0,
  );
  const baselineActions = holdout.interactionCases.reduce(
    (total, testCase) => total + testCase.baselineActions,
    0,
  );
  const additionalActions = holdout.interactionCases.reduce(
    (total, testCase) => total + testCase.supervisedAdditionalActions,
    0,
  );
  const inducedSpeechPausesPerTenMinutes = rate(inducedSpeechPauses * 10, observedMinutes);
  const effortDelta = rate(additionalActions, baselineActions);
  const passed =
    holdout.collectionStatus === "COLLECTED" &&
    holdout.freezeStatus === "FROZEN" &&
    falseSupportRate <= thresholds.falseSupportMaximum &&
    falseSupportUpper95 < thresholds.falseSupportUpper95MaximumExclusive &&
    wrongNumeric === 0 &&
    wrongDate === 0 &&
    wrongEntity === 0 &&
    falseConflictRate <= thresholds.falseConflictMaximum &&
    authoritativeConflictAutoPublished === 0 &&
    eligibleYield >= thresholds.eligibleYieldMinimum &&
    usefulness >= thresholds.usefulnessMinimum &&
    abstention >= thresholds.abstentionMinimum &&
    approvalMedianMs <= thresholds.approvalMedianMaximumMs &&
    approvalP90Ms <= thresholds.approvalP90MaximumMs &&
    inducedSpeechPausesPerTenMinutes <= thresholds.inducedSpeechPausesMaximumPerTenMinutes &&
    effortDelta < thresholds.effortDeltaMaximumExclusive;
  return {
    passed,
    falseSupportRate,
    falseSupportUpper95,
    falseConflictRate,
    wrongNumeric,
    wrongDate,
    wrongEntity,
    authoritativeConflictAutoPublished,
    eligibleYield,
    usefulness,
    abstention,
    approvalMedianMs,
    approvalP90Ms,
    inducedSpeechPausesPerTenMinutes,
    effortDelta,
  };
}

export interface Wp8AdversarialSuite {
  readonly schemaVersion: 2;
  readonly collectionStatus: "COLLECTED";
  readonly freezeStatus: "FROZEN";
  readonly suiteKind: "DETERMINISTIC_ADVERSARIAL_HARNESS";
  readonly cases: readonly Readonly<{
    caseId: string;
    family: string;
    observedOutcome: "BLOCKED" | "ESCAPED";
  }>[];
}

export function evaluateWp8AdversarialSuite(suite: Wp8AdversarialSuite): boolean {
  return (
    suite.collectionStatus === "COLLECTED" &&
    suite.freezeStatus === "FROZEN" &&
    suite.cases.length > 0 &&
    suite.cases.every((testCase) => testCase.observedOutcome === "BLOCKED")
  );
}
