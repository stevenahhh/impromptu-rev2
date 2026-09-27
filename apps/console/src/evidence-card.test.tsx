import { afterEach, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { cleanup, render } = await import("@testing-library/react");

const { EvidenceCard } = await import("./evidence-card");

import { messages } from "./i18n";
import type { PrivateEvidenceCardView } from "./session-client";

afterEach(cleanup);

type PreparedCard = PrivateEvidenceCardView & Readonly<{ id: string; summary: string }>;

function internalCard(
  overrides: Partial<Extract<PreparedCard, { kind: "INTERNAL" }>> = {},
): PreparedCard {
  return {
    kind: "INTERNAL",
    rights: "APPROVED",
    evidenceId: "ev-1",
    title: "Internal card",
    sourceUrl: null,
    sourceDate: null,
    id: "slide_one:ev-1",
    summary: "Claim from internal evidence.",
    ...overrides,
  };
}

function cardText(locale: "ko" | "en") {
  const m = messages(locale);
  return {
    summary: m.evidenceSummary,
    sourceUrl: m.evidenceSourceUrl,
    sourceDate: m.evidenceSourceDate,
    internalApproved: m.evidenceInternalApproved,
    externalUnknown: m.evidenceExternalUnknown,
  };
}

function renderCard(card: PreparedCard, locale: "ko" | "en" = "ko") {
  return render(<EvidenceCard card={card} text={cardText(locale)} />);
}

test("a card with null sourceUrl and null sourceDate renders one badge, no apology rows, and no rights row", () => {
  const { container } = renderCard(internalCard());
  const badges = container.querySelectorAll("[data-evidence-badge]");
  expect(badges.length).toBe(1);
  expect(container.textContent).not.toContain("정보 없음");
  expect(container.textContent).not.toContain("unavailable");
  expect(container.textContent).not.toContain("권리 상태");
  expect(container.textContent).not.toContain("Rights status");
  // Summary row stays; only the two absence rows disappear.
  expect(container.textContent).toContain("핵심 요약");
  expect(container.querySelectorAll("dl > div").length).toBe(1);
});

test("a card with sourceUrl and a parseable sourceDate renders both rows plus summary and one badge", () => {
  const { container } = renderCard(
    internalCard({
      sourceUrl: "https://example.com/report",
      sourceDate: "2026-08-27T09:30:00.000Z",
    }),
  );
  expect(container.querySelectorAll("[data-evidence-badge]").length).toBe(1);
  const rows = container.querySelectorAll("dl > div");
  expect(rows.length).toBe(3);
  expect(container.querySelector('a[href="https://example.com/report"]')).not.toBeNull();
  expect(container.textContent).toContain("2026-08-27");
  expect(container.textContent).toContain("원문 보기");
  expect(container.textContent).toContain("기준일");
});

test("an unparseable sourceDate is treated as absent, like a null date", () => {
  const { container } = renderCard(internalCard({ sourceDate: "not-a-date" }));
  expect(container.querySelectorAll("dl > div").length).toBe(1);
  expect(container.textContent).not.toContain("기준일 정보 없음");
});

test("ko and en locale key sets stay equal", async () => {
  const ko = (await import("./locales/ko.json")).default;
  const en = (await import("./locales/en.json")).default;
  expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
});
