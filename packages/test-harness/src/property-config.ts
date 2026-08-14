export type FastCheckParameters = Readonly<{
  seed: number;
  numRuns: number;
}>;

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export function fastCheckParameters(): FastCheckParameters {
  return {
    seed: positiveInteger("FAST_CHECK_SEED", 20_260_814),
    numRuns: positiveInteger("FAST_CHECK_RUNS", 250),
  };
}
