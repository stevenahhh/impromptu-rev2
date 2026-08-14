import type { z } from "zod";
import { encodedCounter, encodedCounterValue, prefixedId } from "./identity-base.ts";

export const PresentationSessionIdSchema = prefixedId<"PresentationSessionId">("ps_");
export const PresentationSessionEpochSchema = encodedCounter<"PresentationSessionEpoch">("pse_");

export type PresentationSessionId = z.infer<typeof PresentationSessionIdSchema>;
export type PresentationSessionEpoch = z.infer<typeof PresentationSessionEpochSchema>;

export function presentationSessionEpoch(value: number): PresentationSessionEpoch {
  return PresentationSessionEpochSchema.parse(`pse_${value}`);
}

export function presentationSessionEpochValue(value: PresentationSessionEpoch): number {
  return encodedCounterValue(value);
}
