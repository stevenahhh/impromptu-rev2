import type { z } from "zod";
import { prefixedId } from "./identity-base.ts";

export const PublicationAuthorityIdSchema = prefixedId<"PublicationAuthorityId">("pubauth_");
export const CaptureGrantIdSchema = prefixedId<"CaptureGrantId">("capture_");
export const CandidateIdSchema = prefixedId<"CandidateId">("candidate_");
export const CaptureDeviceIdSchema = prefixedId<"CaptureDeviceId">("device_");
export const ConsentRecordIdSchema = prefixedId<"ConsentRecordId">("consent_");
export const TranscriptFinalIdSchema = prefixedId<"TranscriptFinalId">("transcript_");
export const SourceIdSchema = prefixedId<"SourceId">("source_");
export const PrivateDeckIdSchema = prefixedId<"PrivateDeckId">("private_deck_");
export const PrivateSlideIdSchema = prefixedId<"PrivateSlideId">("private_slide_");
export const AccountIdSchema = prefixedId<"AccountId">("account_");
export const PrivateAssetIdSchema = prefixedId<"PrivateAssetId">("asset_");

export type PublicationAuthorityId = z.infer<typeof PublicationAuthorityIdSchema>;
export type CaptureGrantId = z.infer<typeof CaptureGrantIdSchema>;
export type CandidateId = z.infer<typeof CandidateIdSchema>;
export type CaptureDeviceId = z.infer<typeof CaptureDeviceIdSchema>;
export type ConsentRecordId = z.infer<typeof ConsentRecordIdSchema>;
export type TranscriptFinalId = z.infer<typeof TranscriptFinalIdSchema>;
export type SourceId = z.infer<typeof SourceIdSchema>;
export type PrivateDeckId = z.infer<typeof PrivateDeckIdSchema>;
export type PrivateSlideId = z.infer<typeof PrivateSlideIdSchema>;
export type AccountId = z.infer<typeof AccountIdSchema>;
export type PrivateAssetId = z.infer<typeof PrivateAssetIdSchema>;
