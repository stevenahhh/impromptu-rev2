import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { authorizeRoleAction, PlaybackCommandSchema } from "@impromptu/contracts/control";
import {
  authorizeRoleSnapshot,
  EvidenceCandidateSchema,
  PrivateDeckContextSchema,
  RoleSessionSchema,
} from "@impromptu/contracts/private";
import {
  AudienceSnapshotSchema,
  BuildHandshakeSchema,
  checkHandshakeCompatibility,
  PublicationTombstoneSchema,
  PublishedAudienceCardSchema,
  PublishedDeckArtifactSchema,
} from "@impromptu/contracts/public";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`tests/contract/fixtures/${name}.json`, "utf8"));
}

describe("protocol contract fixtures", () => {
  test("parse private and deliberately declassified deck contracts", () => {
    expect(PrivateDeckContextSchema.parse(fixture("private-deck"))).toBeDefined();
    expect(PublishedDeckArtifactSchema.parse(fixture("published-deck"))).toBeDefined();
  });

  test("parse every role session and playback command fixture", () => {
    const sessions = fixture("role-sessions");
    expect(Array.isArray(sessions)).toBe(true);
    if (!Array.isArray(sessions)) throw new Error("role-sessions fixture must be an array");
    for (const session of sessions) RoleSessionSchema.parse(session);

    const commands = fixture("playback-commands");
    expect(Array.isArray(commands)).toBe(true);
    if (!Array.isArray(commands)) throw new Error("playback-commands fixture must be an array");
    for (const command of commands) PlaybackCommandSchema.parse(command);
  });

  test("parse evidence causal envelopes, published cards, tombstones, and audience snapshots", () => {
    EvidenceCandidateSchema.parse(fixture("evidence-candidate"));
    const card = PublishedAudienceCardSchema.parse(fixture("published-card"));
    PublicationTombstoneSchema.parse(fixture("publication-tombstone"));
    AudienceSnapshotSchema.parse({
      role: "PUBLIC_STAGE",
      presentationSessionId: "session-1",
      presentationSessionEpoch: 3,
      displayBindingEpoch: 4,
      publicPlaybackRevision: 11,
      publicCardRevision: 8,
      deck: fixture("published-deck"),
      occurrence: { publicSlideKey: "public-slide-1", occurrenceSeq: 2 },
      blackout: false,
      cards: [card],
      tombstones: [fixture("publication-tombstone")],
      tombstoneWatermark: 5,
    });
  });
});

describe("closed public contracts", () => {
  test("reject unknown fields at every public object boundary", () => {
    const deck = fixture("published-deck") as Record<string, unknown>;
    expect(PublishedDeckArtifactSchema.safeParse({ ...deck, privateNotes: "secret" }).success).toBe(
      false,
    );

    const slides = deck.slides;
    if (!Array.isArray(slides) || typeof slides[0] !== "object" || slides[0] === null) {
      throw new Error("published-deck fixture must contain a slide");
    }
    const firstSlide = slides[0] as Record<string, unknown>;
    expect(
      PublishedDeckArtifactSchema.safeParse({
        ...deck,
        slides: [{ ...firstSlide, extractedText: "private corpus text" }],
      }).success,
    ).toBe(false);

    const card = fixture("published-card") as Record<string, unknown>;
    expect(
      PublishedAudienceCardSchema.safeParse({ ...card, candidateId: "private-candidate-1" })
        .success,
    ).toBe(false);

    const tombstone = fixture("publication-tombstone") as Record<string, unknown>;
    expect(
      PublicationTombstoneSchema.safeParse({ ...tombstone, reasonDetail: "private moderation" })
        .success,
    ).toBe(false);
  });

  test("does not accept a private deck as a published artifact", () => {
    expect(PublishedDeckArtifactSchema.safeParse(fixture("private-deck")).success).toBe(false);
  });

  test("requires transcript identity only for live verified evidence", () => {
    const curated = EvidenceCandidateSchema.parse(fixture("evidence-candidate"));
    expect(
      EvidenceCandidateSchema.safeParse({ ...curated, provenance: "LIVE_VERIFIED" }).success,
    ).toBe(false);
    expect(
      EvidenceCandidateSchema.safeParse({
        ...curated,
        provenance: "LIVE_VERIFIED",
        causal: { ...curated.causal, transcriptFinalId: "transcript-final-1" },
      }).success,
    ).toBe(true);
  });
});

