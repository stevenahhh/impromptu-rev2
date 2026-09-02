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

/**
 * Korean decks write units as words, and a model reports them in normalized notation: evidence
 * saying "92퍼센트" against a claim of "92%" is the same fact. Without these aliases every
 * Korean deck abstained with UNIT:%, exactly as the calendar-date gap below once did.
 * Existence is still enforced — a unit the evidence never states stays rejected.
 */
const UNIT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "%": "%",
  percent: "%",
  percentage: "%",
  퍼센트: "%",
  프로: "%",
  usd: "usd",
  dollar: "usd",
  dollars: "usd",
  달러: "usd",
  krw: "krw",
  won: "krw",
  원: "krw",
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
  const selected: RetrievedEvidence[] = [];
  for (const id of recommendation.evidenceIds) {
    const match = evidence.find((item) => item.evidenceId === id);
    if (match === undefined) {
      return { outcome: "MISMATCH", category: "SOURCE", value: "unknown evidence id" };
    }
    selected.push(match);
  }
  // The chunk title is part of the evidence record: ingestion titles every deck chunk
  // "Slide N" from the manifest's source index. Console slide queries carry that ordinal and
  // models echo it into claims, so a fact must be checkable against the title as well as the
  // content — a claim of "slide 3" is supported when the cited evidence IS Slide 3.
  const evidenceText = selected.map((item) => `${item.title}\n${item.content}`).join("\n");
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
    [
      // A figure ends where a Latin letter or another digit would continue it, not where any
      // letter does. Korean sets the counter directly against the figure - 482억, 12,400명,
      // 2026년 - so treating every letter as a continuation hid those figures entirely and
      // truncated 12,400 to 12, which then let a claim of "12" pass against evidence that never
      // stated it.
      ...text.matchAll(
        /(?<![\p{Script=Latin}\p{N}])[-+]?\d[\d,]*(?:\.\d+)?(?![\p{Script=Latin}\p{N}])/gu,
      ),
    ].map((match) => normalizeNumber(match[0])),
  );
  const dates = unique(
    [
      ...text.matchAll(/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{4})\b/g),
      // Bare years are already captured by the number pattern; classify them as dates too so a
      // year that exists in the source is not rejected merely because the model labeled it
      // DATE instead of NUMBER. Restricted to plausible years so 4-digit quantities (e.g. 1200)
      // stay numbers. Existence is still enforced: the token must occur verbatim.
      ...text.matchAll(/(?<![\p{Script=Latin}\p{N}])(?:19|20)\d{2}(?![\p{Script=Latin}\p{N}])/gu),
    ]
      .map((match) => normalizeDate(match[0]))
      .concat(koreanCalendarDates(text)),
  );
  const units = unique(
    [
      ...text.matchAll(
        /%|\b(?:percent(?:age)?|usd|dollars?|krw|won|million|billion|thousand|kg|km|cm|gb|mb|m)\b/gi,
      ),
      // Hangul has no Latin word boundary, and bare 원/프로 are ordinary words, so a Korean
      // unit counts only where it follows the quantity it measures.
      ...text.matchAll(/(?<=\d\s?)(?:퍼센트|프로|달러|원)/gu),
      // Korean money writes the counter between the figure and 원 - 52억 원, 3만원 - and
      // scale alone attaches directly to a figure (482억). Without these, evidence stating the
      // amount was invisible to a claim that reported the same amount's unit.
      ...text.matchAll(/(?<=\d)(?:억|만|천)\s*원/gu),
      ...text.matchAll(/(?<=\d)억/gu),
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
  // Money counters may carry a space on either side (억 원 / 억원); one canonical form keeps a
  // model's spaced report reconcilable against unspaced evidence and vice versa.
  const compactKoreanMoney = normalized.replace(/^(억|만|천)\s*원$/, "$1원");
  return UNIT_ALIASES[compactKoreanMoney] ?? compactKoreanMoney;
}

/**
 * Korean writes a calendar date as 2026년 1월 15일, and a month alone as 2026년 3월. A model
 * reading such a deck reports the date in its normalized form, so the extractor has to recognise
 * the notation the evidence is actually written in. Existence is still enforced: the date must be
 * constructible from the evidence text, so a date the deck never states stays rejected.
 */
function koreanCalendarDates(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/(\d{4})년\s*(\d{1,2})월(?:\s*(\d{1,2})일)?/gu)) {
    const [, year, month, day] = match;
    if (year === undefined || month === undefined) continue;
    const yearMonth = `${year}-${month.padStart(2, "0")}`;
    values.push(day === undefined ? yearMonth : `${yearMonth}-${day.padStart(2, "0")}`);
  }
  return values;
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
