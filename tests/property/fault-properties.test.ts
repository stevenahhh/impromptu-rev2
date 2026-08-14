import { describe, expect, test } from "bun:test";
import {
  authorizeRoleAction,
  type PlaybackCommand,
  PlaybackControlLeaseSchema,
} from "@impromptu/contracts/control";
import {
  DeckVersionIdSchema,
  displayBindingEpoch,
  PresentationSessionIdSchema,
  PublicSlideKeySchema,
  PublishedAudienceCardSchema,
  presentationSessionEpoch,
  publicPlaybackRevision,
} from "@impromptu/contracts/public";
import { initialPublicPlaybackState, type PublicPlaybackEvent } from "@impromptu/state";
import {
  fastCheckParameters,
  type PlaybackFaultAction,
  type PlaybackIntent,
  type PublicProjectionFaultAction,
  playbackAuthorityFixture,
  playbackCommandFixture,
  runPlaybackFaultSchedule,
  runPublicProjectionFaultSchedule,
} from "@impromptu/test-harness";
import fc from "fast-check";

const propertyOptions = fastCheckParameters();
const manifestHash = "a".repeat(64);

const intentArbitrary: fc.Arbitrary<PlaybackIntent> = fc.oneof(
  fc.record({
    type: fc.constant("SLIDE_SET" as const),
    publicSlideKey: fc.constantFrom("slide_1", "slide_2", "slide_3"),
  }),
  fc.record({ type: fc.constant("BLACKOUT_SET" as const), enabled: fc.boolean() }),
);

function commandActions(
  commands: readonly PlaybackCommand[],
  restarts: readonly boolean[],
): PlaybackFaultAction[] {
  return commands.flatMap((command, index) => {
    const actions: PlaybackFaultAction[] = [{ type: "COMMAND", command }];
    if (restarts[index] === true) actions.push({ type: "RESTART" });
    return actions;
  });
}

