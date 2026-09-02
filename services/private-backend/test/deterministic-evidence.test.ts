import { describe, expect, test } from "bun:test";
import { RetrievedEvidenceSchema } from "@impromptu/contracts/retrieval";
import { reconcileEvidence } from "../src/verifier/deterministic-evidence.ts";

// The real fixture chunk content is exactly this sentence; "2026" occurs verbatim in it.
const evidenceContent = "형식 중립 근거 자료 2026";
const sourceHash = new Bun.CryptoHasher("sha256").update(evidenceContent).digest("hex");
const evidence = RetrievedEvidenceSchema.parse({
  evidenceId: "ev_1",
  sourceId: "s",
  sourceRevision: "r",
  sourceHash,
  deckVersion: "deck_v1",
  manifestHash: "a".repeat(64),
  title: "t",
  content: evidenceContent,
  quote: "q",
  anchor: "a",
  canonicalUrl: null,
  sourceDate: null,
  rights: "APPROVED",
  containsPii: false,
  authorizationVersion: "acl-v1",
});

function reconcile(facts: {
  numbers?: string[];
  units?: string[];
  dates?: string[];
  entities?: string[];
}) {
  return reconcileEvidence(
    {
      claim: "형식 중립 근거 자료는 2026년 자료입니다.",
      evidenceIds: [evidence.evidenceId],
      facts: {
        numbers: facts.numbers ?? [],
        units: facts.units ?? [],
        dates: facts.dates ?? [],
        entities: facts.entities ?? [],
      },
    },
    [evidence],
  );
}

describe("deterministic evidence reconciliation", () => {
  test("accepts a bare year declared as DATE when the token exists in the evidence (case A)", () => {
    // The date extractor historically only recognized full Y-M-D forms, so a model that
    // correctly labeled the year present in the source as a DATE was rejected even though
    // the identical token labeled NUMBER was accepted.
    expect(reconcile({ dates: ["2026"] })).toEqual({ outcome: "SUPPORTED" });
  });

  test("accepts a bare year declared as NUMBER when the token exists in the evidence (case B)", () => {
    expect(reconcile({ numbers: ["2026"] })).toEqual({ outcome: "SUPPORTED" });
  });

  test("rejects a number absent from the evidence (case C)", () => {
    expect(reconcile({ numbers: ["1999"] })).toEqual({
      outcome: "MISMATCH",
      category: "NUMBER",
      value: "1999",
    });
  });

  test("rejects a full date absent from the evidence (case D)", () => {
    expect(reconcile({ dates: ["2026-01-01"] })).toEqual({
      outcome: "MISMATCH",
      category: "DATE",
      value: "2026-01-01",
    });
  });

  test("accepts a Korean entity declared verbatim from the evidence", () => {
    // The entity extractor only recognizes uppercase-initial Latin tokens, so the evidence
    // side never yields Korean candidates. A Korean entity that occurs verbatim in the
    // evidence must still be judged by existence, not by extractor coverage.
    expect(reconcile({ entities: ["형식 중립 근거 자료"] })).toEqual({ outcome: "SUPPORTED" });
  });

  test("rejects an entity absent from the evidence", () => {
    expect(reconcile({ entities: ["서울 강남구"] })).toEqual({
      outcome: "MISMATCH",
      category: "ENTITY",
      value: "서울 강남구",
    });
  });

  test("does not reclassify 4-digit quantities as years", () => {
    // "1,200" is a quantity; only plausible years (1900-2099) may satisfy a DATE fact.
    const quantityEvidence = {
      ...evidence,
      content: "Acme shipped 1,200 kg in total.",
      sourceHash: new Bun.CryptoHasher("sha256")
        .update("Acme shipped 1,200 kg in total.")
        .digest("hex"),
    };
    expect(
      reconcileEvidence(
        {
          claim: "Acme shipped 1200 kg.",
          evidenceIds: [quantityEvidence.evidenceId],
          facts: { numbers: [], units: [], dates: ["1200"], entities: [] },
        },
        [quantityEvidence],
      ),
    ).toEqual({ outcome: "MISMATCH", category: "DATE", value: "1200" });
  });
});

