import { createHash } from "node:crypto";
import type {
  AcceptedCommandReceipt,
  CommandId,
  CommandReceipt,
  ControlRevision,
  PlaybackCommand,
  PlaybackControlLease,
  RejectedCommandReceipt,
  StageAppliedReceipt,
  SupersededCommandReceipt,
} from "@impromptu/contracts/control";
import {
  AcceptedCommandReceiptSchema,
  CommandIdSchema,
  ControlRevisionSchema,
  controlRevision,
  controlRevisionValue,
  nextControlRevision,
  PlaybackCommandSchema,
  PlaybackControlLeaseSchema,
  StageAppliedReceiptSchema,
  SupersededCommandReceiptSchema,
} from "@impromptu/contracts/control";
import type {
  DisplayBindingEpoch,
  PresentationSessionEpoch,
  PresentationSessionId,
  PublicPlaybackRevision,
  PublicSlideKey,
  PublicSlideOccurrence,
} from "@impromptu/contracts/public";
import {
  DisplayBindingEpochSchema,
  nextPublicPlaybackRevision,
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
  PublicPlaybackRevisionSchema,
  PublicSlideKeySchema,
  PublicSlideOccurrenceSchema,
  publicPlaybackRevision,
  Sha256Schema,
} from "@impromptu/contracts/public";
import { safeEncodedCounterValue } from "@impromptu/contracts/shared";
import { z } from "zod";

export type StageStatus = "READY" | "DISCONNECTED" | "UNBOUND";

export type PlaybackEffect = Readonly<{
  commandId: CommandId;
  acceptedControlRevision: ControlRevision;
  occurrence: PublicSlideOccurrence;
  blackout: boolean;
}>;

type AcceptanceContext = Readonly<{
  lease: PlaybackControlLease;
  stageStatus: StageStatus;
  displayBindingEpoch: DisplayBindingEpoch;
  acceptedAtMs: number;
}>;

type AcceptedCommandRecord = Readonly<{
  command: PlaybackCommand;
  acceptanceContext: AcceptanceContext;
  requestHash: string;
  receipt: AcceptedCommandReceipt;
  effect: PlaybackEffect;
  appliedReceipt: StageAppliedReceipt | null;
  supersededReceipt: SupersededCommandReceipt | null;
}>;

export type PlaybackAuthorityState = Readonly<{
  presentationSessionId: PresentationSessionId;
  presentationSessionEpoch: PresentationSessionEpoch;
  activeLease: PlaybackControlLease;
  displayBindingEpoch: DisplayBindingEpoch;
  controlRevision: ControlRevision;
  publicPlaybackRevision: PublicPlaybackRevision;
  stageStatus: StageStatus;
  slideOrder: readonly PublicSlideKey[];
  initialSlideKey: PublicSlideKey;
  occurrence: PublicSlideOccurrence;
  nextOccurrenceSeq: number;
  blackout: boolean;
  acceptedCommands: Readonly<Record<string, AcceptedCommandRecord>>;
}>;

export type PlaybackAuthoritySnapshot = PlaybackAuthorityState;

const PlaybackEffectSchema = z
  .object({
    commandId: CommandIdSchema,
    acceptedControlRevision: ControlRevisionSchema,
    occurrence: PublicSlideOccurrenceSchema,
    blackout: z.boolean(),
  })
  .strict();
const AcceptedCommandRecordSchema = z
  .object({
    command: PlaybackCommandSchema,
    acceptanceContext: z
      .object({
        lease: PlaybackControlLeaseSchema,
        stageStatus: z.enum(["READY", "DISCONNECTED", "UNBOUND"]),
        displayBindingEpoch: DisplayBindingEpochSchema,
        acceptedAtMs: z.number().int().nonnegative(),
      })
      .strict(),
    requestHash: Sha256Schema,
    receipt: AcceptedCommandReceiptSchema,
    effect: PlaybackEffectSchema,
    appliedReceipt: StageAppliedReceiptSchema.nullable(),
    supersededReceipt: SupersededCommandReceiptSchema.nullable(),
  })
  .strict();
