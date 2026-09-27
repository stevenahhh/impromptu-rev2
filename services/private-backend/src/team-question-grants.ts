import type {
  AccountId,
  PresentationSessionId,
  TeamQuestionGrantId,
  TeamQuestionId,
} from "@impromptu/contracts/private";

/**
 * Question-only teammate grant and inbox persistence seam (plan task 8).
 *
 * A grant is owned by one tenant (the owner's account id), pinned to one presentation
 * session, and targeted at exactly one teammate account. The store keeps only the
 * invitation token's digest, honors caller-supplied idempotency keys for issue and
 * question writes, and re-checks grant liveness adjacent to every conditional write.
 * Implementations are the atomicity boundary: in-memory check-and-set completes inside
 * one synchronous turn; the PostgreSQL store locks the grant row in its transaction.
 */

export type StoredTeamQuestionGrant = Readonly<{
  grantId: TeamQuestionGrantId;
  tenantAccountId: AccountId;
  presentationSessionId: PresentationSessionId;
  ownerAccountId: AccountId;
  teammateAccountId: AccountId;
  teammateUsername: string;
  invitationTokenDigest: string;
  idempotencyKey: string;
  revocationRevision: number;
  createdAtMs: number;
  expiresAtMs: number;
  acceptedAtMs: number | null;
  revokedAtMs: number | null;
}>;

export type StoredTeamQuestion = Readonly<{
  questionId: TeamQuestionId;
  tenantAccountId: AccountId;
  presentationSessionId: PresentationSessionId;
  grantId: TeamQuestionGrantId;
  submittedByAccountId: AccountId;
  teammateUsername: string;
  questionText: string;
  idempotencyKey: string;
  submittedAtMs: number;
  questionSeq: number;
}>;

export type CreateGrantResult =
  | Readonly<{ outcome: "CREATED"; grant: StoredTeamQuestionGrant }>
  | Readonly<{ outcome: "IDEMPOTENT_REPLAY"; grant: StoredTeamQuestionGrant }>
  | Readonly<{ outcome: "REJECTED"; reason: "IDEMPOTENCY_CONFLICT" }>;

export type AcceptGrantResult =
  | Readonly<{ outcome: "ACCEPTED"; grant: StoredTeamQuestionGrant }>
  | Readonly<{
      outcome: "REJECTED";
      reason: "GRANT_ALREADY_ACCEPTED" | "GRANT_REVOKED" | "GRANT_EXPIRED";
    }>;

export type RevokeGrantResult =
  | Readonly<{ outcome: "REVOKED"; grant: StoredTeamQuestionGrant }>
  | Readonly<{ outcome: "ALREADY_REVOKED"; grant: StoredTeamQuestionGrant }>
  | Readonly<{ outcome: "REJECTED"; reason: "GRANT_UNKNOWN" }>;

export type AppendQuestionRejection =
  | "GRANT_UNKNOWN"
  | "GRANT_NOT_FOR_CALLER"
  | "GRANT_NOT_ACCEPTED"
  | "GRANT_REVOKED"
  | "GRANT_EXPIRED"
  | "IDEMPOTENCY_CONFLICT";

export type AppendQuestionResult =
  | Readonly<{ outcome: "APPENDED"; question: StoredTeamQuestion }>
  | Readonly<{ outcome: "DUPLICATE"; question: StoredTeamQuestion }>
  | Readonly<{ outcome: "REJECTED"; reason: AppendQuestionRejection }>;