describe("Korean unit notation", () => {
  const koreanContent = "시설 점유율 예측 정확도의 2026년 목표치는 92퍼센트다.";
  const koreanHash = new Bun.CryptoHasher("sha256").update(koreanContent).digest("hex");
  const koreanEvidence = RetrievedEvidenceSchema.parse({
    evidenceId: "ev_ko",
    sourceId: "s",
    sourceRevision: "r",
    sourceHash: koreanHash,
    deckVersion: "deck_v1",
    manifestHash: "a".repeat(64),
    title: "t",
    content: koreanContent,
    quote: "q",
    anchor: "a",
    canonicalUrl: null,
    sourceDate: null,
    rights: "APPROVED",
    containsPii: false,
    authorizationVersion: "acl-v1",
  });

  function reconcileKorean(units: readonly string[]) {
    return reconcileEvidence(
      {
        claim: "시설 점유율 예측 정확도 목표는 92%입니다.",
        evidenceIds: [koreanEvidence.evidenceId],
        facts: { numbers: ["92"], units: [...units], dates: [], entities: [] },
      },
      [koreanEvidence],
    );
  }

  test("reconciles a model's normalized % against Korean evidence written as 퍼센트", () => {
    // The product's default language is Korean, and this file already teaches the extractor
    // Korean calendar dates. Units were the remaining gap: evidence saying "92퍼센트" made the
    // gate reject a correct "92%" claim, so every Korean deck abstained with UNIT:%.
    expect(reconcileKorean(["%"])).toEqual({ outcome: "SUPPORTED" });
  });

  test("still rejects a unit the Korean evidence never states", () => {
    expect(reconcileKorean(["kg"])).toEqual({
      outcome: "MISMATCH",
      category: "UNIT",
      value: "kg",
    });
  });

  test("reconciles a spaced 억 원 report against evidence written as 52억 원", () => {
    // Korean money puts a scale counter between the figure and 원, often with spaces around it
    // (52억 원). The unit extractor only saw 단일 원/퍼센트 counters, so evidence stating the
    // exact amount abstained every claim that reported its scale.
    const content = "총 사업비는 52억 원이 투입된다.";
    const budgetEvidence = RetrievedEvidenceSchema.parse({
      evidenceId: "ev_budget",
      sourceId: "s",
      sourceRevision: "r",
      sourceHash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      deckVersion: "deck_v1",
      manifestHash: "a".repeat(64),
      title: "Slide 9",
      content,
      quote: "q",
      anchor: "a",
      canonicalUrl: null,
      sourceDate: null,
      rights: "APPROVED",
      containsPii: false,
      authorizationVersion: "acl-v1",
    });
    expect(
      reconcileEvidence(
        {
          claim: "총 사업비는 52억 원이다.",
          evidenceIds: [budgetEvidence.evidenceId],
          facts: { numbers: ["52"], units: ["억 원"], dates: [], entities: [] },
        },
        [budgetEvidence],
      ),
    ).toEqual({ outcome: "SUPPORTED" });
  });

  test("still rejects a money scale the Korean evidence never states", () => {
    const content = "총 사업비는 52억 원이 투입된다.";
    const budgetEvidence = RetrievedEvidenceSchema.parse({
      evidenceId: "ev_budget2",
      sourceId: "s",
      sourceRevision: "r",
      sourceHash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      deckVersion: "deck_v1",
      manifestHash: "a".repeat(64),
      title: "Slide 9",
      content,
      quote: "q",
      anchor: "a",
      canonicalUrl: null,
      sourceDate: null,
      rights: "APPROVED",
      containsPii: false,
      authorizationVersion: "acl-v1",
    });
    expect(
      reconcileEvidence(
        {
          claim: "총 사업비는 52조 원이다.",
          evidenceIds: [budgetEvidence.evidenceId],
          facts: { numbers: ["52"], units: ["조 원"], dates: [], entities: [] },
        },
        [budgetEvidence],
      ),
    ).toEqual({ outcome: "MISMATCH", category: "UNIT", value: "조 원" });
  });
});

describe("evidence title as a fact source", () => {
  // Ingestion titles every deck chunk "Slide N" from the manifest's source index, and the
  // Console queries each slide with a label ending in "— slide N", so the model echoes that
  // ordinal into its claim. The chunk CONTENT almost never contains the ordinal, so the gate
  // rejected a slide reference the evidence itself genuinely carries — in its title.
  const content = "AI 기반 스마트 캠퍼스 에너지 환경 디지털 트윈 플랫폼 개요.";
  const titled = (title: string) =>
    RetrievedEvidenceSchema.parse({
      evidenceId: `ev_${title}`,
      sourceId: "s",
      sourceRevision: "r",
      sourceHash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      deckVersion: "deck_v1",
      manifestHash: "a".repeat(64),
      title,
      content,
      quote: "q",
      anchor: "a",
      canonicalUrl: null,
      sourceDate: null,
      rights: "APPROVED",
      containsPii: false,
      authorizationVersion: "acl-v1",
    });

  test("accepts a slide-number fact carried by the cited evidence's own title", () => {
    const slide3 = titled("Slide 3");
    expect(
      reconcileEvidence(
        {
          claim: "슬라이드 3은 AI 기반 스마트 캠퍼스 개요를 설명합니다.",
          evidenceIds: [slide3.evidenceId],
          facts: { numbers: ["3"], units: [], dates: [], entities: [] },
        },
        [slide3],
      ),
    ).toEqual({ outcome: "SUPPORTED" });
  });

  test("still rejects a slide number no cited evidence title carries", () => {
    const slide3 = titled("Slide 3");
    expect(
      reconcileEvidence(
        {
          claim: "슬라이드 4는 AI 기반 스마트 캠퍼스 개요를 설명합니다.",
          evidenceIds: [slide3.evidenceId],
          facts: { numbers: ["4"], units: [], dates: [], entities: [] },
        },
        [slide3],
      ),
    ).toEqual({ outcome: "MISMATCH", category: "NUMBER", value: "4" });
  });
});