const PlaybackAuthoritySnapshotSchema = z
  .object({
    presentationSessionId: PresentationSessionIdSchema,
    presentationSessionEpoch: PresentationSessionEpochSchema,
    activeLease: PlaybackControlLeaseSchema,
    displayBindingEpoch: DisplayBindingEpochSchema,
    controlRevision: ControlRevisionSchema,
    publicPlaybackRevision: PublicPlaybackRevisionSchema,
    stageStatus: z.enum(["READY", "DISCONNECTED", "UNBOUND"]),
    slideOrder: z.array(PublicSlideKeySchema),
    initialSlideKey: PublicSlideKeySchema,
    occurrence: PublicSlideOccurrenceSchema,
    nextOccurrenceSeq: z.number().int().positive(),
    blackout: z.boolean(),
    acceptedCommands: z.record(z.string(), AcceptedCommandRecordSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.activeLease.presentationSessionId !== snapshot.presentationSessionId ||
      snapshot.activeLease.presentationSessionEpoch !== snapshot.presentationSessionEpoch
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeLease"],
        message: "lease belongs to another session",
      });
    }
    if (
      new Set(snapshot.slideOrder).size !== snapshot.slideOrder.length ||
      !snapshot.slideOrder.includes(snapshot.occurrence.publicSlideKey)
    ) {
      context.addIssue({ code: "custom", path: ["slideOrder"], message: "invalid slide registry" });
    }
    const controlHead = safeEncodedCounterValue(snapshot.controlRevision);
    const playbackHead = safeEncodedCounterValue(snapshot.publicPlaybackRevision);
    if (controlHead === null || playbackHead === null) return;
    const recordsByRevision = new Map<number, AcceptedCommandRecord>();
    const appliedByPublicRevision = new Map<number, AcceptedCommandRecord>();
    const currentBinding = safeEncodedCounterValue(snapshot.displayBindingEpoch);
    if (currentBinding === null) return;
    for (const [key, record] of Object.entries(snapshot.acceptedCommands)) {
      const command = record.command;
      const receipt = record.receipt;
      const acceptance = record.acceptanceContext;
      const acceptedLease = acceptance.lease;
      const acceptedRevision = safeEncodedCounterValue(receipt.acceptedControlRevision);
      const canonicalHash = canonicalPlaybackRequestHash(command);
      const identityMatches =
        command.presentationSessionId === receipt.presentationSessionId &&
        command.presentationSessionEpoch === receipt.presentationSessionEpoch &&
        command.actorId === receipt.actorId &&
        command.leaseId === receipt.leaseId &&
        command.controllerEpoch === receipt.controllerEpoch &&
        command.commandId === receipt.commandId &&
        command.displayBindingEpoch === receipt.displayBindingEpoch;
      const acceptanceMatches =
        acceptedLease.presentationSessionId === command.presentationSessionId &&
        acceptedLease.presentationSessionEpoch === command.presentationSessionEpoch &&
        acceptedLease.actorId === command.actorId &&
        acceptedLease.leaseId === command.leaseId &&
        acceptedLease.controllerEpoch === command.controllerEpoch &&
        acceptance.displayBindingEpoch === command.displayBindingEpoch &&
        acceptance.acceptedAtMs < acceptedLease.expiresAtMs;
      let valid =
        key === commandKey(command) &&
        command.presentationSessionId === snapshot.presentationSessionId &&
        command.presentationSessionEpoch === snapshot.presentationSessionEpoch &&
        identityMatches &&
        acceptanceMatches &&
        record.requestHash === canonicalHash &&
        receipt.requestHash === canonicalHash &&
        record.effect.commandId === receipt.commandId &&
        record.effect.acceptedControlRevision === receipt.acceptedControlRevision &&
        acceptedRevision !== null &&
        acceptedRevision >= 1 &&
        acceptedRevision <= controlHead &&
        !recordsByRevision.has(acceptedRevision ?? -1) &&
        !(record.appliedReceipt !== null && record.supersededReceipt !== null);

      if (record.appliedReceipt !== null) {
        const applied = record.appliedReceipt;
        const appliedRevision = safeEncodedCounterValue(applied.publicPlaybackRevision);
        const appliedBinding = safeEncodedCounterValue(applied.displayBindingEpoch);
        valid =
          valid &&
          applied.presentationSessionId === receipt.presentationSessionId &&
          applied.presentationSessionEpoch === receipt.presentationSessionEpoch &&
          applied.actorId === receipt.actorId &&
          applied.leaseId === receipt.leaseId &&
          applied.controllerEpoch === receipt.controllerEpoch &&
          applied.commandId === receipt.commandId &&
          applied.requestHash === receipt.requestHash &&
          applied.acceptedControlRevision === receipt.acceptedControlRevision &&
          appliedRevision !== null &&
          appliedRevision >= 1 &&
          appliedRevision <= playbackHead &&
          appliedBinding !== null &&
          appliedBinding <= currentBinding &&
          !appliedByPublicRevision.has(appliedRevision ?? -1);
        if (appliedRevision !== null) appliedByPublicRevision.set(appliedRevision, record);
      }
      if (record.supersededReceipt !== null) {
        const superseded = record.supersededReceipt;
        valid =
          valid &&
          superseded.presentationSessionId === receipt.presentationSessionId &&
          superseded.presentationSessionEpoch === receipt.presentationSessionEpoch &&
          superseded.actorId === receipt.actorId &&
          superseded.leaseId === receipt.leaseId &&
          superseded.controllerEpoch === receipt.controllerEpoch &&
          superseded.commandId === receipt.commandId &&
          superseded.requestHash === receipt.requestHash &&
          superseded.displayBindingEpoch === receipt.displayBindingEpoch &&
          superseded.acceptedControlRevision === receipt.acceptedControlRevision &&
          (superseded.supersededByLeaseId !== receipt.leaseId ||
            superseded.supersededByControllerEpoch !== receipt.controllerEpoch);
      }
      if (acceptedRevision !== null) recordsByRevision.set(acceptedRevision, record);
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands", key],
          message: "invalid accepted command identity, context, or terminal receipt",
        });
      }
    }

    if (recordsByRevision.size !== controlHead || appliedByPublicRevision.size !== playbackHead) {
      context.addIssue({
        code: "custom",
        path: ["acceptedCommands"],
        message: "accepted or applied revisions are not gap-free",
      });
      return;
    }
    for (let revision = 1; revision <= controlHead; revision += 1) {
      if (!recordsByRevision.has(revision)) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "accepted revisions contain a gap",
        });
        return;
      }
    }
    for (let revision = 1; revision <= playbackHead; revision += 1) {
      if (!appliedByPublicRevision.has(revision)) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "applied revisions contain a gap",
        });
        return;
      }
    }

    let occurrence: PublicSlideOccurrence = {
      publicSlideKey: snapshot.initialSlideKey,
      occurrenceSeq: 1,
    };
    let nextOccurrenceSeq = 2;
    let blackout = false;
    let expectedAppliedRevision = 0;
    let lastAppliedBinding = 0;
    let pendingSeen = false;
    for (let revision = 1; revision <= controlHead; revision += 1) {
      const record = recordsByRevision.get(revision);
      if (record === undefined) return;
      const command = record.command;
      if (safeEncodedCounterValue(command.baseRevision) !== revision - 1) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "command base revision does not match accepted order",
        });
        return;
      }
      const relative = command.type === "SLIDE_NEXT" || command.type === "SLIDE_PREVIOUS";
      if (
        (relative && command.delivery === "OFFLINE_REPLAY") ||
        (relative && record.acceptanceContext.stageStatus !== "READY") ||
        (command.type === "SLIDE_SET" && !snapshot.slideOrder.includes(command.publicSlideKey))
      ) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "persisted command violates live acceptance predicates",
        });
        return;
      }
      if (record.appliedReceipt !== null) {
        const appliedRevision = safeEncodedCounterValue(
          record.appliedReceipt.publicPlaybackRevision,
        );
        const appliedBinding = safeEncodedCounterValue(record.appliedReceipt.displayBindingEpoch);
        const acceptedBinding = safeEncodedCounterValue(
          record.acceptanceContext.displayBindingEpoch,
        );
        expectedAppliedRevision += 1;
        if (
          pendingSeen ||
          appliedRevision !== expectedAppliedRevision ||
          appliedBinding === null ||
          acceptedBinding === null ||
          appliedBinding < acceptedBinding ||
          appliedBinding < lastAppliedBinding
        ) {
          context.addIssue({
            code: "custom",
            path: ["acceptedCommands"],
            message: "Stage receipts do not form an ordered terminal prefix",
          });
          return;
        }
        lastAppliedBinding = appliedBinding;
      } else if (record.supersededReceipt === null) {
        pendingSeen = true;
      } else if (pendingSeen) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "superseded receipt appears after a pending command",
        });
        return;
      }
      let target = occurrence.publicSlideKey;
      if (command.type === "SLIDE_SET") target = command.publicSlideKey;
      if (relative) {
        const currentIndex = snapshot.slideOrder.indexOf(occurrence.publicSlideKey);
        const offset = command.type === "SLIDE_NEXT" ? 1 : -1;
        const relativeTarget = snapshot.slideOrder[currentIndex + offset];
        if (relativeTarget === undefined) {
          context.addIssue({
            code: "custom",
            path: ["acceptedCommands"],
            message: "accepted relative command crosses a slide boundary",
          });
          return;
        }
        target = relativeTarget;
      }
      if (target !== occurrence.publicSlideKey) {
        occurrence = { publicSlideKey: target, occurrenceSeq: nextOccurrenceSeq };
        nextOccurrenceSeq += 1;
      }
      if (command.type === "BLACKOUT_SET") blackout = command.enabled;
      if (
        record.effect.occurrence.publicSlideKey !== occurrence.publicSlideKey ||
        record.effect.occurrence.occurrenceSeq !== occurrence.occurrenceSeq ||
        record.effect.blackout !== blackout
      ) {
        context.addIssue({
          code: "custom",
          path: ["acceptedCommands"],
          message: "persisted command effect does not match canonical replay",
        });
        return;
      }
    }
    if (expectedAppliedRevision !== playbackHead) {
      context.addIssue({
        code: "custom",
        path: ["publicPlaybackRevision"],
        message: "public playback head does not match applied command history",
      });
    }
    if (
      snapshot.occurrence.publicSlideKey !== occurrence.publicSlideKey ||
      snapshot.occurrence.occurrenceSeq !== occurrence.occurrenceSeq ||
      snapshot.nextOccurrenceSeq !== nextOccurrenceSeq ||
      snapshot.blackout !== blackout
    ) {
      context.addIssue({
        code: "custom",
        path: ["occurrence"],
        message: "playback state does not match canonical command replay",
      });
    }
  });

