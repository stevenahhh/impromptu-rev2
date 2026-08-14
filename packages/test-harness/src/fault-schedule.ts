import type {
  CommandId,
  CommandReceipt,
  PlaybackCommand,
  PlaybackControlLease,
} from "@impromptu/contracts/control";
import type { DisplayBindingEpoch } from "@impromptu/contracts/public";
import {
  applyPublicPlaybackEvent,
  applyPublicPlaybackSnapshot,
  markStageApplied,
  type PlaybackAuthorityState,
  type PublicPlaybackEvent,
  type PublicPlaybackOutcome,
  type PublicPlaybackSnapshot,
  type PublicPlaybackState,
  reducePlaybackCommand,
  replacePlaybackLease,
  restorePlaybackAuthority,
  type StageApplyOutcome,
  type StageStatus,
  snapshotPlaybackAuthority,
} from "@impromptu/state";

export type PlaybackFaultAction =
  | Readonly<{ type: "COMMAND"; command: PlaybackCommand }>
  | Readonly<{
      type: "STAGE_APPLY";
      commandId: CommandId;
      displayBindingEpoch: DisplayBindingEpoch;
    }>
  | Readonly<{ type: "RESTART" }>
  | Readonly<{ type: "STAGE_STATUS"; status: StageStatus }>
  | Readonly<{ type: "TAKEOVER"; lease: PlaybackControlLease }>;

export type PlaybackFaultTrace =
  | Readonly<{ type: "COMMAND"; receipt: CommandReceipt }>
  | Readonly<{ type: "STAGE_APPLY"; outcome: StageApplyOutcome }>
  | Readonly<{ type: "RESTART" }>
  | Readonly<{ type: "STAGE_STATUS"; status: StageStatus }>
  | Readonly<{ type: "TAKEOVER"; lease: PlaybackControlLease }>;

export type PlaybackScheduleResult = Readonly<{
  state: PlaybackAuthorityState;
  trace: readonly PlaybackFaultTrace[];
}>;

export function runPlaybackFaultSchedule(
  initial: PlaybackAuthorityState,
  actions: readonly PlaybackFaultAction[],
  nowMs = 1_700_000_000_000,
): PlaybackScheduleResult {
  let state = initial;
  const trace: PlaybackFaultTrace[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "COMMAND": {
        const reduction = reducePlaybackCommand(state, action.command, nowMs);
        state = reduction.state;
        trace.push({ type: "COMMAND", receipt: reduction.receipt });
        break;
      }
      case "STAGE_APPLY": {
        const application = markStageApplied(state, action.commandId, action.displayBindingEpoch);
        state = application.state;
        trace.push({ type: "STAGE_APPLY", outcome: application.outcome });
        break;
      }
      case "RESTART":
        state = restorePlaybackAuthority(snapshotPlaybackAuthority(state));
        trace.push({ type: "RESTART" });
        break;
      case "STAGE_STATUS":
        state = { ...state, stageStatus: action.status };
        trace.push({ type: "STAGE_STATUS", status: action.status });
        break;
      case "TAKEOVER":
        state = replacePlaybackLease(state, action.lease);
        trace.push({ type: "TAKEOVER", lease: action.lease });
        break;
    }
  }
  return { state, trace };
}

export type PublicProjectionFaultAction =
  | Readonly<{ type: "EVENT"; event: PublicPlaybackEvent }>
  | Readonly<{ type: "SNAPSHOT"; snapshot: PublicPlaybackSnapshot }>
  | Readonly<{ type: "PARTITION"; active: boolean }>
  | Readonly<{ type: "RESTART" }>;

export type PublicProjectionFaultTrace =
  | Readonly<{ type: "EVENT"; outcome: PublicPlaybackOutcome | "DROPPED_BY_PARTITION" }>
  | Readonly<{ type: "SNAPSHOT"; outcome: PublicPlaybackOutcome }>
  | Readonly<{ type: "PARTITION"; active: boolean }>
  | Readonly<{ type: "RESTART" }>;

export type PublicProjectionScheduleResult = Readonly<{
  state: PublicPlaybackState;
  trace: readonly PublicProjectionFaultTrace[];
}>;

export function runPublicProjectionFaultSchedule(
  initial: PublicPlaybackState,
  actions: readonly PublicProjectionFaultAction[],
): PublicProjectionScheduleResult {
  let state = initial;
  let partitioned = false;
  const trace: PublicProjectionFaultTrace[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "EVENT": {
        if (partitioned) {
          trace.push({ type: "EVENT", outcome: "DROPPED_BY_PARTITION" });
          break;
        }
        const result = applyPublicPlaybackEvent(state, action.event);
        state = result.state;
        trace.push({ type: "EVENT", outcome: result.outcome });
        break;
      }
      case "SNAPSHOT": {
        const result = applyPublicPlaybackSnapshot(state, action.snapshot);
        state = result.state;
        trace.push({ type: "SNAPSHOT", outcome: result.outcome });
        break;
      }
      case "PARTITION":
        partitioned = action.active;
        trace.push({ type: "PARTITION", active: partitioned });
        break;
      case "RESTART":
        state = structuredClone(state);
        trace.push({ type: "RESTART" });
        break;
    }
  }
  return { state, trace };
}
