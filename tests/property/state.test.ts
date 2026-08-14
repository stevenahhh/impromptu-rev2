import { describe, expect, test } from "bun:test";
import {
  controlRevision,
  type PlaybackCommand,
  PlaybackCommandSchema,
  PlaybackControlLeaseSchema,
} from "@impromptu/contracts/control";
import {
  AudienceSnapshotSchema,
  DeckVersionIdSchema,
  displayBindingEpoch,
  PresentationSessionIdSchema,
  PublicSlideKeySchema,
  presentationSessionEpoch,
  publicPlaybackRevision,
} from "@impromptu/contracts/public";
import {
  applyAudiencePlaybackSnapshot,
  applyPublicPlaybackEvent,
  applyPublicPlaybackSnapshot,
  canonicalPlaybackRequestHash,
  createPlaybackAuthorityState,
  initialPublicPlaybackState,
  markStageApplied,
  type PublicPlaybackEvent,
  reducePlaybackCommand,
  replacePlaybackLease,
  restorePlaybackAuthority,
  rotatePlaybackDisplayBinding,
  setPlaybackStageStatus,
  snapshotPlaybackAuthority,
} from "@impromptu/state";

const hash = (digit: string): string => digit.repeat(64);
const nowMs = 1_700_000_000_000;

interface CommandOverrides {
  type: PlaybackCommand["type"];
  actorId?: string;
  leaseId?: string;
  presentationSessionEpoch?: string;
  controllerEpoch?: string;
  commandId?: string;
  baseRevision?: number;
  delivery?: "LIVE" | "OFFLINE_REPLAY";
  displayBindingEpoch?: number;
  publicSlideKey?: string;
  enabled?: boolean;
}

function command(overrides: CommandOverrides): PlaybackCommand {
  const base = {
    presentationSessionId: "ps_session-1",
    presentationSessionEpoch: overrides.presentationSessionEpoch ?? "pse_3",
    actorId: overrides.actorId ?? "actor_controller-1",
    leaseId: overrides.leaseId ?? "lease_primary",
    controllerEpoch: overrides.controllerEpoch ?? "ce_7",
    commandId: overrides.commandId ?? "cmd_1",
    baseRevision: `cr_${overrides.baseRevision ?? 0}`,
    delivery: overrides.delivery ?? "LIVE",
    displayBindingEpoch: `dbe_${overrides.displayBindingEpoch ?? 2}`,
  };
  if (overrides.type === "SLIDE_SET") {
    return PlaybackCommandSchema.parse({
      ...base,
      type: overrides.type,
      publicSlideKey: overrides.publicSlideKey ?? "slide_2",
    });
  }
  if (overrides.type === "BLACKOUT_SET") {
    return PlaybackCommandSchema.parse({
      ...base,
      type: overrides.type,
      enabled: overrides.enabled ?? true,
    });
  }
  return PlaybackCommandSchema.parse({ ...base, type: overrides.type });
}

function authority(stageStatus: "READY" | "DISCONNECTED" | "UNBOUND" = "READY", bindingEpoch = 2) {
  const presentationSessionId = PresentationSessionIdSchema.parse("ps_session-1");
  const sessionEpoch = presentationSessionEpoch(3);
  return createPlaybackAuthorityState({
    presentationSessionId,
    presentationSessionEpoch: sessionEpoch,
    activeLease: PlaybackControlLeaseSchema.parse({
      leaseId: "lease_primary",
      presentationSessionId,
      presentationSessionEpoch: sessionEpoch,
      actorId: "actor_controller-1",
      controllerEpoch: "ce_7",
      expiresAtMs: 1_800_000_000_000,
    }),
    displayBindingEpoch: displayBindingEpoch(bindingEpoch),
    stageStatus,
    slideOrder: ["slide_1", "slide_2", "slide_3"].map((key) => PublicSlideKeySchema.parse(key)),
    initialSlideKey: PublicSlideKeySchema.parse("slide_1"),
  });
}

