/**
 * Session-scoped identity and chained-write tracker types shared by the finalizer's live write
 * paths. A per-session key namespaces every memo; a tracker serializes writes and remembers the
 * first failure so end-time draining can refuse to finalize over missing data.
 */
import type { SessionReportPrincipal } from "./postgres-session-report-repository.ts";

export type ActiveVisit = Readonly<{
  principal: SessionReportPrincipal;
  presentationSessionEpoch: number;
  sequence: number;
  publicSlideKey: string;
  enteredOffsetMs: number;
  producerId: string;
}>;

export type VisitTracker = {
  active: ActiveVisit | null;
  writes: Promise<void>;
  failure: unknown | null;
};

export type QaWriteTracker = {
  writes: Promise<void>;
  failure: unknown | null;
};

export function sessionKey(principal: SessionReportPrincipal): string {
  return `${principal.tenantId}\u0000${principal.presentationSessionId}\u0000${principal.ownerSubject}`;
}

export function samePrincipal(
  left: SessionReportPrincipal,
  right: SessionReportPrincipal,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.presentationSessionId === right.presentationSessionId &&
    left.ownerSubject === right.ownerSubject
  );
}
