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
} from "@impromptu/contracts/control";
import {
  controlRevision,
  controlRevisionValue,
  nextControlRevision,
} from "@impromptu/contracts/control";
import type {
  DisplayBindingEpoch,
  PresentationSessionEpoch,
  PresentationSessionId,
  PublicPlaybackRevision,
  PublicSlideKey,
  PublicSlideOccurrence,
} from "@impromptu/contracts/public";
import { nextPublicPlaybackRevision, publicPlaybackRevision } from "@impromptu/contracts/public";

export type StageStatus = "READY" | "DISCONNECTED" | "UNBOUND";

export type PlaybackEffect = Readonly<{
  commandId: CommandId;
  acceptedControlRevision: ControlRevision;
  occurrence: PublicSlideOccurrence;
  blackout: boolean;
}>;

type AcceptedCommandRecord = Readonly<{
  requestHash: string;
  receipt: AcceptedCommandReceipt;
  effect: PlaybackEffect;
  appliedReceipt: StageAppliedReceipt | null;
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
  occurrence: PublicSlideOccurrence;
  nextOccurrenceSeq: number;
  blackout: boolean;
  acceptedCommands: Readonly<Record<string, AcceptedCommandRecord>>;
}>;

export type PlaybackAuthoritySnapshot = PlaybackAuthorityState;

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
    ...input,
    slideOrder: [...input.slideOrder],
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
    requestHash,
    receipt,
    effect,
    appliedReceipt: null,
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
      (candidate) =>
        candidate.appliedReceipt === null &&
        candidate.receipt.leaseId === lease.leaseId &&
        candidate.receipt.controllerEpoch === lease.controllerEpoch,
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
  return { ...state, activeLease };
}

export function snapshotPlaybackAuthority(
  state: PlaybackAuthorityState,
): PlaybackAuthoritySnapshot {
  return structuredClone(state);
}

export function restorePlaybackAuthority(
  snapshot: PlaybackAuthoritySnapshot,
): PlaybackAuthorityState {
  return structuredClone(snapshot);
}
