import type { z } from "zod";
import { encodedCounter, encodedCounterValue, prefixedId } from "./identity-base.ts";

export const ActorIdSchema = prefixedId<"ActorId">("actor_");
export const PlaybackControlLeaseIdSchema = prefixedId<"PlaybackControlLeaseId">("lease_");
export const CommandIdSchema = prefixedId<"CommandId">("cmd_");
export const ControllerEpochSchema = encodedCounter<"ControllerEpoch">("ce_");
export const ControlRevisionSchema = encodedCounter<"ControlRevision">("cr_");

export type ActorId = z.infer<typeof ActorIdSchema>;
export type PlaybackControlLeaseId = z.infer<typeof PlaybackControlLeaseIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type ControllerEpoch = z.infer<typeof ControllerEpochSchema>;
export type ControlRevision = z.infer<typeof ControlRevisionSchema>;

export function controllerEpoch(value: number): ControllerEpoch {
  return ControllerEpochSchema.parse(`ce_${value}`);
}

export function controlRevision(value: number): ControlRevision {
  return ControlRevisionSchema.parse(`cr_${value}`);
}

export function controlRevisionValue(value: ControlRevision): number {
  return encodedCounterValue(value);
}

export function nextControlRevision(value: ControlRevision): ControlRevision {
  return controlRevision(controlRevisionValue(value) + 1);
}