export type CreatePlaybackAuthorityState = Readonly<{
  presentationSessionId: PresentationSessionId;
  presentationSessionEpoch: PresentationSessionEpoch;
  activeLease: PlaybackControlLease;
  displayBindingEpoch: DisplayBindingEpoch;
  stageStatus: StageStatus;
  slideOrder: readonly PublicSlideKey[];
  initialSlideKey: PublicSlideKey;
}>;

export function createPlaybackAuthorityState(
  input: CreatePlaybackAuthorityState,
): PlaybackAuthorityState {
  if (
    input.activeLease.presentationSessionId !== input.presentationSessionId ||
    input.activeLease.presentationSessionEpoch !== input.presentationSessionEpoch
  ) {
    throw new Error("active lease must belong to the playback presentation session");
  }
  if (!input.slideOrder.includes(input.initialSlideKey)) {
    throw new Error("initial slide must exist in slide order");
  }
  if (new Set(input.slideOrder).size !== input.slideOrder.length) {
    throw new Error("slide order must contain unique public slide keys");
  }
  return {
    presentationSessionId: input.presentationSessionId,
    presentationSessionEpoch: input.presentationSessionEpoch,
    activeLease: input.activeLease,
    displayBindingEpoch: input.displayBindingEpoch,
    stageStatus: input.stageStatus,
    slideOrder: [...input.slideOrder],
    initialSlideKey: input.initialSlideKey,
    controlRevision: controlRevision(0),
    publicPlaybackRevision: publicPlaybackRevision(0),
    occurrence: { publicSlideKey: input.initialSlideKey, occurrenceSeq: 1 },
    nextOccurrenceSeq: 2,
    blackout: false,
    acceptedCommands: {},
  };
}