describe("generated playback fault schedules", () => {
  test("duplicates and restarts preserve the same terminal authority state", () => {
    fc.assert(
      fc.property(
        fc.array(intentArbitrary, { minLength: 1, maxLength: 30 }),
        fc.array(fc.nat(), { maxLength: 60 }),
        fc.array(fc.boolean(), { maxLength: 30 }),
        (intents, duplicateSelectors, restarts) => {
          const commands = intents.map((intent, index) =>
            playbackCommandFixture(index + 1, intent),
          );
          const uniqueSchedule = commandActions(commands, restarts);
          const faultSchedule: PlaybackFaultAction[] = [
            ...uniqueSchedule,
            ...duplicateSelectors.map((selector) => ({
              type: "COMMAND" as const,
              command: commands[selector % commands.length] as PlaybackCommand,
            })),
            ...commands.map((command) => ({
              type: "STAGE_APPLY" as const,
              commandId: command.commandId,
              displayBindingEpoch: displayBindingEpoch(1),
            })),
          ];
          const expected = runPlaybackFaultSchedule(playbackAuthorityFixture(), [
            ...uniqueSchedule,
            ...commands.map((command) => ({
              type: "STAGE_APPLY" as const,
              commandId: command.commandId,
              displayBindingEpoch: displayBindingEpoch(1),
            })),
          ]);
          const first = runPlaybackFaultSchedule(playbackAuthorityFixture(), faultSchedule);
          const replay = runPlaybackFaultSchedule(playbackAuthorityFixture(), faultSchedule);

          expect(first).toEqual(replay);
          expect(first.state).toEqual(expected.state);
          expect(String(first.state.controlRevision)).toBe(`cr_${commands.length}`);
          expect(String(first.state.publicPlaybackRevision)).toBe(`pbr_${commands.length}`);
        },
      ),
      propertyOptions,
    );
  });

  test("takeovers terminalize every old pending interleaving across restart", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.nat(),
        fc.integer({ min: 2, max: 1_000 }),
        (acceptedCount, prefixSelector, nextEpoch) => {
          const appliedPrefix = prefixSelector % (acceptedCount + 1);
          const commands = Array.from({ length: acceptedCount }, (_, index) =>
            playbackCommandFixture(index + 1, {
              type: "BLACKOUT_SET",
              enabled: index % 2 === 0,
            }),
          );
          const replacement = PlaybackControlLeaseSchema.parse({
            ...playbackAuthorityFixture().activeLease,
            leaseId: `lease_takeover-${nextEpoch}`,
            actorId: `actor_takeover-${nextEpoch}`,
            controllerEpoch: `ce_${nextEpoch}`,
          });
          const replacementCommand: PlaybackCommand = {
            ...playbackCommandFixture(acceptedCount + 1, {
              type: "BLACKOUT_SET",
              enabled: true,
            }),
            actorId: replacement.actorId,
            leaseId: replacement.leaseId,
            controllerEpoch: replacement.controllerEpoch,
          };
          const result = runPlaybackFaultSchedule(playbackAuthorityFixture(), [
            ...commands.map((command) => ({ type: "COMMAND" as const, command })),
            ...commands.slice(0, appliedPrefix).map((command) => ({
              type: "STAGE_APPLY" as const,
              commandId: command.commandId,
              displayBindingEpoch: displayBindingEpoch(1),
            })),
            { type: "TAKEOVER", lease: replacement },
            { type: "RESTART" },
            { type: "COMMAND", command: replacementCommand },
            {
              type: "STAGE_APPLY",
              commandId: replacementCommand.commandId,
              displayBindingEpoch: displayBindingEpoch(1),
            },
            { type: "RESTART" },
          ]);

          const oldRecords = Object.values(result.state.acceptedCommands).filter(
            ({ receipt }) => receipt.leaseId !== replacement.leaseId,
          );
          expect(
            oldRecords
              .slice(0, appliedPrefix)
              .every(({ appliedReceipt }) => appliedReceipt !== null),
          ).toBe(true);
          expect(
            oldRecords
              .slice(appliedPrefix)
              .every(({ supersededReceipt }) => supersededReceipt?.status === "SUPERSEDED"),
          ).toBe(true);
          expect(String(result.state.publicPlaybackRevision)).toBe(`pbr_${appliedPrefix + 1}`);
          expect(result.trace.at(-2)).toMatchObject({ type: "STAGE_APPLY", outcome: "APPLIED" });
        },
      ),
      propertyOptions,
    );
  });

  test("old-lease duplicates remain rejected after generated takeovers", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 1_000 }), (nextEpoch) => {
        const initial = playbackAuthorityFixture();
        const original = playbackCommandFixture(1, {
          type: "BLACKOUT_SET",
          enabled: true,
        });
        const replacement = PlaybackControlLeaseSchema.parse({
          ...initial.activeLease,
          leaseId: `lease_takeover-${nextEpoch}`,
          controllerEpoch: `ce_${nextEpoch}`,
        });
        const result = runPlaybackFaultSchedule(initial, [
          { type: "COMMAND", command: original },
          { type: "TAKEOVER", lease: replacement },
          { type: "COMMAND", command: original },
        ]);
        const finalTrace = result.trace.at(-1);
        expect(finalTrace).toMatchObject({
          type: "COMMAND",
          receipt: { status: "REJECTED", reason: "STALE_LEASE" },
        });
        expect(String(result.state.controlRevision)).toBe("cr_1");
      }),
      propertyOptions,
    );
  });
});

function publicEvent(revision: number): PublicPlaybackEvent {
  return {
    presentationSessionId: PresentationSessionIdSchema.parse("ps_public"),
    presentationSessionEpoch: presentationSessionEpoch(1),
    displayBindingEpoch: displayBindingEpoch(1),
    deckVersion: DeckVersionIdSchema.parse("deck_v1"),
    manifestHash,
    publicPlaybackRevision: publicPlaybackRevision(revision),
    occurrence: {
      publicSlideKey: PublicSlideKeySchema.parse(`slide_${(revision % 3) + 1}`),
      occurrenceSeq: revision + 1,
    },
    blackout: revision % 2 === 0,
  };
}

