import { describe, expect, test } from "bun:test";
import {
  CandidateIdSchema,
  type CandidateRevision,
  candidateRevision,
  PublicationAuthoritySchema,
} from "@impromptu/contracts/private";
import {
  PresentationSessionIdSchema,
  ProjectionIdSchema,
  PublicationTombstoneSchema,
  PublishedAudienceCardSchema,
  presentationSessionEpoch,
  publicCardRevision,
} from "@impromptu/contracts/public";
import {
  applyAuthorizedPublicCardEvent,
  applyPublicCardEvent,
  type CandidateLifecycleOperation,
  type CandidateLifecycleState,
  createCandidateLifecycle,
  createPublicCardStream,
  reduceCandidateLifecycle,
  reducePlaybackCommand,
} from "@impromptu/state";
import {
  fastCheckParameters,
  playbackAuthorityFixture,
  playbackCommandFixture,
} from "@impromptu/test-harness";
import fc from "fast-check";

const propertyOptions = fastCheckParameters();
const nowMs = 1_700_000_000_000;
const hash = (character: string) => character.repeat(64);

describe("generated CAS and illegal-transition matrices", () => {
  test("covers every playback revision and relative-command transition", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10_000 }), (sequence) => {
        const ready = playbackAuthorityFixture();
        const cases = [
          {
            state: ready,
            command: playbackCommandFixture(sequence, { type: "BLACKOUT_SET", enabled: true }),
            reason: "REVISION_MISMATCH",
          },
          {
            state: ready,
            command: {
              ...playbackCommandFixture(1, { type: "SLIDE_NEXT" }),
              delivery: "OFFLINE_REPLAY" as const,
            },
            reason: "OFFLINE_RELATIVE_COMMAND",
          },
          {
            state: { ...ready, stageStatus: "DISCONNECTED" as const },
            command: playbackCommandFixture(1, { type: "SLIDE_NEXT" }),
            reason: "STAGE_NOT_READY",
          },
          {
            state: ready,
            command: playbackCommandFixture(1, { type: "SLIDE_PREVIOUS" }),
            reason: "SLIDE_BOUNDARY",
          },
          {
            state: ready,
            command: playbackCommandFixture(1, {
              type: "SLIDE_SET",
              publicSlideKey: `slide_unknown-${sequence}`,
            }),
            reason: "UNKNOWN_SLIDE",
          },
        ] as const;
        for (const matrixCase of cases) {
          const result = reducePlaybackCommand(matrixCase.state, matrixCase.command, nowMs);
          expect(result.receipt).toMatchObject({
            status: "REJECTED",
            reason: matrixCase.reason,
          });
          expect(result.state).toBe(matrixCase.state);
        }
      }),
      propertyOptions,
    );
  });

  test("covers every candidate verdict transition and CAS precedence", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (suffix) => {
        const initial = createCandidateLifecycle({
          presentationSessionId: PresentationSessionIdSchema.parse(`ps_matrix-${suffix}`),
          presentationSessionEpoch: presentationSessionEpoch(suffix),
          candidateId: CandidateIdSchema.parse(`candidate_matrix-${suffix}`),
          candidateVersion: `candidate-v${suffix}`,
          contentHash: hash("c"),
        });
        const operation = (
          state: CandidateLifecycleState,
          type: CandidateLifecycleOperation["type"],
          expectedRevision: CandidateRevision = state.candidateRevision,
        ): CandidateLifecycleOperation => {
          const identity = {
            presentationSessionId: state.presentationSessionId,
            presentationSessionEpoch: state.presentationSessionEpoch,
            candidateId: state.candidateId,
            candidateVersion: state.candidateVersion,
            expectedRevision,
          };
          return type === "PUBLISH"
            ? {
                ...identity,
                type,
                projectionId: ProjectionIdSchema.parse(`projection_matrix-${suffix}`),
                publicCardRevision: publicCardRevision(1),
              }
            : { ...identity, type };
        };
        const apply = (
          state: CandidateLifecycleState,
          type: CandidateLifecycleOperation["type"],
        ) => {
          const result = reduceCandidateLifecycle(state, operation(state, type));
          if (result.outcome !== "APPLIED") throw new Error(`failed to construct ${type} state`);
          return result.state;
        };
        const eligible = apply(initial, "QUALIFY");
        const states = [
          { state: initial, status: "PRIVATE" },
          { state: eligible, status: "ELIGIBLE" },
          { state: apply(initial, "MARK_STALE"), status: "STALE" },
          { state: apply(initial, "SUPERSEDE"), status: "SUPERSEDED" },
          { state: apply(eligible, "PUBLISH"), status: "PUBLISHED" },
        ] as const;
        const operationTypes = ["QUALIFY", "MARK_STALE", "SUPERSEDE", "PUBLISH"] as const;

        for (const entry of states) {
          for (const type of operationTypes) {
            const result = reduceCandidateLifecycle(entry.state, operation(entry.state, type));
            const legal =
              (entry.status === "PRIVATE" && type !== "PUBLISH") ||
              (entry.status === "ELIGIBLE" && type !== "QUALIFY");
            expect(result.outcome).toBe(legal ? "APPLIED" : "REJECTED");
            if (!legal && result.outcome === "REJECTED") {
              expect(result.reason).toBe(
                entry.status === "PRIVATE" || entry.status === "ELIGIBLE"
                  ? "ILLEGAL_TRANSITION"
                  : "TERMINAL_VERDICT",
              );
            }
          }
        }

        for (const entry of states.filter(
          ({ status }) => status === "PRIVATE" || status === "ELIGIBLE",
        )) {
          for (const type of operationTypes) {
            const staleRevision = candidateRevision(
              Number(entry.state.candidateRevision.slice("candrev_".length)) + 1,
            );
            expect(
              reduceCandidateLifecycle(entry.state, operation(entry.state, type, staleRevision)),
            ).toMatchObject({ outcome: "REJECTED", reason: "CAS_MISMATCH" });
          }
        }
      }),
      propertyOptions,
    );
  });

  test("covers concurrent publication, expiry, retry, and terminal linearizations", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.constantFrom("RETRACTED" as const, "EXPIRED" as const),
        fc.integer({ min: 1, max: 12 }),
        (suffix, tombstoneStatus, retryCount) => {
          const presentationSessionId = PresentationSessionIdSchema.parse(
            `ps_publication-${suffix}`,
          );
          const sessionEpoch = presentationSessionEpoch(suffix);
          const candidateInitial = createCandidateLifecycle({
            presentationSessionId,
            presentationSessionEpoch: sessionEpoch,
            candidateId: CandidateIdSchema.parse(`candidate_publication-${suffix}`),
            candidateVersion: `candidate-v${suffix}`,
            contentHash: hash("d"),
          });
          const qualified = reduceCandidateLifecycle(candidateInitial, {
            type: "QUALIFY",
            presentationSessionId,
            presentationSessionEpoch: sessionEpoch,
            candidateId: candidateInitial.candidateId,
            candidateVersion: candidateInitial.candidateVersion,
            expectedRevision: candidateRevision(0),
          });
          if (qualified.outcome !== "APPLIED") throw new Error("candidate qualification failed");
          const authority = PublicationAuthoritySchema.parse({
            authorityId: `pubauth_matrix-${suffix}`,
            presentationSessionId,
            presentationSessionEpoch: sessionEpoch,
            actorId: `actor_matrix-${suffix}`,
            policyVersion: "policy-v1",
            expiresAtMs: 1_800_000_000_000,
          });
          const initial = createPublicCardStream({
            presentationSessionId,
            presentationSessionEpoch: sessionEpoch,
            authority,
          });
          const card = (revision: number) =>
            PublishedAudienceCardSchema.parse({
              projectionId: `projection_matrix-${suffix}`,
              status: "PUBLISHED",
              claim: "claim",
              supportSummary: "support",
              sourceLabel: "source",
              publishedAtMs: nowMs,
              expiresAtMs: null,
              publicCardRevision: `pcr_${revision}`,
              deckVersion: "deck_v1",
              manifestHash: hash("a"),
              occurrence: { publicSlideKey: "slide_1", occurrenceSeq: 1 },
            });
          const terminalEvent = (revision: number, status = tombstoneStatus) =>
            PublicationTombstoneSchema.parse({
              projectionId: `projection_matrix-${suffix}`,
              status,
              publicCardRevision: `pcr_${revision}`,
              occurredAtMs: nowMs + revision,
            });
          const authorized = (
            expectedRevision: string,
            payload: ReturnType<typeof card> | ReturnType<typeof terminalEvent>,
          ) => ({
            presentationSessionId,
            presentationSessionEpoch: sessionEpoch,
            authorityId: authority.authorityId,
            expectedRevision,
            payload,
          });

          expect(
            applyAuthorizedPublicCardEvent(
              initial,
              qualified.state,
              authorized("pcr_9", card(1)),
              nowMs,
            ),
          ).toMatchObject({ outcome: "REJECTED", reason: "CAS_CONFLICT", state: initial });
          expect(
            applyAuthorizedPublicCardEvent(initial, null, authorized("pcr_0", card(1)), nowMs),
          ).toMatchObject({
            outcome: "REJECTED",
            reason: "CANDIDATE_NOT_ELIGIBLE",
            state: initial,
          });
          expect(
            applyAuthorizedPublicCardEvent(
              initial,
              qualified.state,
              authorized("pcr_0", card(2)),
              nowMs,
            ),
          ).toMatchObject({ outcome: "REJECTED", reason: "GAP_REQUIRES_SNAPSHOT", state: initial });

          expect(
            applyAuthorizedPublicCardEvent(
              initial,
              qualified.state,
              authorized("pcr_0", card(1)),
              authority.expiresAtMs,
            ),
          ).toMatchObject({ outcome: "REJECTED", reason: "AUTHORITY_EXPIRED", state: initial });

          const approve = authorized("pcr_0", card(1));
          const retract = authorized("pcr_0", terminalEvent(1));
          for (const [firstRequest, secondRequest, winningStatus] of [
            [approve, retract, "PUBLISHED"],
            [retract, approve, tombstoneStatus],
          ] as const) {
            const first = applyAuthorizedPublicCardEvent(
              initial,
              qualified.state,
              firstRequest,
              nowMs,
            );
            expect(first.outcome).toBe("APPLIED");
            const second = applyAuthorizedPublicCardEvent(
              first.state,
              qualified.state,
              secondRequest,
              nowMs,
            );
            expect(second).toMatchObject({
              outcome: "REJECTED",
              reason: "CAS_CONFLICT",
              state: first.state,
            });
            for (let retry = 0; retry < retryCount; retry += 1) {
              expect(
                applyAuthorizedPublicCardEvent(second.state, qualified.state, secondRequest, nowMs),
              ).toMatchObject({
                outcome: "REJECTED",
                reason: "CAS_CONFLICT",
                state: first.state,
              });
            }
            const winner =
              first.state.cards[`projection_matrix-${suffix}`] ??
              first.state.tombstones[`projection_matrix-${suffix}`];
            expect(winner?.status).toBe(winningStatus);
          }

          const approved = applyAuthorizedPublicCardEvent(
            initial,
            qualified.state,
            authorized("pcr_0", card(1)),
            nowMs,
          );
          expect(approved.outcome).toBe("APPLIED");
          const terminal = applyAuthorizedPublicCardEvent(
            approved.state,
            qualified.state,
            authorized("pcr_1", terminalEvent(2)),
            nowMs,
          );
          expect(terminal.outcome).toBe("APPLIED");
          for (const retryRequest of [
            authorized("pcr_0", card(1)),
            authorized("pcr_1", terminalEvent(2)),
          ]) {
            expect(
              applyAuthorizedPublicCardEvent(terminal.state, qualified.state, retryRequest, nowMs),
            ).toMatchObject({ outcome: "REJECTED", reason: "CAS_CONFLICT", state: terminal.state });
          }
          expect(
            applyAuthorizedPublicCardEvent(
              terminal.state,
              qualified.state,
              authorized("pcr_2", card(3)),
              nowMs,
            ),
          ).toMatchObject({
            outcome: "REJECTED",
            reason: "TERMINAL_PROJECTION",
            state: terminal.state,
          });
        },
      ),
      propertyOptions,
    );
  });
});
