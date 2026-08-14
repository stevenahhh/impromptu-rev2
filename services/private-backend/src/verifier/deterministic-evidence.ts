import type {
  EvidenceFactSet,
  RetrievedEvidence,
  StructuredRecommendation,
} from "@impromptu/contracts/retrieval";

export type DeterministicEvidenceVerdict =
  | Readonly<{ outcome: "SUPPORTED" }>
  | Readonly<{
      outcome: "MISMATCH";
      category: "NUMBER" | "UNIT" | "DATE" | "ENTITY" | "SOURCE";
      value: string;
    }>;

const UNIT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "%": "%",
  percent: "%",
  percentage: "%",
  usd: "usd",
  dollar: "usd",
  dollars: "usd",
  krw: "krw",
  won: "krw",
  million: "million",
  billion: "billion",
  thousand: "thousand",
  kg: "kg",
  km: "km",
  m: "m",
  cm: "cm",
  gb: "gb",
  mb: "mb",
});

export function reconcileEvidence(
  recommendation: StructuredRecommendation,
  evidence: readonly RetrievedEvidence[],
): DeterministicEvidenceVerdict {
  const selected = recommendation.evidenceIds.map((id) =>
    evidence.find((item) => item.evidenceId === id),
  );
  if (selected.some((item) => item === undefined)) {
    return { outcome: "MISMATCH", category: "SOURCE", value: "unknown evidence id" };
  }
  const evidenceText = selected.map((item) => item?.content ?? "").join("\n");
  const claimFacts = extractFacts(recommendation.claim);
  const declared = normalizeFacts(recommendation.facts);
  for (const [category, values] of [
    ["NUMBER", claimFacts.numbers] as const,
    ["UNIT", claimFacts.units] as const,
    ["DATE", claimFacts.dates] as const,
  ]) {
    const declaredValues =
      category === "NUMBER"
        ? declared.numbers
        : category === "UNIT"
          ? declared.units
          : declared.dates;
    for (const value of values) {
      if (!declaredValues.includes(value)) return { outcome: "MISMATCH", category, value };
    }
  }
  const evidenceFacts = extractFacts(evidenceText);
  for (const [category, values, available] of [
    ["NUMBER", declared.numbers, evidenceFacts.numbers] as const,
    ["UNIT", declared.units, evidenceFacts.units] as const,
    ["DATE", declared.dates, evidenceFacts.dates] as const,
  ]) {
    for (const value of values) {
      if (!available.includes(value)) return { outcome: "MISMATCH", category, value };
    }
  }
  const foldedClaim = fold(recommendation.claim);
  const foldedEvidence = fold(evidenceText);
  for (const entity of declared.entities) {
    if (!foldedClaim.includes(entity) || !foldedEvidence.includes(entity)) {
      return { outcome: "MISMATCH", category: "ENTITY", value: entity };
    }
  }
  return { outcome: "SUPPORTED" };
}

export function extractFacts(text: string): EvidenceFactSet {
  const numbers = unique(
    [...text.matchAll(/(?<![\p{L}\p{N}])[-+]?\d[\d,]*(?:\.\d+)?(?![\p{L}\p{N}])/gu)].map((match) =>
      normalizeNumber(match[0]),
    ),
  );
  const dates = unique(
    [...text.matchAll(/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{4})\b/g)].map((match) =>
      normalizeDate(match[0]),
    ),
  );
  const units = unique(
    [
      ...text.matchAll(
        /%|\b(?:percent(?:age)?|usd|dollars?|krw|won|million|billion|thousand|kg|km|cm|gb|mb|m)\b/gi,
      ),
    ].map((match) => normalizeUnit(match[0])),
  );
  return { numbers, units, dates, entities: [] };
}

function normalizeFacts(facts: EvidenceFactSet): EvidenceFactSet {
  return {
    numbers: unique(facts.numbers.map(normalizeNumber)),
    units: unique(facts.units.map(normalizeUnit)),
    dates: unique(facts.dates.map(normalizeDate)),
    entities: unique(facts.entities.map(fold).filter((value) => value.length > 0)),
  };
}

function normalizeNumber(value: string): string {
  const normalized = value.replaceAll(",", "").replace(/^\+/, "");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? String(numeric) : fold(value);
}

function normalizeUnit(value: string): string {
  const normalized = fold(value);
  return UNIT_ALIASES[normalized] ?? normalized;
}

function normalizeDate(value: string): string {
  const normalized = value.replace(/[/.]/g, "-");
  const parts = normalized.split("-");
  if (parts.length !== 3) return fold(value);
  const [a = "", b = "", c = ""] = parts;
  return a.length === 4
    ? `${a}-${b.padStart(2, "0")}-${c.padStart(2, "0")}`
    : `${c}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`;
}

function fold(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
