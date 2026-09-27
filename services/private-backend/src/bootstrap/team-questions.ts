import {
  AcceptedTeamQuestionGrantSchema,
  AcceptTeamQuestionGrantRequestSchema,
  IssueTeamQuestionGrantRequestSchema,
  IssueTeamQuestionGrantResponseSchema,
  ReplayedTeamQuestionGrantSchema,
  SubmitTeamQuestionRequestSchema,
  TEAM_QUESTION_GRANT_TTL_MS,
  TeamQuestionGrantListSchema,
  type TeamQuestionGrantView,
  TeamQuestionGrantViewSchema,
  TeamQuestionInboxViewSchema,
  TeamQuestionReceiptSchema,
} from "@impromptu/contracts/private";
import type { TeamQuestionRouteDependencies } from "../http/routes/team-questions.ts";
import type { PreparedEvidenceCoordinator, PreparedEvidenceStore } from "../prepared-evidence.ts";
import type {
  StoredTeamQuestion,
  StoredTeamQuestionGrant,
  TeamQuestionStore,
} from "../team-question-grants.ts";

/**
 * Service seam for question-only teammate grants (plan task 8), mirroring
 * bootstrap/qa-defense.ts: the HTTP route sees only narrowly-shaped functions, never the
 * coordinator, store, or mutable presentation records.
 *
 * Authority rules implemented here:
 * - Owner operations (issue, revoke, list grants, read inbox) resolve the caller's account
 *   session and enforce presentation ownership; issue additionally requires an ACTIVE
 *   session, while revoke and reads deliberately allow ENDED sessions.
 * - Teammate operations (accept, submit) resolve the exact grant under the CALLER's
 *   authenticated account identity — invitation digest or grant id pinned to the caller —
 *   before any owner-tenant read or write happens.
 * - Grant liveness (accepted, unrevoked, unexpired) is re-verified adjacent to every write;
 *   the store repeats that check atomically inside its conditional write.
 * - Session end blocks teammate writes and new accepts immediately; already-recorded
 *   questions remain readable to the owner.
 */

export type TeamQuestionRejection = Readonly<{ outcome: "REJECTED"; reason: string }>;
export type TeamQuestionResult<Value> =
  | Readonly<{ outcome: "APPLIED"; value: Value }>
  | TeamQuestionRejection;

function opaqueHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function grantStatus(
  grant: Pick<StoredTeamQuestionGrant, "acceptedAtMs" | "revokedAtMs" | "expiresAtMs">,
  nowMs: number,
): "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED" {
  if (grant.revokedAtMs !== null) return "REVOKED";
  if (nowMs >= grant.expiresAtMs) return "EXPIRED";
  return grant.acceptedAtMs === null ? "PENDING" : "ACCEPTED";
}

function grantView(grant: StoredTeamQuestionGrant, nowMs: number): TeamQuestionGrantView {
  return TeamQuestionGrantViewSchema.parse({
    grantId: grant.grantId,
    presentationSessionId: grant.presentationSessionId,
    teammateAccountId: grant.teammateAccountId,
    teammateUsername: grant.teammateUsername,
    status: grantStatus(grant, nowMs),
    revocationRevision: grant.revocationRevision,
    expiresAtMs: grant.expiresAtMs,
    acceptedAtMs: grant.acceptedAtMs,
    revokedAtMs: grant.revokedAtMs,
  });
}