function canonicalCommandPayload(command: PlaybackCommand): string {
  const payload =
    command.type === "SLIDE_SET"
      ? `publicSlideKey=${JSON.stringify(command.publicSlideKey)}`
      : command.type === "BLACKOUT_SET"
        ? `enabled=${command.enabled ? "true" : "false"}`
        : "";
  return [
    `type=${command.type}`,
    `baseRevision=${command.baseRevision}`,
    `delivery=${command.delivery}`,
    `displayBindingEpoch=${command.displayBindingEpoch}`,
    payload,
  ].join("\n");
}

export function canonicalPlaybackRequestHash(command: PlaybackCommand): string {
  return createHash("sha256").update(canonicalCommandPayload(command), "utf8").digest("hex");
}

function commandKey(command: PlaybackCommand): string {
  return JSON.stringify([
    command.presentationSessionId,
    command.presentationSessionEpoch,
    command.actorId,
    command.leaseId,
    command.controllerEpoch,
    command.commandId,
  ]);
}

function receiptIdentity(command: PlaybackCommand, requestHash: string) {
  return {
    presentationSessionId: command.presentationSessionId,
    presentationSessionEpoch: command.presentationSessionEpoch,
    actorId: command.actorId,
    leaseId: command.leaseId,
    controllerEpoch: command.controllerEpoch,
    commandId: command.commandId,
    requestHash,
    displayBindingEpoch: command.displayBindingEpoch,
  };
}