export interface TeamQuestionStore {
  createGrant(grant: StoredTeamQuestionGrant): Promise<CreateGrantResult>;
  /** Owner-scoped lookup: the tenant is the caller's own account. */
  findGrant(tenantAccountId: string, grantId: string): Promise<StoredTeamQuestionGrant | null>;
  /**
   * Teammate-scoped lookup before the owner tenant context exists: resolves only grants
   * targeted at `teammateAccountId`, never a generic cross-tenant scan.
   */
  findGrantForTeammate(
    teammateAccountId: string,
    grantId: string,
  ): Promise<StoredTeamQuestionGrant | null>;
  /** Invitation redemption is also teammate-scoped: digest plus the resolved account id. */
  findGrantByInvitationDigest(
    teammateAccountId: string,
    invitationTokenDigest: string,
  ): Promise<StoredTeamQuestionGrant | null>;
  /** Conditional first-accept write; loses to a concurrent acceptance or revocation. */
  acceptGrant(
    grant: Readonly<{
      tenantAccountId: string;
      grantId: string;
      teammateAccountId: string;
    }>,
    nowMs: number,
  ): Promise<AcceptGrantResult>;
  /** Owner-scoped conditional revoke; bumps `revocationRevision` exactly once. */
  revokeGrant(tenantAccountId: string, grantId: string, nowMs: number): Promise<RevokeGrantResult>;
  /**
   * Append-only inbox write. The grant's active state (accepted, unrevoked, unexpired,
   * targeted at the caller) is re-verified atomically with the insert.
   */
  appendQuestion(
    input: Readonly<{
      grantId: string;
      submitterAccountId: string;
      questionId: string;
      questionText: string;
      idempotencyKey: string;
      nowMs: number;
    }>,
  ): Promise<AppendQuestionResult>;
  /** Owner-scoped reads; implementations must never return another tenant's rows. */
  listGrants(
    tenantAccountId: string,
    presentationSessionId: string,
  ): Promise<readonly StoredTeamQuestionGrant[]>;
  readInbox(
    tenantAccountId: string,
    presentationSessionId: string,
  ): Promise<readonly StoredTeamQuestion[]>;
}

