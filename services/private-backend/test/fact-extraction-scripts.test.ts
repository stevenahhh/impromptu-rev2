import { describe, expect, test } from "bun:test";
import { extractFacts, reconcileEvidence } from "../src/verifier/deterministic-evidence.ts";

/**
 * Korean writes a figure and its counter with no separator - 482억, 12,400명, 2026년 - so the
 * fact extractor decides on those strings whether a claim that quotes the deck verbatim is
 * accepted. These cases come from the actual indexed chunks of the format-neutral fixtures.
 */

const koreanBody =
  "매출 실적 요약 2025년 연간 매출은 482억 원으로 전년 대비 23% 증가했다. 유료 구독자 수는 12,400명이다.";

function evidenceOf(content: string) {
  return [
    {
      evidenceId: "e",
      title: "S",
      anchor: "a",
      content,
      sourceId: "s",
      sourceRevision: "r",
      rights: "APPROVED",
      origin: "INTERNAL",
    },
  ] as never;
}

function verdict(content: string, facts: unknown) {
  return reconcileEvidence(
    { claim: content, evidenceIds: ["e"], facts } as never,
    evidenceOf(content),
  );
}

describe("fact extraction across scripts", () => {
  test("reads a figure that a Korean counter follows", () => {
    const facts = extractFacts(koreanBody);
    expect(facts.numbers).toContain("482");
    expect(facts.numbers).toContain("23");
  });

  test("keeps a grouped figure whole instead of truncating at the comma", () => {
    const facts = extractFacts(koreanBody);
    expect(facts.numbers).toContain("12400");
    expect(facts.numbers).not.toContain("12");
  });

  test("reads a year that a Korean counter follows", () => {
    expect(extractFacts(koreanBody).dates).toContain("2025");
  });

  test("accepts figures the evidence states verbatim", () => {
    expect(verdict(koreanBody, { numbers: ["482"], units: [], dates: [], entities: [] })).toEqual({
      outcome: "SUPPORTED",
    });
    expect(verdict(koreanBody, { numbers: [], units: [], dates: ["2025"], entities: [] })).toEqual({
      outcome: "SUPPORTED",
    });
  });

  // Characterization: these must reject before and after the extractor change.
  test("still rejects a figure the evidence never states", () => {
    expect(
      verdict(koreanBody, { numbers: ["999"], units: [], dates: [], entities: [] }),
    ).toMatchObject({
      outcome: "MISMATCH",
      category: "NUMBER",
    });
  });

  test("still rejects a year the evidence never states", () => {
    expect(
      verdict(koreanBody, { numbers: [], units: [], dates: ["2019"], entities: [] }),
    ).toMatchObject({
      outcome: "MISMATCH",
      category: "DATE",
    });
  });

  test("still rejects a fragment of a grouped figure", () => {
    expect(
      verdict(koreanBody, { numbers: ["12"], units: [], dates: [], entities: [] }),
    ).toMatchObject({
      outcome: "MISMATCH",
      category: "NUMBER",
    });
  });

  test("keeps reading Latin-script evidence unchanged", () => {
    const facts = extractFacts("Revenue was 42 million USD in 2025.");
    expect(facts.numbers).toEqual(expect.arrayContaining(["42", "2025"]));
    expect(facts.units).toEqual(expect.arrayContaining(["million", "usd"]));
    expect(facts.entities).toContain("revenue");
  });

  test("keeps rejecting a digit run inside a Latin identifier", () => {
    expect(extractFacts("model a4x9 shipped").numbers).toEqual([]);
  });
});