function reject(
  state: PlaybackAuthorityState,
  command: PlaybackCommand,
  requestHash: string,
  reason: RejectedCommandReceipt["reason"],
): PlaybackReduction {
  return {
    state,
    receipt: { status: "REJECTED", ...receiptIdentity(command, requestHash), reason },
    effect: null,
  };
}

function isRelative(command: PlaybackCommand): boolean {
  return command.type === "SLIDE_NEXT" || command.type === "SLIDE_PREVIOUS";
}

function targetSlide(
  state: PlaybackAuthorityState,
  command: PlaybackCommand,
): PublicSlideKey | null {
  if (command.type === "SLIDE_SET") {
    return state.slideOrder.includes(command.publicSlideKey) ? command.publicSlideKey : null;
  }
  if (!isRelative(command)) return state.occurrence.publicSlideKey;
  const currentIndex = state.slideOrder.indexOf(state.occurrence.publicSlideKey);
  const offset = command.type === "SLIDE_NEXT" ? 1 : -1;
  return state.slideOrder[currentIndex + offset] ?? null;
}

export type PlaybackReduction = Readonly<{
  state: PlaybackAuthorityState;
  receipt: CommandReceipt;
  effect: PlaybackEffect | null;
}>;

export function reducePlaybackCommand(
  state: PlaybackAuthorityState,
  command: PlaybackCommand,
  nowMs: number,
): PlaybackReduction {
  const requestHash = canonicalPlaybackRequestHash(command);
  if (command.actorId !== state.activeLease.actorId) {
    return reject(state, command, requestHash, "UNAUTHORIZED");
  }
  if (
    command.presentationSessionId !== state.presentationSessionId ||
    command.presentationSessionEpoch !== state.presentationSessionEpoch
  ) {
    return reject(state, command, requestHash, "STALE_SESSION_EPOCH");
  }
  if (command.leaseId !== state.activeLease.leaseId) {
    return reject(state, command, requestHash, "STALE_LEASE");
  }
  if (nowMs >= state.activeLease.expiresAtMs) {
    return reject(state, command, requestHash, "LEASE_EXPIRED");
  }
  if (command.controllerEpoch !== state.activeLease.controllerEpoch) {
    return reject(state, command, requestHash, "STALE_CONTROLLER_EPOCH");
  }
  if (command.displayBindingEpoch !== state.displayBindingEpoch) {
    return reject(state, command, requestHash, "STALE_DISPLAY_BINDING");
  }

  const key = commandKey(command);
  const prior = state.acceptedCommands[key];
  if (prior !== undefined) {
    if (prior.requestHash !== requestHash) {
      return reject(state, command, requestHash, "IDEMPOTENCY_CONFLICT");
    }
    return { state, receipt: prior.receipt, effect: prior.effect };
  }
  if (command.baseRevision !== state.controlRevision) {
    return reject(state, command, requestHash, "REVISION_MISMATCH");
  }
  if (isRelative(command) && command.delivery === "OFFLINE_REPLAY") {
    return reject(state, command, requestHash, "OFFLINE_RELATIVE_COMMAND");
  }
  if (isRelative(command) && state.stageStatus !== "READY") {
    return reject(state, command, requestHash, "STAGE_NOT_READY");
  }

  const nextSlide = targetSlide(state, command);
  if (nextSlide === null) {
    return reject(
      state,
      command,
      requestHash,
      command.type === "SLIDE_SET" ? "UNKNOWN_SLIDE" : "SLIDE_BOUNDARY",
    );
  }

  const slideChanged = nextSlide !== state.occurrence.publicSlideKey;
  const occurrence = slideChanged
    ? { publicSlideKey: nextSlide, occurrenceSeq: state.nextOccurrenceSeq }
    : state.occurrence;
  const nextOccurrenceSeq = slideChanged ? state.nextOccurrenceSeq + 1 : state.nextOccurrenceSeq;
  const blackout = command.type === "BLACKOUT_SET" ? command.enabled : state.blackout;
  const acceptedControlRevision = nextControlRevision(state.controlRevision);
  const receipt: AcceptedCommandReceipt = {
    status: "ACCEPTED",
    ...receiptIdentity(command, requestHash),
    acceptedControlRevision,
  };
  const effect: PlaybackEffect = {
    commandId: command.commandId,
    acceptedControlRevision,
    occurrence,
    blackout,
  };
  const record: AcceptedCommandRecord = {
    command,
    acceptanceContext: {
      lease: state.activeLease,
      stageStatus: state.stageStatus,
      displayBindingEpoch: state.displayBindingEpoch,
      acceptedAtMs: nowMs,
    },
    requestHash,
    receipt,
    effect,
    appliedReceipt: null,
    supersededReceipt: null,
  };
  return {
    state: {
      ...state,
      controlRevision: acceptedControlRevision,
      occurrence,
      nextOccurrenceSeq,
      blackout,
      acceptedCommands: { ...state.acceptedCommands, [key]: record },
    },
    receipt,
    effect,
  };
}

