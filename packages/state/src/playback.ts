import type {
  AcceptedCommandReceipt,
  CommandReceipt,
  PlaybackCommand,
  PublicSlideOccurrence,
  RejectedCommandReceipt,
  StageAppliedReceipt,
} from "@impromptu/contracts";

export type StageStatus = "READY" | "DISCONNECTED" | "UNBOUND";

export type PlaybackEffect = Readonly<{
  commandId: string;
  acceptedControlRevision: number;
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
  presentationSessionId: string;
  presentationSessionEpoch: number;
  actorId: string;
  controllerEpoch: number;
  displayBindingEpoch: number;
  controlRevision: number;
  publicPlaybackRevision: number;
  stageStatus: StageStatus;
  slideOrder: readonly string[];
  occurrence: PublicSlideOccurrence;
  nextOccurrenceSeq: number;
  blackout: boolean;
  acceptedCommands: Readonly<Record<string, AcceptedCommandRecord>>;
}>;

export type PlaybackAuthoritySnapshot = PlaybackAuthorityState;

export type CreatePlaybackAuthorityState = Readonly<{
  presentationSessionId: string;
  presentationSessionEpoch: number;
  actorId: string;
  controllerEpoch: number;
  displayBindingEpoch: number;
  stageStatus: StageStatus;
  slideOrder: readonly string[];
  initialSlideKey: string;
}>;

export function createPlaybackAuthorityState(
  input: CreatePlaybackAuthorityState,
): PlaybackAuthorityState {
  if (!input.slideOrder.includes(input.initialSlideKey)) {
    throw new Error("initial slide must exist in slide order");
  }
  if (new Set(input.slideOrder).size !== input.slideOrder.length) {
    throw new Error("slide order must contain unique public slide keys");
  }
  return {
    ...input,
    slideOrder: [...input.slideOrder],
    controlRevision: 0,
    publicPlaybackRevision: 0,
    occurrence: { publicSlideKey: input.initialSlideKey, occurrenceSeq: 1 },
    nextOccurrenceSeq: 2,
    blackout: false,
    acceptedCommands: {},
  };
}

function commandKey(command: PlaybackCommand): string {
  return JSON.stringify([
    command.presentationSessionId,
    command.actorId,
    command.controllerEpoch,
    command.commandId,
  ]);
}

function receiptIdentity(command: PlaybackCommand) {
  return {
    presentationSessionId: command.presentationSessionId,
    presentationSessionEpoch: command.presentationSessionEpoch,
    actorId: command.actorId,
    controllerEpoch: command.controllerEpoch,
    commandId: command.commandId,
    requestHash: command.requestHash,
  };
}

function reject(
  state: PlaybackAuthorityState,
  command: PlaybackCommand,
  reason: RejectedCommandReceipt["reason"],
): PlaybackReduction {
  return {
    state,
    receipt: { status: "REJECTED", ...receiptIdentity(command), reason },
    effect: null,
  };
}

function isRelative(command: PlaybackCommand): boolean {
  return command.type === "SLIDE_NEXT" || command.type === "SLIDE_PREVIOUS";
}

function targetSlide(state: PlaybackAuthorityState, command: PlaybackCommand): string | null {
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
): PlaybackReduction {
  if (
    command.presentationSessionId !== state.presentationSessionId ||
    command.presentationSessionEpoch !== state.presentationSessionEpoch
  ) {
    return reject(state, command, "STALE_SESSION_EPOCH");
  }
  if (command.actorId !== state.actorId || command.controllerEpoch !== state.controllerEpoch) {
    return reject(state, command, "STALE_CONTROLLER_EPOCH");
  }

  const key = commandKey(command);
  const prior = state.acceptedCommands[key];
  if (prior !== undefined) {
    if (prior.requestHash !== command.requestHash) {
      return reject(state, command, "IDEMPOTENCY_CONFLICT");
    }
    return { state, receipt: prior.receipt, effect: prior.effect };
  }
  if (command.baseRevision !== state.controlRevision) {
    return reject(state, command, "REVISION_MISMATCH");
  }
  if (isRelative(command) && command.delivery === "OFFLINE_REPLAY") {
    return reject(state, command, "OFFLINE_RELATIVE_COMMAND");
  }
  if (isRelative(command) && state.stageStatus !== "READY") {
    return reject(state, command, "STAGE_NOT_READY");
  }

  const nextSlide = targetSlide(state, command);
  if (nextSlide === null) {
    const reason = command.type === "SLIDE_SET" ? "UNKNOWN_SLIDE" : "SLIDE_BOUNDARY";
    return reject(state, command, reason);
  }

  const slideChanged = nextSlide !== state.occurrence.publicSlideKey;
  const occurrence = slideChanged
    ? { publicSlideKey: nextSlide, occurrenceSeq: state.nextOccurrenceSeq }
    : state.occurrence;
  const nextOccurrenceSeq = slideChanged ? state.nextOccurrenceSeq + 1 : state.nextOccurrenceSeq;
  const blackout = command.type === "BLACKOUT_SET" ? command.enabled : state.blackout;
  const acceptedControlRevision = state.controlRevision + 1;
  const receipt: AcceptedCommandReceipt = {
    status: "ACCEPTED",
    ...receiptIdentity(command),
    acceptedControlRevision,
  };
  const effect: PlaybackEffect = {
    commandId: command.commandId,
    acceptedControlRevision,
    occurrence,
    blackout,
  };
  const record: AcceptedCommandRecord = {
    requestHash: command.requestHash,
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
  commandId: string,
  displayBindingEpoch: number,
): StageApplyResult {
  if (displayBindingEpoch !== state.displayBindingEpoch) {
    return { state, outcome: "STALE_BINDING", receipt: null };
  }
  const key = JSON.stringify([
    state.presentationSessionId,
    state.actorId,
    state.controllerEpoch,
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
        candidate.receipt.actorId === state.actorId &&
        candidate.receipt.controllerEpoch === state.controllerEpoch,
    )
    .reduce(
      (minimum, candidate) => Math.min(minimum, candidate.receipt.acceptedControlRevision),
      Number.POSITIVE_INFINITY,
    );
  if (record.receipt.acceptedControlRevision !== firstPendingRevision) {
    return { state, outcome: "OUT_OF_ORDER", receipt: null };
  }

  const receipt: StageAppliedReceipt = {
    status: "STAGE_APPLIED",
    presentationSessionId: record.receipt.presentationSessionId,
    presentationSessionEpoch: record.receipt.presentationSessionEpoch,
    actorId: record.receipt.actorId,
    controllerEpoch: record.receipt.controllerEpoch,
    commandId: record.receipt.commandId,
    requestHash: record.receipt.requestHash,
    acceptedControlRevision: record.receipt.acceptedControlRevision,
    publicPlaybackRevision: state.publicPlaybackRevision + 1,
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
