import { runWindowsTopologyE2E } from "../tests/e2e/windows-topology.harness.ts";

const evidence = await runWindowsTopologyE2E();
if (
  evidence.rehearsals.length !== 9 ||
  evidence.unrecoverableFailureCount !== 0 ||
  evidence.privatePixelCount !== 0 ||
  evidence.audienceReadySuccessRate < 0.85 ||
  evidence.audienceReadyMedianMs > 180_000 ||
  evidence.audienceReadyP90Ms > 300_000 ||
  evidence.maxRecoveryMs > 30_000 ||
  !evidence.coResidentCycle.enabledObserved ||
  evidence.coResidentCycle.leakPrivatePixelCount <= 0 ||
  !evidence.coResidentCycle.disabledObserved ||
  evidence.coResidentCycle.postDisablePrivatePixelCount !== 0 ||
  !evidence.coResidentConvenienceDisabled
) {
  throw new Error("WP4 Windows topology gate failed");
}
for (const mode of ["extend", "duplicate", "single"] as const) {
  const modeRuns = evidence.rehearsals.filter((rehearsal) => rehearsal.mode === mode);
  if (
    modeRuns.length !== 3 ||
    modeRuns.some(
      (run) =>
        run.faults.length !== 8 ||
        run.observedTransition !== run.requestedTransition ||
        run.outcome !== "SUCCESS",
    )
  ) {
    throw new Error(`${mode} did not complete three full fault rehearsals`);
  }
}

console.log(
  JSON.stringify({
    modes: Object.fromEntries(
      ["extend", "duplicate", "single"].map((mode) => {
        const runs = evidence.rehearsals.filter((rehearsal) => rehearsal.mode === mode);
        return [
          mode,
          {
            rehearsals: runs.length,
            successfulRehearsals: runs.filter((run) => run.outcome === "SUCCESS").length,
            failedRehearsals: runs.filter((run) => run.outcome === "FAILURE").length,
            faultRecoveries: runs.reduce((sum, run) => sum + run.faults.length, 0),
            realFaults: runs.reduce(
              (sum, run) =>
                sum + run.faults.filter((fault) => fault.injectionKind === "REAL").length,
              0,
            ),
            simulatedFaults: runs.reduce(
              (sum, run) =>
                sum + run.faults.filter((fault) => fault.injectionKind === "SIMULATED").length,
              0,
            ),
            maxRecoveryMs: Number(
              Math.max(
                ...runs.flatMap((run) => run.faults.map((fault) => fault.recoveryMs)),
              ).toFixed(3),
            ),
            privatePixelCount: runs.reduce((sum, run) => sum + run.privatePixelCount, 0),
            requestedTransitions: runs.map((run) => run.requestedTransition),
            observedTransitions: runs.map((run) => run.observedTransition),
            observedModes: runs.map((run) => run.observedMode),
            privateContentVerdicts: runs.map((run) => run.artifact.privateContentVerdict),
            privatePixelVerdicts: runs.map((run) => run.artifact.privatePixelVerdict),
            screenshotChecksums: runs.map((run) => run.artifact.screenshotChecksum),
            windowManagement: runs.map((run) => run.windowManagement),
            changeScreen: runs.map((run) => run.changeScreen),
            manualPlacementFallback: runs.map((run) => run.manualPlacementFallback),
            targetScreenLossRecovery: runs.map((run) => run.targetScreenLossRecovery),
          },
        ];
      }),
    ),
    unrecoverableFailureCount: evidence.unrecoverableFailureCount,
    privatePixelCount: evidence.privatePixelCount,
    audienceReadySuccessRate: evidence.audienceReadySuccessRate,
    audienceReadyMedianMs: Number(evidence.audienceReadyMedianMs.toFixed(3)),
    audienceReadyP90Ms: Number(evidence.audienceReadyP90Ms.toFixed(3)),
    maxRecoveryMs: Number(evidence.maxRecoveryMs.toFixed(3)),
    coResidentConvenienceDisabled: evidence.coResidentConvenienceDisabled,
    coResidentCycle: evidence.coResidentCycle,
    evidenceArtifactPath: evidence.evidenceArtifactPath,
    evidenceArtifactChecksum: evidence.evidenceArtifactChecksum,
    surface: "clean-signed-out-chrome+public-stage+projection-sse-fault-fixture",
  }),
);
