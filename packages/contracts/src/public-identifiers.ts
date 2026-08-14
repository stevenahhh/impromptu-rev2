import type { z } from "zod";
import { encodedCounter, encodedCounterValue, prefixedId } from "./identity-base.ts";

export const DisplayIdSchema = prefixedId<"DisplayId">("display_");
export const DisplayBindingIdSchema = prefixedId<"DisplayBindingId">("binding_");
export const AudienceDisplaySessionIdSchema = prefixedId<"AudienceDisplaySessionId">("audience_");
export const ProjectionIdSchema = prefixedId<"ProjectionId">("projection_");
export const DeckVersionIdSchema = prefixedId<"DeckVersionId">("deck_");
export const PublicSlideKeySchema = prefixedId<"PublicSlideKey">("slide_");
export const DisplayBindingEpochSchema = encodedCounter<"DisplayBindingEpoch">("dbe_");
export const PublicPlaybackRevisionSchema = encodedCounter<"PublicPlaybackRevision">("pbr_");
export const PublicCardRevisionSchema = encodedCounter<"PublicCardRevision">("pcr_");

export type DisplayId = z.infer<typeof DisplayIdSchema>;
export type DisplayBindingId = z.infer<typeof DisplayBindingIdSchema>;
export type AudienceDisplaySessionId = z.infer<typeof AudienceDisplaySessionIdSchema>;
export type ProjectionId = z.infer<typeof ProjectionIdSchema>;
export type DeckVersionId = z.infer<typeof DeckVersionIdSchema>;
export type PublicSlideKey = z.infer<typeof PublicSlideKeySchema>;
export type DisplayBindingEpoch = z.infer<typeof DisplayBindingEpochSchema>;
export type PublicPlaybackRevision = z.infer<typeof PublicPlaybackRevisionSchema>;
export type PublicCardRevision = z.infer<typeof PublicCardRevisionSchema>;

export function displayBindingEpoch(value: number): DisplayBindingEpoch {
  return DisplayBindingEpochSchema.parse(`dbe_${value}`);
}

export function publicPlaybackRevision(value: number): PublicPlaybackRevision {
  return PublicPlaybackRevisionSchema.parse(`pbr_${value}`);
}

export function publicPlaybackRevisionValue(value: PublicPlaybackRevision): number {
  return encodedCounterValue(value);
}

export function nextPublicPlaybackRevision(value: PublicPlaybackRevision): PublicPlaybackRevision {
  return publicPlaybackRevision(publicPlaybackRevisionValue(value) + 1);
}

export function publicCardRevision(value: number): PublicCardRevision {
  return PublicCardRevisionSchema.parse(`pcr_${value}`);
}

export function publicCardRevisionValue(value: PublicCardRevision): number {
  return encodedCounterValue(value);
}
