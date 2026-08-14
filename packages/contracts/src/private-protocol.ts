import { z } from "zod";
import { TimestampMsSchema, VersionIdSchema } from "./common.ts";
import { ControllerSessionSchema, ControllerSnapshotSchema } from "./control.ts";
import { ActorIdSchema } from "./control-identifiers.ts";
import {
  CaptureDeviceIdSchema,
  CaptureGrantIdSchema,
  ConsentRecordIdSchema,
  PublicationAuthorityIdSchema,
} from "./private-identifiers.ts";
import { PublicCardRevisionSchema } from "./public-identifiers.ts";
import { AudienceSnapshotSchema, PublicStageSessionSchema } from "./public-protocol.ts";
import { EvidenceCandidateSchema } from "./publication.ts";
import {
  PresentationSessionEpochSchema,
  PresentationSessionIdSchema,
} from "./session-identifiers.ts";

const SessionIdentityShape = {
  presentationSessionId: PresentationSessionIdSchema,
  presentationSessionEpoch: PresentationSessionEpochSchema,
} as const;

export const PublicationAuthoritySchema = z
  .object({
    authorityId: PublicationAuthorityIdSchema,
    ...SessionIdentityShape,
    actorId: ActorIdSchema,
    policyVersion: VersionIdSchema,
    expiresAtMs: TimestampMsSchema,
  })
  .strict();

export const CaptureGrantSchema = z
  .object({
    captureGrantId: CaptureGrantIdSchema,
    ...SessionIdentityShape,
    actorId: ActorIdSchema,
    captureDeviceId: CaptureDeviceIdSchema,
    consentRecordId: ConsentRecordIdSchema,
    expiresAtMs: TimestampMsSchema,
  })
  .strict();

export const PublisherSessionSchema = z
  .object({
    role: z.literal("PUBLISHER"),
    ...SessionIdentityShape,
    actorId: ActorIdSchema,
    authority: PublicationAuthoritySchema,
  })
  .strict();

export const PublisherSnapshotSchema = z
  .object({
    role: z.literal("PUBLISHER"),
    ...SessionIdentityShape,
    publicCardRevision: PublicCardRevisionSchema,
    candidates: z.array(EvidenceCandidateSchema),
  })
  .strict();

export const RoleSessionSchema = z.discriminatedUnion("role", [
  ControllerSessionSchema,
  PublicStageSessionSchema,
  PublisherSessionSchema,
]);
export const RoleSnapshotSchema = z.discriminatedUnion("role", [
  ControllerSnapshotSchema,
  AudienceSnapshotSchema,
  PublisherSnapshotSchema,
]);

export function authorizeRoleSnapshot(role: unknown, snapshot: unknown): boolean {
  const parsedSnapshot = RoleSnapshotSchema.safeParse(snapshot);
  return parsedSnapshot.success && parsedSnapshot.data.role === role;
}

export type PublicationAuthority = z.infer<typeof PublicationAuthoritySchema>;
export type CaptureGrant = z.infer<typeof CaptureGrantSchema>;
export type PublisherSession = z.infer<typeof PublisherSessionSchema>;
export type PublisherSnapshot = z.infer<typeof PublisherSnapshotSchema>;
export type RoleSession = z.infer<typeof RoleSessionSchema>;
export type RoleSnapshot = z.infer<typeof RoleSnapshotSchema>;
