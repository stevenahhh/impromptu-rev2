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
  const asserted = {
    numbers: unique([...claimFacts.numbers, ...declared.numbers]),
    units: unique([...claimFacts.units, ...declared.units]),
    dates: unique([...claimFacts.dates, ...declared.dates]),
    entities: unique([...claimFacts.entities, ...declared.entities]),
  };
  const evidenceFacts = extractFacts(evidenceText);
  for (const [category, values, available] of [
    ["NUMBER", asserted.numbers, evidenceFacts.numbers] as const,
    ["UNIT", asserted.units, evidenceFacts.units] as const,
    ["DATE", asserted.dates, evidenceFacts.dates] as const,
  ]) {
    for (const value of values) {
      if (!available.includes(value)) return { outcome: "MISMATCH", category, value };
    }
  }
  const foldedClaim = fold(recommendation.claim);
  const foldedEvidence = fold(evidenceText);
  for (const entity of asserted.entities) {
    if (!foldedClaim.includes(entity) || !containsTokenRun(foldedEvidence, entity)) {
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
    [
      ...text.matchAll(/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{4})\b/g),
      // Bare years are already captured by the number pattern; classify them as dates too so a
      // year that exists in the source is not rejected merely because the model labeled it
      // DATE instead of NUMBER. Restricted to plausible years so 4-digit quantities (e.g. 1200)
      // stay numbers. Existence is still enforced: the token must occur verbatim.
      ...text.matchAll(/(?<![\p{L}\p{N}])(?:19|20)\d{2}(?![\p{L}\p{N}])/gu),
    ].map((match) => normalizeDate(match[0])),
  );
  const units = unique(
    [
      ...text.matchAll(
        /%|\b(?:percent(?:age)?|usd|dollars?|krw|won|million|billion|thousand|kg|km|cm|gb|mb|m)\b/gi,
      ),
    ].map((match) => normalizeUnit(match[0])),
  );
  const entities = unique(
    [
      ...text.matchAll(
        /(?<![\p{L}\p{N}])\p{Lu}[\p{Script=Latin}\p{N}&.'’-]*(?:\s+\p{Lu}[\p{Script=Latin}\p{N}&.'’-]*)*/gu,
      ),
    ]
      .map((match) => fold(match[0]))
      .filter((entity) => entity.length > 1 && UNIT_ALIASES[entity] === undefined),
  );
  return { numbers, units, dates, entities };
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

function stripEdgePunctuation(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Whether the entity occurs as consecutive whitespace-delimited tokens. The uppercase-initial
 * extractor never yields Korean candidates, so declared entities are judged by verbatim token
 * existence; whole-token matching still prevents hits inside a longer unrelated word. */
function containsTokenRun(haystack: string, entity: string): boolean {
  const haystackTokens = haystack.split(/\s+/).map(stripEdgePunctuation);
  const needleTokens = entity.split(/\s+/).map(stripEdgePunctuation).filter(Boolean);
  if (needleTokens.length === 0 || needleTokens.length > haystackTokens.length) return false;
  outer: for (let start = 0; start <= haystackTokens.length - needleTokens.length; start += 1) {
    for (let offset = 0; offset < needleTokens.length; offset += 1) {
      if (haystackTokens[start + offset] !== needleTokens[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