export function createTeamQuestions(options: {
  readonly store: PreparedEvidenceStore;
  readonly coordinator: PreparedEvidenceCoordinator;
  readonly questionStore: TeamQuestionStore;
  /** Resolves a username to its registered account; the directory's auth boundary shape. */
  readonly resolveAccount: (
    username: string,
  ) => Promise<Readonly<{ accountId: string; username: string }> | null>;
  /** Fixed lifetime for new grants; defaults to TEAM_QUESTION_GRANT_TTL_MS. */
  readonly grantTtlMs?: number;
  readonly now?: () => number;
}): TeamQuestionRouteDependencies {
  const now = options.now ?? Date.now;
  const grantTtlMs = options.grantTtlMs ?? TEAM_QUESTION_GRANT_TTL_MS;
  const { coordinator, questionStore } = options;

  type SessionResolution =
    | Readonly<{ outcome: "RESOLVED"; accountId: string }>
    | Readonly<{ outcome: "REJECTED"; reason: string }>;

  async function resolveSession(accountSessionId: string): Promise<SessionResolution> {
    const account = await coordinator.readAccountSession(accountSessionId, now());
    return account.outcome === "REJECTED"
      ? { outcome: "REJECTED", reason: account.reason }
      : { outcome: "RESOLVED", accountId: account.value.accountId };
  }

  type PresentationResolution =
    | Readonly<{
        outcome: "RESOLVED";
        accountId: string;
        lifecycle: { status: "ACTIVE" | "ENDED" };
      }>
    | Readonly<{ outcome: "REJECTED"; reason: "PRESENTATION_NOT_FOUND" | "UNAUTHORIZED" }>;

  /**
   * Owner resolution mirroring #authorizedPresentation with ONE deliberate deviation (the
   * same one resolveQaSession documents): ENDED presentations resolve instead of rejecting,
   * so each route can apply its own phase guard — issue requires ACTIVE, revoke and reads
   * remain available for review after the talk.
   */
  async function resolveOwnerPresentation(
    accountSessionId: string,
    presentationSessionId: string,
  ): Promise<PresentationResolution> {
    const session = await resolveSession(accountSessionId);
    if (session.outcome === "REJECTED") return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
    const presentation = options.store.presentations.get(presentationSessionId);
    if (presentation === undefined) {
      return { outcome: "REJECTED", reason: "PRESENTATION_NOT_FOUND" };
    }
    if (presentation.lifecycle.ownerAccountId !== session.accountId) {
      return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
    }
    return {
      outcome: "RESOLVED",
      accountId: session.accountId,
      lifecycle: presentation.lifecycle,
    };
  }

  return {
    async issueGrant(accountSessionId, rawBody) {
      const request = IssueTeamQuestionGrantRequestSchema.safeParse(rawBody);
      if (!request.success) return { outcome: "REJECTED", reason: "INVALID_REQUEST" };
      const authorized = await resolveOwnerPresentation(
        accountSessionId,
        request.data.presentationSessionId,
      );
      if (authorized.outcome === "REJECTED") return authorized;
      if (authorized.lifecycle.status !== "ACTIVE") {
        return { outcome: "REJECTED", reason: "PRESENTATION_ENDED" };
      }
      const teammate = await options.resolveAccount(request.data.teammateUsername);
      if (teammate === null) return { outcome: "REJECTED", reason: "TEAMMATE_UNKNOWN" };
      if (teammate.accountId === authorized.accountId) {
        return { outcome: "REJECTED", reason: "SELF_GRANT" };
      }
      const token = `tginv_${opaqueHex(32)}`;
      const created = await questionStore.createGrant({
        grantId: `tqg_${opaqueHex(16)}` as StoredTeamQuestionGrant["grantId"],
        tenantAccountId: authorized.accountId as StoredTeamQuestionGrant["tenantAccountId"],
        presentationSessionId: request.data.presentationSessionId,
        ownerAccountId: authorized.accountId as StoredTeamQuestionGrant["ownerAccountId"],
        teammateAccountId: teammate.accountId as StoredTeamQuestionGrant["teammateAccountId"],
        teammateUsername: teammate.username,
        invitationTokenDigest: sha256Hex(token),
        idempotencyKey: request.data.idempotencyKey,
        revocationRevision: 1,
        createdAtMs: now(),
        expiresAtMs: now() + grantTtlMs,
        acceptedAtMs: null,
        revokedAtMs: null,
      });
      if (created.outcome === "IDEMPOTENT_REPLAY") {
        return {
          outcome: "APPLIED",
          value: ReplayedTeamQuestionGrantSchema.parse({
            ...grantView(created.grant, now()),
            duplicate: true as const,
          }),
        };
      }
      if (created.outcome === "REJECTED") return created;
      return {
        outcome: "APPLIED",
        value: IssueTeamQuestionGrantResponseSchema.parse({
          ...grantView(created.grant, now()),
          invitationToken: token,
        }),
      };
    },

    async revokeGrant(accountSessionId, grantId) {
      const session = await resolveSession(accountSessionId);
      if (session.outcome === "REJECTED") return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
      const revoked = await questionStore.revokeGrant(session.accountId, grantId, now());
      if (revoked.outcome === "REJECTED") return revoked;
      return { outcome: "APPLIED", value: grantView(revoked.grant, now()) };
    },

    async acceptGrant(accountSessionId, rawBody) {
      const request = AcceptTeamQuestionGrantRequestSchema.safeParse(rawBody);
      if (!request.success) return { outcome: "REJECTED", reason: "INVALID_REQUEST" };
      const session = await resolveSession(accountSessionId);
      if (session.outcome === "REJECTED") return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
      // Teammate-scoped resolution under the caller's authenticated account identity; a
      // stranger's token can never enumerate or claim another account's grant.
      const grant = await questionStore.findGrantByInvitationDigest(
        session.accountId,
        sha256Hex(request.data.invitationToken),
      );
      if (grant === null) return { outcome: "REJECTED", reason: "INVITATION_UNKNOWN" };
      // Session end blocks acceptance immediately, adjacent to the grant write.
      const presentation = options.store.presentations.get(grant.presentationSessionId);
      if (presentation === undefined || presentation.lifecycle.status !== "ACTIVE") {
        return { outcome: "REJECTED", reason: "PRESENTATION_ENDED" };
      }
      const accepted = await questionStore.acceptGrant(
        {
          tenantAccountId: grant.tenantAccountId,
          grantId: grant.grantId,
          teammateAccountId: session.accountId,
        },
        now(),
      );
      if (accepted.outcome === "REJECTED") return accepted;
      return {
        outcome: "APPLIED",
        value: AcceptedTeamQuestionGrantSchema.parse({
          grantId: accepted.grant.grantId,
          presentationSessionId: accepted.grant.presentationSessionId,
          expiresAtMs: accepted.grant.expiresAtMs,
        }),
      };
    },

    async submitQuestion(accountSessionId, rawBody) {
      const request = SubmitTeamQuestionRequestSchema.safeParse(rawBody);
      if (!request.success) return { outcome: "REJECTED", reason: "INVALID_REQUEST" };
      const session = await resolveSession(accountSessionId);
      if (session.outcome === "REJECTED") return { outcome: "REJECTED", reason: "UNAUTHORIZED" };
      // The exact grant is resolved under the caller's account identity before any
      // owner-tenant read or write.
      const grant = await questionStore.findGrantForTeammate(
        session.accountId,
        request.data.grantId,
      );
      if (grant === null) return { outcome: "REJECTED", reason: "GRANT_UNKNOWN" };
      if (grant.revokedAtMs !== null) return { outcome: "REJECTED", reason: "GRANT_REVOKED" };
      if (grant.acceptedAtMs === null) {
        return { outcome: "REJECTED", reason: "GRANT_NOT_ACCEPTED" };
      }
      if (now() >= grant.expiresAtMs) return { outcome: "REJECTED", reason: "GRANT_EXPIRED" };
      // Revocation and session end block the teammate adjacent to the write; the store
      // repeats the grant-liveness check atomically inside its conditional append.
      const presentation = options.store.presentations.get(grant.presentationSessionId);
      if (presentation === undefined || presentation.lifecycle.status !== "ACTIVE") {
        return { outcome: "REJECTED", reason: "PRESENTATION_ENDED" };
      }
      const appended = await questionStore.appendQuestion({
        grantId: grant.grantId,
        submitterAccountId: session.accountId,
        questionId: `tqq_${opaqueHex(16)}`,
        questionText: request.data.questionText,
        idempotencyKey: request.data.idempotencyKey,
        nowMs: now(),
      });
      if (appended.outcome === "REJECTED") return appended;
      return {
        outcome: "APPLIED",
        value: TeamQuestionReceiptSchema.parse({
          questionId: appended.question.questionId,
          grantId: appended.question.grantId,
          submittedAtMs: appended.question.submittedAtMs,
          duplicate: appended.outcome === "DUPLICATE",
        }),
      };
    },

    async readInbox(accountSessionId, presentationSessionId) {
      const authorized = await resolveOwnerPresentation(accountSessionId, presentationSessionId);
      if (authorized.outcome === "REJECTED") return authorized;
      const questions = await questionStore.readInbox(authorized.accountId, presentationSessionId);
      return {
        outcome: "APPLIED",
        value: TeamQuestionInboxViewSchema.parse({
          presentationSessionId,
          questions: questions.map((question: StoredTeamQuestion) => ({
            questionId: question.questionId,
            grantId: question.grantId,
            teammateAccountId: question.submittedByAccountId,
            teammateUsername: question.teammateUsername,
            questionText: question.questionText,
            submittedAtMs: question.submittedAtMs,
            questionSeq: question.questionSeq,
          })),
        }),
      };
    },

    async listGrants(accountSessionId, presentationSessionId) {
      const authorized = await resolveOwnerPresentation(accountSessionId, presentationSessionId);
      if (authorized.outcome === "REJECTED") return authorized;
      const grants = await questionStore.listGrants(authorized.accountId, presentationSessionId);
      return {
        outcome: "APPLIED",
        value: TeamQuestionGrantListSchema.parse({
          presentationSessionId,
          grants: grants.map((grant) => grantView(grant, now())),
        }),
      };
    },
  };
}
