export interface Wp8RepresentativeHoldout {
  readonly schemaVersion: 1;
  readonly representative: Readonly<{
    nonSupportable: number;
    falseSupport: number;
    conflict: number;
    falseConflict: number;
    numeric: number;
    wrongNumeric: number;
    date: number;
    wrongDate: number;
    entity: number;
    wrongEntity: number;
    authoritativeConflict: number;
    authoritativeConflictAutoPublished: number;
    supportableFetchable: number;
    eligibleWithinFiveSeconds: number;
    answerable: number;
    usefulTopThree: number;
    unanswerable: number;
    abstained: number;
  }>;
  readonly approvalLatencyHistogram: readonly Readonly<{
    milliseconds: number;
    count: number;
  }>[];
  readonly interaction: Readonly<{
    observedMinutes: number;
    inducedSpeechPauses: number;
    baselineActions: number;
    supervisedAdditionalActions: number;
  }>;
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

function expandHistogram(
  histogram: Wp8RepresentativeHoldout["approvalLatencyHistogram"],
): number[] {
  return histogram.flatMap(({ milliseconds, count }) =>
    Number.isSafeInteger(milliseconds) &&
    milliseconds >= 0 &&
    Number.isSafeInteger(count) &&
    count > 0
      ? Array.from({ length: count }, () => milliseconds)
      : [],
  );
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
  const representative = holdout.representative;
  const approvalLatencies = expandHistogram(holdout.approvalLatencyHistogram);
  const falseSupportRate = rate(representative.falseSupport, representative.nonSupportable);
  const falseSupportUpper95 =
    representative.falseSupport === 0
      ? zeroEventUpper95(representative.nonSupportable)
      : Number.POSITIVE_INFINITY;
  const falseConflictRate = rate(representative.falseConflict, representative.conflict);
  const eligibleYield = rate(
    representative.eligibleWithinFiveSeconds,
    representative.supportableFetchable,
  );
  const usefulness = rate(representative.usefulTopThree, representative.answerable);
  const abstention = rate(representative.abstained, representative.unanswerable);
  const approvalMedianMs = nearestRank(approvalLatencies, 0.5);
  const approvalP90Ms = nearestRank(approvalLatencies, 0.9);
  const inducedSpeechPausesPerTenMinutes = rate(
    holdout.interaction.inducedSpeechPauses * 10,
    holdout.interaction.observedMinutes,
  );
  const effortDelta = rate(
    holdout.interaction.supervisedAdditionalActions,
    holdout.interaction.baselineActions,
  );
  const passed =
    falseSupportRate <= thresholds.falseSupportMaximum &&
    falseSupportUpper95 < thresholds.falseSupportUpper95MaximumExclusive &&
    representative.wrongNumeric === 0 &&
    representative.wrongDate === 0 &&
    representative.wrongEntity === 0 &&
    falseConflictRate <= thresholds.falseConflictMaximum &&
    representative.authoritativeConflictAutoPublished === 0 &&
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
    wrongNumeric: representative.wrongNumeric,
    wrongDate: representative.wrongDate,
    wrongEntity: representative.wrongEntity,
    authoritativeConflictAutoPublished: representative.authoritativeConflictAutoPublished,
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
  readonly schemaVersion: 1;
  readonly criticalCases: number;
  readonly criticalEscapes: number;
}

export function evaluateWp8AdversarialSuite(suite: Wp8AdversarialSuite): boolean {
  return suite.criticalCases > 0 && suite.criticalEscapes === 0;
}