export function createInMemoryTeamQuestionStore(
  grants: Map<string, StoredTeamQuestionGrant> = new Map(),
  questions: Map<string, StoredTeamQuestion> = new Map(),
): TeamQuestionStore {
  const grantKeysByIdempotency = new Map<string, TeamQuestionGrantId>();
  const questionKeysByIdempotency = new Map<string, TeamQuestionId>();
  let questionSequence = 0;

  return {
    async createGrant(grant) {
      const idempotencyKey = `${grant.ownerAccountId}${grant.idempotencyKey}`;
      const existingId = grantKeysByIdempotency.get(idempotencyKey);
      if (existingId !== undefined) {
        const existing = grants.get(existingId);
        if (
          existing !== undefined &&
          existing.teammateAccountId === grant.teammateAccountId &&
          existing.presentationSessionId === grant.presentationSessionId
        ) {
          return { outcome: "IDEMPOTENT_REPLAY", grant: existing };
        }
        return { outcome: "REJECTED", reason: "IDEMPOTENCY_CONFLICT" };
      }
      grants.set(grant.grantId, grant);
      grantKeysByIdempotency.set(idempotencyKey, grant.grantId);
      return { outcome: "CREATED", grant };
    },

    async findGrant(tenantAccountId, grantId) {
      const grant = grants.get(grantId as TeamQuestionGrantId);
      return grant !== undefined && grant.tenantAccountId === tenantAccountId ? grant : null;
    },

    async findGrantForTeammate(teammateAccountId, grantId) {
      const grant = grants.get(grantId as TeamQuestionGrantId);
      return grant !== undefined && grant.teammateAccountId === teammateAccountId ? grant : null;
    },

    async findGrantByInvitationDigest(teammateAccountId, invitationTokenDigest) {
      for (const grant of grants.values()) {
        if (
          grant.teammateAccountId === teammateAccountId &&
          grant.invitationTokenDigest === invitationTokenDigest
        ) {
          return grant;
        }
      }
      return null;
    },

    async acceptGrant(target, nowMs) {
      // No await between check and set: the conditional accept is atomic in this turn.
      const grant = grants.get(target.grantId as TeamQuestionGrantId);
      if (
        grant === undefined ||
        grant.tenantAccountId !== target.tenantAccountId ||
        grant.teammateAccountId !== target.teammateAccountId
      ) {
        return { outcome: "REJECTED", reason: "GRANT_ALREADY_ACCEPTED" };
      }
      if (grant.revokedAtMs !== null) return { outcome: "REJECTED", reason: "GRANT_REVOKED" };
      if (nowMs >= grant.expiresAtMs) return { outcome: "REJECTED", reason: "GRANT_EXPIRED" };
      if (grant.acceptedAtMs !== null) {
        return { outcome: "REJECTED", reason: "GRANT_ALREADY_ACCEPTED" };
      }
      const accepted: StoredTeamQuestionGrant = { ...grant, acceptedAtMs: nowMs };
      grants.set(grant.grantId, accepted);
      return { outcome: "ACCEPTED", grant: accepted };
    },

    async revokeGrant(tenantAccountId, grantId, nowMs) {
      const grant = grants.get(grantId as TeamQuestionGrantId);
      if (grant === undefined || grant.tenantAccountId !== tenantAccountId) {
        return { outcome: "REJECTED", reason: "GRANT_UNKNOWN" };
      }
      if (grant.revokedAtMs !== null) return { outcome: "ALREADY_REVOKED", grant };
      const revoked: StoredTeamQuestionGrant = {
        ...grant,
        revokedAtMs: nowMs,
        revocationRevision: grant.revocationRevision + 1,
      };
      grants.set(grant.grantId, revoked);
      return { outcome: "REVOKED", grant: revoked };
    },

    async appendQuestion(input) {
      // The full liveness gate sits inside this single turn: the grant aimed at the caller
      // must be accepted, unrevoked and unexpired at the instant the row is appended.
      const grant = grants.get(input.grantId as TeamQuestionGrantId);
      if (grant === undefined) return { outcome: "REJECTED", reason: "GRANT_UNKNOWN" };
      if (grant.teammateAccountId !== input.submitterAccountId) {
        return { outcome: "REJECTED", reason: "GRANT_NOT_FOR_CALLER" };
      }
      const idempotencyKey = `${grant.tenantAccountId}${grant.grantId}${input.idempotencyKey}`;
      const existingId = questionKeysByIdempotency.get(idempotencyKey);
      if (existingId !== undefined) {
        const existing = questions.get(existingId);
        if (
          existing !== undefined &&
          existing.questionText === input.questionText &&
          existing.submittedByAccountId === input.submitterAccountId
        ) {
          return { outcome: "DUPLICATE", question: existing };
        }
        return { outcome: "REJECTED", reason: "IDEMPOTENCY_CONFLICT" };
      }
      if (grant.revokedAtMs !== null) return { outcome: "REJECTED", reason: "GRANT_REVOKED" };
      if (grant.acceptedAtMs === null) {
        return { outcome: "REJECTED", reason: "GRANT_NOT_ACCEPTED" };
      }
      if (input.nowMs >= grant.expiresAtMs) {
        return { outcome: "REJECTED", reason: "GRANT_EXPIRED" };
      }
      questionSequence += 1;
      const question: StoredTeamQuestion = {
        questionId: input.questionId as TeamQuestionId,
        tenantAccountId: grant.tenantAccountId,
        presentationSessionId: grant.presentationSessionId,
        grantId: grant.grantId,
        submittedByAccountId: grant.teammateAccountId,
        teammateUsername: grant.teammateUsername,
        questionText: input.questionText,
        idempotencyKey: input.idempotencyKey,
        submittedAtMs: input.nowMs,
        questionSeq: questionSequence,
      };
      questions.set(question.questionId, question);
      questionKeysByIdempotency.set(idempotencyKey, question.questionId);
      return { outcome: "APPENDED", question };
    },

    async listGrants(tenantAccountId, presentationSessionId) {
      return [...grants.values()].filter(
        (grant) =>
          grant.tenantAccountId === tenantAccountId &&
          grant.presentationSessionId === presentationSessionId,
      );
    },

    async readInbox(tenantAccountId, presentationSessionId) {
      return [...questions.values()]
        .filter(
          (question) =>
            question.tenantAccountId === tenantAccountId &&
            question.presentationSessionId === presentationSessionId,
        )
        .sort((left, right) => left.questionSeq - right.questionSeq);
    },
  };
}