export type StageApplyOutcome =
  | "APPLIED"
  | "DUPLICATE"
  | "OUT_OF_ORDER"
  | "UNKNOWN_COMMAND"
  | "STALE_BINDING";
export type StageApplyResult = Readonly<{
  state: PlaybackAuthorityState;
  outcome: StageApplyOutcome;
  receipt: StageAppliedReceipt | null;
}>;

export function markStageApplied(
  state: PlaybackAuthorityState,
  commandId: CommandId,
  displayBindingEpoch: DisplayBindingEpoch,
): StageApplyResult {
  if (displayBindingEpoch !== state.displayBindingEpoch) {
    return { state, outcome: "STALE_BINDING", receipt: null };
  }
  const lease = state.activeLease;
  const key = JSON.stringify([
    state.presentationSessionId,
    state.presentationSessionEpoch,
    lease.actorId,
    lease.leaseId,
    lease.controllerEpoch,
    commandId,
  ]);
  const record = state.acceptedCommands[key];
  if (record === undefined) return { state, outcome: "UNKNOWN_COMMAND", receipt: null };
  if (record.appliedReceipt !== null) {
    return { state, outcome: "DUPLICATE", receipt: record.appliedReceipt };
  }

  const firstPendingRevision = Object.values(state.acceptedCommands)
    .filter(
      (candidate) => candidate.appliedReceipt === null && candidate.supersededReceipt === null,
    )
    .reduce(
      (minimum, candidate) =>
        Math.min(minimum, controlRevisionValue(candidate.receipt.acceptedControlRevision)),
      Number.POSITIVE_INFINITY,
    );
  if (controlRevisionValue(record.receipt.acceptedControlRevision) !== firstPendingRevision) {
    return { state, outcome: "OUT_OF_ORDER", receipt: null };
  }

  const receipt: StageAppliedReceipt = {
    status: "STAGE_APPLIED",
    presentationSessionId: record.receipt.presentationSessionId,
    presentationSessionEpoch: record.receipt.presentationSessionEpoch,
    actorId: record.receipt.actorId,
    leaseId: record.receipt.leaseId,
    controllerEpoch: record.receipt.controllerEpoch,
    commandId: record.receipt.commandId,
    requestHash: record.receipt.requestHash,
    acceptedControlRevision: record.receipt.acceptedControlRevision,
    publicPlaybackRevision: nextPublicPlaybackRevision(state.publicPlaybackRevision),
    displayBindingEpoch,
  };
  return {
    state: {
      ...state,
      publicPlaybackRevision: receipt.publicPlaybackRevision,
      acceptedCommands: {
        ...state.acceptedCommands,
        [key]: { ...record, appliedReceipt: receipt },
      },
    },
    outcome: "APPLIED",
    receipt,
  };
}