describe("generated public projection schedules", () => {
  test("reorder, duplicate, gap, partition, and restart converge through a current snapshot", () => {
    const events = Array.from({ length: 8 }, (_, index) => publicEvent(index + 1));
    const initial = initialPublicPlaybackState({
      ...publicEvent(0),
      occurrence: { publicSlideKey: PublicSlideKeySchema.parse("slide_1"), occurrenceSeq: 1 },
    });
    const authoritative = publicEvent(events.length);
    const descriptorArbitrary = fc.oneof(
      fc.record({ type: fc.constant("EVENT" as const), index: fc.integer({ min: 0, max: 7 }) }),
      fc.record({ type: fc.constant("PARTITION" as const), active: fc.boolean() }),
      fc.record({ type: fc.constant("RESTART" as const) }),
    );

    fc.assert(
      fc.property(fc.array(descriptorArbitrary, { maxLength: 80 }), (descriptors) => {
        const actions: PublicProjectionFaultAction[] = descriptors.map((descriptor) => {
          if (descriptor.type === "EVENT") {
            return { type: "EVENT", event: events[descriptor.index] as PublicPlaybackEvent };
          }
          return descriptor;
        });
        actions.push({ type: "PARTITION", active: false });
        actions.push({ type: "SNAPSHOT", snapshot: authoritative });

        const first = runPublicProjectionFaultSchedule(initial, actions);
        const replay = runPublicProjectionFaultSchedule(initial, actions);
        expect(first).toEqual(replay);
        expect(first.state).toEqual(authoritative);
      }),
      propertyOptions,
    );
  });

  test("does not queue partitioned events for later relative replay", () => {
    const initial = initialPublicPlaybackState({
      ...publicEvent(0),
      occurrence: { publicSlideKey: PublicSlideKeySchema.parse("slide_1"), occurrenceSeq: 1 },
    });
    const result = runPublicProjectionFaultSchedule(initial, [
      { type: "PARTITION", active: true },
      { type: "EVENT", event: publicEvent(1) },
      { type: "PARTITION", active: false },
    ]);
    expect(result.state).toEqual(initial);
    expect(result.trace[1]).toEqual({ type: "EVENT", outcome: "DROPPED_BY_PARTITION" });
  });
});

describe("generated security contracts", () => {
  test("keeps role/topic/action authorization closed by default", () => {
    const allowed = new Set([
      "CONTROLLER:PRESENTER_CONTROL:READ",
      "CONTROLLER:PRESENTER_CONTROL:WRITE",
      "CONTROLLER:PRIVATE_CANDIDATES:READ",
      "CONTROLLER:DISPLAY_RECEIPTS:READ",
      "PUBLISHER:PRIVATE_CANDIDATES:READ",
      "PUBLISHER:PRIVATE_CANDIDATES:WRITE",
      "PUBLISHER:PUBLIC_CARDS:READ",
      "PUBLISHER:PUBLIC_CARDS:WRITE",
      "PUBLIC_STAGE:PUBLIC_PLAYBACK:READ",
      "PUBLIC_STAGE:PUBLIC_CARDS:READ",
      "PUBLIC_STAGE:DISPLAY_RECEIPTS:WRITE",
    ]);
    fc.assert(
      fc.property(
        fc.constantFrom("CONTROLLER", "PUBLIC_STAGE", "PUBLISHER", "UNKNOWN_ROLE"),
        fc.constantFrom(
          "PRESENTER_CONTROL",
          "PRIVATE_CANDIDATES",
          "PUBLIC_PLAYBACK",
          "PUBLIC_CARDS",
          "DISPLAY_RECEIPTS",
          "UNKNOWN_TOPIC",
        ),
        fc.constantFrom("READ", "WRITE", "DELETE"),
        (role, topic, action) => {
          expect(authorizeRoleAction(role, topic, action)).toBe(
            allowed.has(`${role}:${topic}:${action}`),
          );
        },
      ),
      propertyOptions,
    );
  });

  test("rejects every generated unknown public card field", () => {
    const knownFields = new Set([
      "projectionId",
      "status",
      "claim",
      "supportSummary",
      "sourceLabel",
      "publishedAtMs",
      "expiresAtMs",
      "publicCardRevision",
      "deckVersion",
      "manifestHash",
      "occurrence",
    ]);
    const unknownField = fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((field) => !knownFields.has(field));
    const card = {
      projectionId: "projection_1",
      status: "PUBLISHED",
      claim: "A declassified claim",
      supportSummary: "A declassified summary",
      sourceLabel: "Approved source",
      publishedAtMs: 1,
      expiresAtMs: null,
      publicCardRevision: "pcr_1",
      deckVersion: "deck_v1",
      manifestHash,
      occurrence: { publicSlideKey: PublicSlideKeySchema.parse("slide_1"), occurrenceSeq: 1 },
    };
    fc.assert(
      fc.property(unknownField, fc.jsonValue(), (field, value) => {
        expect(PublishedAudienceCardSchema.safeParse({ ...card, [field]: value }).success).toBe(
          false,
        );
      }),
      propertyOptions,
    );
  });
});