describe("playback authority reducer", () => {
  test("deduplicates canonical requests and rejects changed payload under a reused command ID", () => {
    const first = reducePlaybackCommand(
      authority(),
      command({ type: "SLIDE_SET", publicSlideKey: "slide_2" }),
      nowMs,
    );
    expect(first.receipt).toMatchObject({ status: "ACCEPTED", acceptedControlRevision: "cr_1" });
    expect({
      ...first.state.occurrence,
      publicSlideKey: String(first.state.occurrence.publicSlideKey),
    }).toEqual({
      publicSlideKey: "slide_2",
      occurrenceSeq: 2,
    });

    const duplicate = reducePlaybackCommand(
      first.state,
      command({ type: "SLIDE_SET", publicSlideKey: "slide_2" }),
      nowMs,
    );
    expect(duplicate.receipt).toEqual(first.receipt);
    expect(duplicate.state).toEqual(first.state);

    const conflict = reducePlaybackCommand(
      first.state,
      command({ type: "SLIDE_SET", publicSlideKey: "slide_3" }),
      nowMs,
    );
    expect(conflict.receipt).toMatchObject({
      status: "REJECTED",
      reason: "IDEMPOTENCY_CONFLICT",
    });
    expect(conflict.state).toEqual(first.state);
  });

  test("validates authorization, session, lease expiry, and epoch before dedupe", () => {
    const first = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }), nowMs);
    const replacement = PlaybackControlLeaseSchema.parse({
      ...first.state.activeLease,
      leaseId: "lease_replacement",
      actorId: "actor_controller-2",
      controllerEpoch: "ce_8",
    });
    const afterTakeover = replacePlaybackLease(first.state, replacement);

    expect(
      reducePlaybackCommand(afterTakeover, command({ type: "SLIDE_NEXT" }), nowMs).receipt,
    ).toMatchObject({ status: "REJECTED", reason: "UNAUTHORIZED" });
    expect(
      reducePlaybackCommand(
        first.state,
        command({ type: "SLIDE_NEXT", presentationSessionEpoch: "pse_2" }),
        nowMs,
      ).receipt,
    ).toMatchObject({ status: "REJECTED", reason: "STALE_SESSION_EPOCH" });
    expect(
      reducePlaybackCommand(
        first.state,
        command({ type: "SLIDE_NEXT", leaseId: "lease_old" }),
        nowMs,
      ).receipt,
    ).toMatchObject({ status: "REJECTED", reason: "STALE_LEASE" });
    expect(
      reducePlaybackCommand(first.state, command({ type: "SLIDE_NEXT" }), 1_800_000_000_000)
        .receipt,
    ).toMatchObject({ status: "REJECTED", reason: "LEASE_EXPIRED" });
    expect(
      reducePlaybackCommand(
        first.state,
        command({ type: "SLIDE_NEXT", controllerEpoch: "ce_6" }),
        nowMs,
      ).receipt,
    ).toMatchObject({ status: "REJECTED", reason: "STALE_CONTROLLER_EPOCH" });
  });

  test("rejects forged persisted dedupe keys, identities, and revision gaps", () => {
    const accepted = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }), nowMs);
    const snapshot = snapshotPlaybackAuthority(accepted.state);
    const entry = Object.entries(snapshot.acceptedCommands)[0];
    if (entry === undefined) throw new Error("accepted command was not persisted");
    const [key, record] = entry;

    expect(
      restorePlaybackAuthority({
        ...snapshot,
        acceptedCommands: { forged: record },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePlaybackAuthority({
        ...snapshot,
        acceptedCommands: {
          [key]: {
            ...record,
            receipt: { ...record.receipt, actorId: "actor_forged" },
          },
        },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePlaybackAuthority({
        ...snapshot,
        acceptedCommands: {
          [key]: {
            ...record,
            command: { ...record.command, type: "SLIDE_PREVIOUS" },
          },
        },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    const offlineCommand = { ...record.command, delivery: "OFFLINE_REPLAY" as const };
    const offlineHash = canonicalPlaybackRequestHash(offlineCommand);
    expect(
      restorePlaybackAuthority({
        ...snapshot,
        acceptedCommands: {
          [key]: {
            ...record,
            command: offlineCommand,
            requestHash: offlineHash,
            receipt: { ...record.receipt, requestHash: offlineHash },
          },
        },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePlaybackAuthority({
        ...snapshot,
        controlRevision: "cr_2",
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });

    const second = reducePlaybackCommand(
      accepted.state,
      command({ type: "BLACKOUT_SET", commandId: "cmd_2", baseRevision: 1 }),
      nowMs,
    );
    const duplicateRevision = structuredClone(snapshotPlaybackAuthority(second.state));
    const secondEntry = Object.entries(duplicateRevision.acceptedCommands).find(
      ([entryKey]) => entryKey !== key,
    );
    if (secondEntry === undefined) throw new Error("second accepted command was not persisted");
    const [secondKey, secondRecord] = secondEntry;
    expect(
      restorePlaybackAuthority({
        ...duplicateRevision,
        acceptedCommands: {
          ...duplicateRevision.acceptedCommands,
          [secondKey]: {
            ...secondRecord,
            receipt: { ...secondRecord.receipt, acceptedControlRevision: controlRevision(1) },
            effect: { ...secondRecord.effect, acceptedControlRevision: controlRevision(1) },
          },
        },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
  });

  test("restores acceptance-time readiness after Stage disconnects", () => {
    const accepted = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }), nowMs);
    const disconnected = setPlaybackStageStatus(accepted.state, "DISCONNECTED");
    expect(restorePlaybackAuthority(snapshotPlaybackAuthority(disconnected))).toEqual({
      outcome: "RESTORED",
      state: disconnected,
    });
    const snapshot = snapshotPlaybackAuthority(disconnected);
    const entry = Object.entries(snapshot.acceptedCommands)[0];
    if (entry === undefined) throw new Error("accepted command was not persisted");
    expect(
      restorePlaybackAuthority({
        ...snapshot,
        acceptedCommands: {
          [entry[0]]: {
            ...entry[1],
            acceptanceContext: {
              ...entry[1].acceptanceContext,
              stageStatus: "DISCONNECTED",
            },
          },
        },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
  });

  test("persists acceptance and application binding epochs across rotation", () => {
    const atBindingOne = authority("READY", 1);
    const acceptedOne = reducePlaybackCommand(
      atBindingOne,
      command({ type: "SLIDE_NEXT", displayBindingEpoch: 1 }),
      nowMs,
    );
    const appliedOne = markStageApplied(
      acceptedOne.state,
      command({ type: "SLIDE_NEXT", displayBindingEpoch: 1 }).commandId,
      displayBindingEpoch(1),
    );
    const atBindingTwo = rotatePlaybackDisplayBinding(appliedOne.state, displayBindingEpoch(2));
    const acceptedTwo = reducePlaybackCommand(
      atBindingTwo,
      command({
        type: "BLACKOUT_SET",
        commandId: "cmd_2",
        baseRevision: 1,
        displayBindingEpoch: 2,
      }),
      nowMs,
    );
    const appliedTwo = markStageApplied(
      acceptedTwo.state,
      command({ type: "BLACKOUT_SET", commandId: "cmd_2", displayBindingEpoch: 2 }).commandId,
      displayBindingEpoch(2),
    );
    expect(appliedTwo.outcome).toBe("APPLIED");
    expect(restorePlaybackAuthority(snapshotPlaybackAuthority(appliedTwo.state))).toEqual({
      outcome: "RESTORED",
      state: appliedTwo.state,
    });
    expect(
      reducePlaybackCommand(
        atBindingTwo,
        command({ type: "BLACKOUT_SET", displayBindingEpoch: 1 }),
        nowMs,
      ).receipt,
    ).toMatchObject({ status: "REJECTED", reason: "STALE_DISPLAY_BINDING" });
  });

  test("rejects a forged active lease change that leaves an old command pending", () => {
    const accepted = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }), nowMs);
    const replacement = PlaybackControlLeaseSchema.parse({
      ...accepted.state.activeLease,
      leaseId: "lease_replacement",
      actorId: "actor_controller-2",
      controllerEpoch: "ce_8",
    });
    expect(
      restorePlaybackAuthority({
        ...snapshotPlaybackAuthority(accepted.state),
        activeLease: replacement,
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
  });

  test("repeating the same takeover is an idempotent no-op for its pending commands", () => {
    const acceptedOld = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }), nowMs);
    const replacement = PlaybackControlLeaseSchema.parse({
      ...acceptedOld.state.activeLease,
      leaseId: "lease_replacement",
      actorId: "actor_controller-2",
      controllerEpoch: "ce_8",
    });
    const takenOver = replacePlaybackLease(acceptedOld.state, replacement);
    const acceptedNew = reducePlaybackCommand(
      takenOver,
      command({
        type: "BLACKOUT_SET",
        actorId: "actor_controller-2",
        leaseId: "lease_replacement",
        controllerEpoch: "ce_8",
        commandId: "cmd_2",
        baseRevision: 1,
      }),
      nowMs,
    );
    const repeated = replacePlaybackLease(acceptedNew.state, replacement);
    expect(repeated).toBe(acceptedNew.state);
    const newRecord = Object.values(repeated.acceptedCommands).find(
      ({ receipt }) => receipt.leaseId === replacement.leaseId,
    );
    expect(newRecord?.supersededReceipt).toBeNull();
    expect(restorePlaybackAuthority(snapshotPlaybackAuthority(repeated))).toEqual({
      outcome: "RESTORED",
      state: repeated,
    });
  });

  test("supersedes old pending commands during lease takeover without blocking the new lease", () => {
    const acceptedOld = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }), nowMs);
    const replacement = PlaybackControlLeaseSchema.parse({
      ...acceptedOld.state.activeLease,
      leaseId: "lease_replacement",
      actorId: "actor_controller-2",
      controllerEpoch: "ce_8",
    });
    const takenOver = replacePlaybackLease(acceptedOld.state, replacement);
    const oldRecord = Object.values(takenOver.acceptedCommands)[0];
    expect(oldRecord?.supersededReceipt).toMatchObject({
      status: "SUPERSEDED",
      supersededByLeaseId: "lease_replacement",
      supersededByControllerEpoch: "ce_8",
    });
    const oldEntry = Object.entries(takenOver.acceptedCommands)[0];
    if (oldEntry === undefined || oldEntry[1].supersededReceipt === null) {
      throw new Error("old pending command was not superseded");
    }
    expect(
      restorePlaybackAuthority({
        ...takenOver,
        acceptedCommands: {
          [oldEntry[0]]: {
            ...oldEntry[1],
            supersededReceipt: {
              ...oldEntry[1].supersededReceipt,
              supersededByLeaseId: "lease_forged",
            },
          },
        },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    const acceptedNew = reducePlaybackCommand(
      takenOver,
      command({
        type: "BLACKOUT_SET",
        actorId: "actor_controller-2",
        leaseId: "lease_replacement",
        controllerEpoch: "ce_8",
        commandId: "cmd_2",
        baseRevision: 1,
      }),
      nowMs,
    );
    expect(acceptedNew.receipt.status).toBe("ACCEPTED");
    const appliedNew = markStageApplied(
      acceptedNew.state,
      command({ type: "BLACKOUT_SET", commandId: "cmd_2" }).commandId,
      displayBindingEpoch(2),
    );
    expect(appliedNew.outcome).toBe("APPLIED");
    expect(String(appliedNew.state.publicPlaybackRevision)).toBe("pbr_1");
    expect(restorePlaybackAuthority(snapshotPlaybackAuthority(appliedNew.state))).toEqual({
      outcome: "RESTORED",
      state: appliedNew.state,
    });
  });

  test("never accepts relative commands from an offline queue or without a ready binding", () => {
    const offline = reducePlaybackCommand(
      authority(),
      command({ type: "SLIDE_NEXT", delivery: "OFFLINE_REPLAY" }),
      nowMs,
    );
    expect(offline.receipt).toMatchObject({
      status: "REJECTED",
      reason: "OFFLINE_RELATIVE_COMMAND",
    });

    const disconnected = reducePlaybackCommand(
      authority("DISCONNECTED"),
      command({ type: "SLIDE_NEXT" }),
      nowMs,
    );
    expect(disconnected.receipt).toMatchObject({ status: "REJECTED", reason: "STAGE_NOT_READY" });

    const absolute = reducePlaybackCommand(
      authority("DISCONNECTED"),
      command({ type: "SLIDE_SET" }),
      nowMs,
    );
    expect(absolute.receipt.status).toBe("ACCEPTED");
  });

  test("separates authority acceptance from ordered Stage application", () => {
    const acceptedOne = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }), nowMs);
    const acceptedTwo = reducePlaybackCommand(
      acceptedOne.state,
      command({ type: "BLACKOUT_SET", commandId: "cmd_2", baseRevision: 1 }),
      nowMs,
    );

    expect(acceptedTwo.receipt.status).toBe("ACCEPTED");
    const outOfOrder = markStageApplied(
      acceptedTwo.state,
      command({ type: "SLIDE_NEXT", commandId: "cmd_2" }).commandId,
      displayBindingEpoch(2),
    );
    expect(outOfOrder.outcome).toBe("OUT_OF_ORDER");
    expect(String(outOfOrder.state.publicPlaybackRevision)).toBe("pbr_0");

    const appliedOne = markStageApplied(
      acceptedTwo.state,
      command({ type: "SLIDE_NEXT" }).commandId,
      displayBindingEpoch(2),
    );
    expect(appliedOne.outcome).toBe("APPLIED");
    expect(appliedOne.receipt).toMatchObject({
      status: "STAGE_APPLIED",
      publicPlaybackRevision: "pbr_1",
    });
    const appliedTwo = markStageApplied(
      appliedOne.state,
      command({ type: "SLIDE_NEXT", commandId: "cmd_2" }).commandId,
      displayBindingEpoch(2),
    );
    expect(appliedTwo.outcome).toBe("APPLIED");
    expect(String(appliedTwo.state.publicPlaybackRevision)).toBe("pbr_2");

    const duplicate = markStageApplied(
      appliedTwo.state,
      command({ type: "SLIDE_NEXT" }).commandId,
      displayBindingEpoch(2),
    );
    expect(duplicate.outcome).toBe("DUPLICATE");
    expect(duplicate.receipt).toEqual(appliedOne.receipt);
  });

  test("rejects swapped or skipped Stage-applied acceptance prefixes", () => {
    const acceptedOne = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }), nowMs);
    const acceptedTwo = reducePlaybackCommand(
      acceptedOne.state,
      command({ type: "BLACKOUT_SET", commandId: "cmd_2", baseRevision: 1 }),
      nowMs,
    );
    const appliedOne = markStageApplied(
      acceptedTwo.state,
      command({ type: "SLIDE_NEXT" }).commandId,
      displayBindingEpoch(2),
    );
    const appliedTwo = markStageApplied(
      appliedOne.state,
      command({ type: "SLIDE_NEXT", commandId: "cmd_2" }).commandId,
      displayBindingEpoch(2),
    );
    const snapshot = snapshotPlaybackAuthority(appliedTwo.state);
    const records = Object.entries(snapshot.acceptedCommands).sort((left, right) =>
      left[1].receipt.acceptedControlRevision.localeCompare(
        right[1].receipt.acceptedControlRevision,
      ),
    );
    const first = records[0];
    const second = records[1];
    if (first === undefined || second === undefined)
      throw new Error("two receipts were not persisted");
    const firstApplied = first[1].appliedReceipt;
    const secondApplied = second[1].appliedReceipt;
    if (firstApplied === null || secondApplied === null)
      throw new Error("receipts were not applied");

    expect(
      restorePlaybackAuthority({
        ...snapshot,
        acceptedCommands: {
          ...snapshot.acceptedCommands,
          [first[0]]: {
            ...first[1],
            appliedReceipt: { ...firstApplied, publicPlaybackRevision: "pbr_2" },
          },
          [second[0]]: {
            ...second[1],
            appliedReceipt: { ...secondApplied, publicPlaybackRevision: "pbr_1" },
          },
        },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePlaybackAuthority({
        ...snapshot,
        publicPlaybackRevision: "pbr_1",
        acceptedCommands: {
          ...snapshot.acceptedCommands,
          [first[0]]: { ...first[1], appliedReceipt: null },
          [second[0]]: {
            ...second[1],
            appliedReceipt: { ...secondApplied, publicPlaybackRevision: "pbr_1" },
          },
        },
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
  });

  test("restores all authoritative and idempotency state after restart", () => {
    const accepted = reducePlaybackCommand(authority(), command({ type: "SLIDE_NEXT" }), nowMs);
    const restored = restorePlaybackAuthority(snapshotPlaybackAuthority(accepted.state));
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("valid playback snapshot was rejected");
    expect(restored.state).toEqual(accepted.state);

    const duplicate = reducePlaybackCommand(restored.state, command({ type: "SLIDE_NEXT" }), nowMs);
    expect(String(duplicate.state.controlRevision)).toBe("cr_1");
    expect(duplicate.receipt).toEqual(accepted.receipt);
    expect(
      restorePlaybackAuthority({
        ...snapshotPlaybackAuthority(accepted.state),
        controlRevision: "pbr_1",
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
    expect(
      restorePlaybackAuthority({
        ...snapshotPlaybackAuthority(accepted.state),
        controlRevision: "cr_9007199254740992",
      }),
    ).toEqual({ outcome: "INVALID_SNAPSHOT" });
  });
});

describe("public playback projection", () => {
  const event = (revision: number, slide = "slide_1"): PublicPlaybackEvent => ({
    presentationSessionId: PresentationSessionIdSchema.parse("ps_session-1"),
    presentationSessionEpoch: presentationSessionEpoch(3),
    displayBindingEpoch: displayBindingEpoch(2),
    deckVersion: DeckVersionIdSchema.parse("deck_v1"),
    manifestHash: hash("a"),
    publicPlaybackRevision: publicPlaybackRevision(revision),
    occurrence: {
      publicSlideKey: PublicSlideKeySchema.parse(slide),
      occurrenceSeq: revision + 1,
    },
    blackout: false,
  });

  const initialState = () =>
    initialPublicPlaybackState({
      presentationSessionId: PresentationSessionIdSchema.parse("ps_session-1"),
      presentationSessionEpoch: presentationSessionEpoch(3),
      displayBindingEpoch: displayBindingEpoch(2),
      deckVersion: DeckVersionIdSchema.parse("deck_v1"),
      manifestHash: hash("a"),
      occurrence: { publicSlideKey: PublicSlideKeySchema.parse("slide_1"), occurrenceSeq: 1 },
      blackout: false,
    });

  test("detects gaps, ignores duplicates, and accepts only the next revision", () => {
    const initial = initialState();
    const gap = applyPublicPlaybackEvent(initial, event(2, "slide_3"));
    expect(gap.outcome).toBe("GAP_REQUIRES_SNAPSHOT");
    expect(gap.state).toEqual(initial);

    const next = applyPublicPlaybackEvent(initial, event(1, "slide_2"));
    expect(next.outcome).toBe("APPLIED");
    expect(applyPublicPlaybackEvent(next.state, event(1, "slide_2")).outcome).toBe("DUPLICATE");
    expect(applyPublicPlaybackEvent(next.state, event(1, "slide_3")).outcome).toBe(
      "STALE_OR_CONFLICTING",
    );
  });

  test("rejects stale snapshots and recovers a gap from a current role snapshot", () => {
    const current = applyPublicPlaybackEvent(initialState(), event(1, "slide_2")).state;
    const stale = applyPublicPlaybackSnapshot(current, event(0, "slide_1"));
    expect(stale.outcome).toBe("STALE_SNAPSHOT");

    const recovered = applyPublicPlaybackSnapshot(current, event(5, "slide_3"));
    expect(recovered.outcome).toBe("APPLIED");
    expect(String(recovered.state.publicPlaybackRevision)).toBe("pbr_5");
    expect(String(recovered.state.occurrence.publicSlideKey)).toBe("slide_3");
  });

  test("restores public playback only from the PUBLIC_STAGE snapshot shape", () => {
    const snapshot = AudienceSnapshotSchema.parse({
      role: "PUBLIC_STAGE",
      presentationSessionId: "ps_session-1",
      presentationSessionEpoch: "pse_3",
      displayBindingEpoch: "dbe_2",
      publicPlaybackRevision: "pbr_7",
      publicCardRevision: "pcr_4",
      deck: {
        deckVersion: "deck_v1",
        manifestHash: hash("a"),
        title: "Published deck",
        slides: [
          {
            publicSlideKey: "slide_2",
            ordinal: 1,
            image: {
              url: "https://published.example/slide-2.png",
              contentHash: hash("b"),
              width: 1920,
              height: 1080,
            },
            accessibilityLabel: "Published slide",
          },
        ],
      },
      occurrence: { publicSlideKey: "slide_2", occurrenceSeq: 8 },
      blackout: true,
      cards: [],
      tombstones: [],
      tombstoneWatermark: "pcr_4",
    });

    const restored = applyAudiencePlaybackSnapshot(initialState(), snapshot);
    expect(restored.outcome).toBe("APPLIED");
    expect(restored.state).toMatchObject({
      publicPlaybackRevision: "pbr_7",
      occurrence: { publicSlideKey: "slide_2", occurrenceSeq: 8 },
      blackout: true,
    });
  });
});