export function replacePlaybackLease(
  state: PlaybackAuthorityState,
  activeLease: PlaybackControlLease,
): PlaybackAuthorityState {
  if (
    activeLease.presentationSessionId !== state.presentationSessionId ||
    activeLease.presentationSessionEpoch !== state.presentationSessionEpoch
  ) {
    throw new Error("replacement lease belongs to a different presentation session");
  }
  const acceptedCommands = Object.fromEntries(
    Object.entries(state.acceptedCommands).map(([key, record]) => {
      const belongsToCurrentLease =
        record.receipt.leaseId === state.activeLease.leaseId &&
        record.receipt.controllerEpoch === state.activeLease.controllerEpoch;
      if (
        !belongsToCurrentLease ||
        record.appliedReceipt !== null ||
        record.supersededReceipt !== null
      ) {
        return [key, record];
      }
      const supersededReceipt: SupersededCommandReceipt = {
        status: "SUPERSEDED",
        presentationSessionId: record.receipt.presentationSessionId,
        presentationSessionEpoch: record.receipt.presentationSessionEpoch,
        actorId: record.receipt.actorId,
        leaseId: record.receipt.leaseId,
        controllerEpoch: record.receipt.controllerEpoch,
        commandId: record.receipt.commandId,
        requestHash: record.receipt.requestHash,
        displayBindingEpoch: record.receipt.displayBindingEpoch,
        acceptedControlRevision: record.receipt.acceptedControlRevision,
        supersededByLeaseId: activeLease.leaseId,
        supersededByControllerEpoch: activeLease.controllerEpoch,
      };
      return [key, { ...record, supersededReceipt }];
    }),
  );
  return { ...state, activeLease, acceptedCommands };
}

export function setPlaybackStageStatus(
  state: PlaybackAuthorityState,
  stageStatus: StageStatus,
): PlaybackAuthorityState {
  return { ...state, stageStatus };
}

export function rotatePlaybackDisplayBinding(
  state: PlaybackAuthorityState,
  displayBindingEpoch: DisplayBindingEpoch,
): PlaybackAuthorityState {
  const current = safeEncodedCounterValue(state.displayBindingEpoch);
  const next = safeEncodedCounterValue(displayBindingEpoch);
  if (current === null || next === null || next <= current) {
    throw new Error("display binding epoch must advance monotonically");
  }
  return { ...state, displayBindingEpoch };
}

export function snapshotPlaybackAuthority(
  state: PlaybackAuthorityState,
): PlaybackAuthoritySnapshot {
  return structuredClone(state);
}

export type PlaybackAuthorityRestoreResult =
  | Readonly<{ outcome: "RESTORED"; state: PlaybackAuthorityState }>
  | Readonly<{ outcome: "INVALID_SNAPSHOT" }>;

export function restorePlaybackAuthority(snapshot: unknown): PlaybackAuthorityRestoreResult {
  const parsed = PlaybackAuthoritySnapshotSchema.safeParse(snapshot);
  return parsed.success
    ? { outcome: "RESTORED", state: parsed.data }
    : { outcome: "INVALID_SNAPSHOT" };
}
