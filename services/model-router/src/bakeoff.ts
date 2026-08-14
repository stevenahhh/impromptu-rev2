export interface KoreanSttBakeoffCase {
  readonly id: string;
  readonly expectedTranscript: string;
}

export interface OfflineSttOutput {
  readonly transcript: string;
  readonly latencyMs: number;
}

export interface OfflineKoreanSttProvider {
  readonly name: "azure" | "deepgram" | "google" | "aws";
  readonly costPerMinuteUsd: number;
  readonly outputs: Readonly<Record<string, OfflineSttOutput>>;
  readonly networkRequests: number;
  transcribe(caseId: string): Promise<OfflineSttOutput>;
}

export interface KoreanSttBakeoffRow {
  readonly provider: OfflineKoreanSttProvider["name"];
  readonly accuracyPercent: number;
  readonly latencyP95Ms: number;
  readonly costPerMinuteUsd: number;
}

export const KOREAN_STT_BAKEOFF_CASES: readonly KoreanSttBakeoffCase[] = deepFreeze([
  { id: "ko-case-1", expectedTranscript: "오늘 발표의 핵심은 검증 가능한 근거입니다" },
  { id: "ko-case-2", expectedTranscript: "두 번째 슬라이드에서 비용을 비교합니다" },
  { id: "ko-case-3", expectedTranscript: "질문은 발표가 끝난 뒤에 받겠습니다" },
  { id: "ko-case-4", expectedTranscript: "개인정보는 서버에 저장하지 않습니다" },
]);

const FIXED_OUTPUTS = deepFreeze({
  azure: {
    "ko-case-1": output("오늘 발표의 핵심은 검증 가능한 근거입니다", 640),
    "ko-case-2": output("두 번째 슬라이드에서 비용을 비교합니다", 710),
    "ko-case-3": output("질문은 발표가 끝난 뒤에 받겠습니다", 760),
    "ko-case-4": output("개인정보는 서버에 저장하지 않습니다", 690),
  },
  deepgram: {
    "ko-case-1": output("오늘 발표의 핵심은 검증 가능한 근거입니다", 410),
    "ko-case-2": output("두 번째 슬라이드에서 비용을 비교합니다", 450),
    "ko-case-3": output("질문은 발표가 끝난 뒤에 받겠습니다", 480),
    "ko-case-4": output("개인 정보는 서버에 저장하지 않습니다", 430),
  },
  google: {
    "ko-case-1": output("오늘 발표의 핵심은 검증 가능한 근거입니다", 560),
    "ko-case-2": output("두번째 슬라이드에서 비용을 비교합니다", 590),
    "ko-case-3": output("질문은 발표가 끝난 뒤에 받겠습니다", 620),
    "ko-case-4": output("개인정보는 서버에 저장하지 않습니다", 580),
  },
  aws: {
    "ko-case-1": output("오늘 발표의 핵심은 검증 가능한 근거입니다", 650),
    "ko-case-2": output("두 번째 슬라이드에서 비용을 비교합니다", 670),
    "ko-case-3": output("질문은 발표가 끝난 뒤 받겠습니다", 690),
    "ko-case-4": output("개인 정보는 서버에 저장하지 않습니다", 660),
  },
});

export function createOfflineKoreanSttProviders(): readonly OfflineKoreanSttProvider[] {
  return deepFreeze([
    provider("azure", 0.017, FIXED_OUTPUTS.azure),
    provider("deepgram", 0.0043, FIXED_OUTPUTS.deepgram),
    provider("google", 0.024, FIXED_OUTPUTS.google),
    provider("aws", 0.024, FIXED_OUTPUTS.aws),
  ]);
}

export async function runKoreanSttBakeoff(
  cases: readonly KoreanSttBakeoffCase[],
  providers: readonly OfflineKoreanSttProvider[],
): Promise<readonly KoreanSttBakeoffRow[]> {
  const rows: KoreanSttBakeoffRow[] = [];
  for (const candidate of providers) {
    let exact = 0;
    const latencies: number[] = [];
    for (const fixture of cases) {
      const result = await candidate.transcribe(fixture.id);
      if (normalize(result.transcript) === normalize(fixture.expectedTranscript)) exact += 1;
      latencies.push(result.latencyMs);
    }
    latencies.sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
    rows.push({
      provider: candidate.name,
      accuracyPercent: cases.length === 0 ? 0 : (exact / cases.length) * 100,
      latencyP95Ms: latencies[p95Index] ?? 0,
      costPerMinuteUsd: candidate.costPerMinuteUsd,
    });
  }
  rows.sort(
    (left, right) =>
      right.accuracyPercent - left.accuracyPercent || left.latencyP95Ms - right.latencyP95Ms,
  );
  return deepFreeze(rows);
}

function provider(
  name: OfflineKoreanSttProvider["name"],
  costPerMinuteUsd: number,
  outputs: Readonly<Record<string, OfflineSttOutput>>,
): OfflineKoreanSttProvider {
  return Object.freeze({
    name,
    costPerMinuteUsd,
    outputs,
    networkRequests: 0,
    async transcribe(caseId: string) {
      const result = outputs[caseId];
      if (result === undefined) throw new TypeError(`Unknown offline STT case: ${caseId}`);
      return result;
    },
  });
}

function output(transcript: string, latencyMs: number): OfflineSttOutput {
  return { transcript, latencyMs };
}

function normalize(value: string): string {
  return value.normalize("NFC").trim().replaceAll(/\s+/g, " ");
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
