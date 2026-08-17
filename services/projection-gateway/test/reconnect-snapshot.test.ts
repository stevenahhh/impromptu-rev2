import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { PreparedEvidenceProjectionGateway } from "../src/prepared-evidence.ts";

const deck = PublishedDeckArtifactSchema.parse({
  deckVersion: "deck_alpha",
  manifestHash: "a".repeat(64),
  title: "Pinned deck",
  slides: [
    {
      publicSlideKey: "slide_one",
      ordinal: 1,
      image: {
        url: "https://public.test/one.png",
        contentHash: "b".repeat(64),
        width: 1920,
        height: 1080,
      },
      accessibilityLabel: "One",
    },
  ],
});

function bound() {
  const gateway = new PreparedEvidenceProjectionGateway();
  const join = gateway.createDisplayJoin(
    {
      displayId: "display_alpha",
      displayFingerprint: "stage-fingerprint-alpha",
      deckVersion: deck.deckVersion,
    },
    1_000,
  );
  const result = gateway.bindDisplay(
    {
      displayJoinId: join.displayJoinId,
      presentationSessionId: "ps_alpha",
      presentationSessionEpoch: "pse_1",
      expectedDisplayBindingEpoch: "dbe_0",
      expectedDeckVersion: deck.deckVersion,
      approvedDisplayId: join.displayId,
      approvedDisplayFingerprint: join.displayFingerprint,
      deck,
    },
    1_001,
  );
  if (result.outcome !== "BOUND") throw new Error("binding failed");
  return { gateway, session: result.session };
}

describe("role-scoped pinned reconnect snapshot", () => {
  test("returns an absolute state hash only for the bound public identity", () => {
    const { gateway, session } = bound();
    const pins = {
      role: "PUBLIC_STAGE" as const,
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      deckVersion: deck.deckVersion,
      manifestHash: deck.manifestHash,
    };
    const first = gateway.reconcileSnapshot(session.audienceDisplaySessionId, pins, 1_002);
    const second = gateway.reconcileSnapshot(session.audienceDisplaySessionId, pins, 1_002);
    expect(first).toEqual(second);
    expect(first.outcome).toBe("SNAPSHOT");
    if (first.outcome !== "SNAPSHOT") throw new Error("snapshot missing");
    expect(first.snapshot.role).toBe("PUBLIC_STAGE");
    expect(first.snapshot.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.snapshot.occurrence).toEqual({ publicSlideKey: "slide_one", occurrenceSeq: 1 });
  });

  test("requires reconcile on role, binding, deck, manifest, or prior hash mismatch", () => {
    const { gateway, session } = bound();
    const valid = {
      role: "PUBLIC_STAGE" as const,
      presentationSessionEpoch: "pse_1",
      displayBindingEpoch: "dbe_1",
      deckVersion: deck.deckVersion,
      manifestHash: deck.manifestHash,
    };
    for (const pins of [
      { ...valid, role: "CONTROLLER" as const },
      { ...valid, displayBindingEpoch: "dbe_0" },
      { ...valid, deckVersion: "deck_other" },
      { ...valid, manifestHash: "c".repeat(64) },
      { ...valid, stateHash: "d".repeat(64) },
    ]) {
      expect(gateway.reconcileSnapshot(session.audienceDisplaySessionId, pins, 1_002)).toEqual({
        outcome: "RECONCILE_REQUIRED",
      });
    }
  });
});