describe("build handshake", () => {
  test("requires overlapping protocol ranges and an allowed release", () => {
    const client = BuildHandshakeSchema.parse({
      releaseId: "pilot-2026-08",
      protocolRange: { min: 2, max: 4 },
      buildId: "console-a1",
    });
    const server = BuildHandshakeSchema.parse({
      releaseId: "pilot-2026-08",
      protocolRange: { min: 4, max: 6 },
      buildId: "authority-b1",
    });

    expect(checkHandshakeCompatibility(client, server)).toEqual({
      compatible: true,
      protocolVersion: 4,
    });
    expect(
      checkHandshakeCompatibility(client, {
        ...server,
        protocolRange: { min: 5, max: 6 },
      }),
    ).toEqual({ compatible: false, reason: "PROTOCOL_RANGE_MISMATCH" });
    expect(checkHandshakeCompatibility(client, { ...server, releaseId: "pilot-2026-09" })).toEqual({
      compatible: false,
      reason: "RELEASE_MISMATCH",
    });
  });

  test("rejects malformed and open handshake payloads", () => {
    expect(
      BuildHandshakeSchema.safeParse({
        releaseId: "pilot",
        protocolRange: { min: 3, max: 2 },
        buildId: "build",
      }).success,
    ).toBe(false);
    expect(
      BuildHandshakeSchema.safeParse({
        releaseId: "pilot",
        protocolRange: { min: 2, max: 3 },
        buildId: "build",
        debug: true,
      }).success,
    ).toBe(false);
  });
});

describe("role topic authorization", () => {
  test("is default-deny for role, topic, read, and write combinations", () => {
    expect(authorizeRoleAction("CONTROLLER", "PRESENTER_CONTROL", "READ")).toBe(true);
    expect(authorizeRoleAction("CONTROLLER", "PRESENTER_CONTROL", "WRITE")).toBe(true);
    expect(authorizeRoleAction("PUBLIC_STAGE", "PUBLIC_PLAYBACK", "READ")).toBe(true);
    expect(authorizeRoleAction("PUBLIC_STAGE", "DISPLAY_RECEIPTS", "WRITE")).toBe(true);
    expect(authorizeRoleAction("PUBLISHER", "PUBLIC_CARDS", "WRITE")).toBe(true);

    expect(authorizeRoleAction("PUBLIC_STAGE", "PRESENTER_CONTROL", "READ")).toBe(false);
    expect(authorizeRoleAction("PUBLIC_STAGE", "PRIVATE_CANDIDATES", "READ")).toBe(false);
    expect(authorizeRoleAction("PUBLIC_STAGE", "PUBLIC_PLAYBACK", "WRITE")).toBe(false);
    expect(authorizeRoleAction("CONTROLLER", "PRIVATE_CANDIDATES", "WRITE")).toBe(false);
    expect(authorizeRoleAction("PUBLISHER", "PRESENTER_CONTROL", "WRITE")).toBe(false);
  });

  test("does not disclose a role-scoped snapshot to another role", () => {
    const audienceSnapshot = {
      role: "PUBLIC_STAGE",
      presentationSessionId: "session-1",
      presentationSessionEpoch: 3,
      displayBindingEpoch: 4,
      publicPlaybackRevision: 11,
      publicCardRevision: 8,
      deck: fixture("published-deck"),
      occurrence: { publicSlideKey: "public-slide-1", occurrenceSeq: 2 },
      blackout: false,
      cards: [fixture("published-card")],
      tombstones: [fixture("publication-tombstone")],
      tombstoneWatermark: 5,
    };
    expect(authorizeRoleSnapshot("PUBLIC_STAGE", audienceSnapshot)).toBe(true);
    expect(authorizeRoleSnapshot("CONTROLLER", audienceSnapshot)).toBe(false);
    expect(authorizeRoleSnapshot("UNKNOWN_ROLE", audienceSnapshot)).toBe(false);
    expect(
      authorizeRoleSnapshot("PUBLIC_STAGE", { ...audienceSnapshot, privateNotes: "secret" }),
    ).toBe(false);
  });
});
