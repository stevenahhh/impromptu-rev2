import type { Sql } from "postgres";

import {
  presentationSessionUuid,
  tenantUuidForAccount,
} from "./report/provisioned-session-report-repository.ts";
import type {
  AcceptGrantResult,
  AppendQuestionResult,
  CreateGrantResult,
  RevokeGrantResult,
  StoredTeamQuestion,
  StoredTeamQuestionGrant,
  TeamQuestionStore,
} from "./team-question-grants.ts";

/**
 * PostgreSQL-backed team question store (plan task 8).
 *
 * Tenant mapping reuses the provisioned-report identity rules: the owner's account id is
 * the tenant (`tenantUuidForAccount`), and `ps_`-prefixed session ids re-encode into the
 * uuid column losslessly. Teammate-scoped reads happen under `app.actor_account_id`, the
 * GUC the `teammate_target` RLS policy is pinned to — the caller's authenticated account
 * id, set inside the transaction before the owner tenant context exists. Every write then
 * runs under `app.tenant_id` scoped to the grant's own tenant, so RLS admits only rows the
 * owner tenant itself may touch.
 */

type GrantRow = Readonly<{
  grant_id: string;
  tenant_id: string;
  session_id: string;
  owner_account_id: string;
  teammate_account_id: string;
  teammate_username: string;
  invitation_digest: string;
  idempotency_key: string;
  revocation_revision: number | string | bigint;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}>;

type QuestionRow = Readonly<{
  question_id: string;
  session_id: string;
  grant_id: string;
  submitted_by_account_id: string;
  question: string;
  idempotency_key: string;
  question_seq: number | string | bigint;
  created_at: Date;
}>;

type InboxRow = QuestionRow & Readonly<{ teammate_username: string }>;

function safeInteger(value: number | string | bigint, column: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`team question store ${column} is not a safe integer`);
  }
  return parsed;
}

function sessionIdFromUuid(sessionUuid: string): string {
  return `ps_${sessionUuid.replaceAll("-", "")}`;
}

function grantFromRow(row: GrantRow): StoredTeamQuestionGrant {
  return {
    grantId: row.grant_id as StoredTeamQuestionGrant["grantId"],
    tenantAccountId: row.owner_account_id as StoredTeamQuestionGrant["tenantAccountId"],
    presentationSessionId: sessionIdFromUuid(
      row.session_id,
    ) as StoredTeamQuestionGrant["presentationSessionId"],
    ownerAccountId: row.owner_account_id as StoredTeamQuestionGrant["ownerAccountId"],
    teammateAccountId: row.teammate_account_id as StoredTeamQuestionGrant["teammateAccountId"],
    teammateUsername: row.teammate_username,
    invitationTokenDigest: row.invitation_digest,
    idempotencyKey: row.idempotency_key,
    revocationRevision: safeInteger(row.revocation_revision, "revocation_revision"),
    createdAtMs: row.created_at.getTime(),
    expiresAtMs: row.expires_at.getTime(),
    acceptedAtMs: row.accepted_at?.getTime() ?? null,
    revokedAtMs: row.revoked_at?.getTime() ?? null,
  };
}

function questionFromRow(
  row: QuestionRow & Partial<Readonly<{ teammate_username: string }>>,
  ownerAccountId: string,
  fallbackTeammateUsername: string,
): StoredTeamQuestion {
  return {
    questionId: row.question_id as StoredTeamQuestion["questionId"],
    tenantAccountId: ownerAccountId as StoredTeamQuestion["tenantAccountId"],
    presentationSessionId: sessionIdFromUuid(
      row.session_id,
    ) as StoredTeamQuestion["presentationSessionId"],
    grantId: row.grant_id as StoredTeamQuestion["grantId"],
    submittedByAccountId: row.submitted_by_account_id as StoredTeamQuestion["submittedByAccountId"],
    teammateUsername: row.teammate_username ?? fallbackTeammateUsername,
    questionText: row.question,
    idempotencyKey: row.idempotency_key,
    submittedAtMs: row.created_at.getTime(),
    questionSeq: safeInteger(row.question_seq, "question_seq"),
  };
}

async function establishActorAccount(sql: Sql, accountId: string): Promise<void> {
  await sql`SELECT set_config('app.actor_account_id', ${accountId}, true)`;
}

async function establishTenant(sql: Sql, tenantAccountId: string): Promise<void> {
  await sql`SELECT set_config('app.tenant_id', ${tenantUuidForAccount(tenantAccountId)}, true)`;
}

/**
 * Creates the tenant and presentation_session parent rows the FK chain requires, the same
 * provisioning the session-report repository performs for its own tables.
 */
async function ensureOwningRows(
  sql: Sql,
  grant: Pick<
    StoredTeamQuestionGrant,
    "tenantAccountId" | "presentationSessionId" | "ownerAccountId"
  >,
): Promise<void> {
  const tenantId = tenantUuidForAccount(grant.tenantAccountId);
  const sessionId = presentationSessionUuid(grant.presentationSessionId);
  await sql`
    INSERT INTO private_app.tenants (tenant_id, display_name)
    VALUES (${tenantId}::uuid, ${grant.tenantAccountId})
    ON CONFLICT (tenant_id) DO NOTHING
  `;
  await sql`
    INSERT INTO private_app.presentation_sessions (
      tenant_id,
      session_id,
      owner_subject,
      presentation_session_epoch,
      deck_storage_uri
    )
    VALUES (
      ${tenantId}::uuid,
      ${sessionId}::uuid,
      ${grant.ownerAccountId},
      1,
      ${`deck://${grant.presentationSessionId}`}
    )
    ON CONFLICT (tenant_id, session_id) DO NOTHING
  `;
}

export function createPostgresTeamQuestionStore(sql: Sql): TeamQuestionStore {
  return {
    async createGrant(grant): Promise<CreateGrantResult> {
      const tenantId = tenantUuidForAccount(grant.tenantAccountId);
      const sessionId = presentationSessionUuid(grant.presentationSessionId);
      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, grant.tenantAccountId);
        await ensureOwningRows(transactionSql, grant);
        const inserted = await transactionSql<readonly GrantRow[]>`
          INSERT INTO private_app.team_question_grants (
            tenant_id, session_id, grant_id, owner_account_id, teammate_account_id,
            teammate_username, invitation_digest, idempotency_key, revocation_revision,
            created_at, expires_at
          ) VALUES (
            ${tenantId}::uuid, ${sessionId}::uuid, ${grant.grantId},
            ${grant.ownerAccountId}, ${grant.teammateAccountId},
            ${grant.teammateUsername}, ${grant.invitationTokenDigest},
            ${grant.idempotencyKey}, ${grant.revocationRevision},
            ${new Date(grant.createdAtMs)}, ${new Date(grant.expiresAtMs)}
          )
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
          RETURNING
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
        `;
        const row = inserted[0];
        if (row !== undefined) {
          return { outcome: "CREATED", grant: grantFromRow(row) };
        }
        const existing = await transactionSql<readonly GrantRow[]>`
          SELECT
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
          FROM private_app.team_question_grants
          WHERE tenant_id = ${tenantId}::uuid
            AND idempotency_key = ${grant.idempotencyKey}
        `;
        const existingRow = existing[0];
        if (existingRow === undefined) {
          throw new Error("team question grant insert raced and no idempotent row exists");
        }
        const grantRead = grantFromRow(existingRow);
        if (
          grantRead.teammateAccountId === grant.teammateAccountId &&
          grantRead.presentationSessionId === grant.presentationSessionId
        ) {
          return { outcome: "IDEMPOTENT_REPLAY", grant: grantRead };
        }
        return { outcome: "REJECTED", reason: "IDEMPOTENCY_CONFLICT" };
      });
    },

    async findGrant(tenantAccountId, grantId) {
      const tenantId = tenantUuidForAccount(tenantAccountId);
      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, tenantAccountId);
        const rows = await transactionSql<readonly GrantRow[]>`
          SELECT
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
          FROM private_app.team_question_grants
          WHERE tenant_id = ${tenantId}::uuid AND grant_id = ${grantId}
        `;
        const row = rows[0];
        return row === undefined ? null : grantFromRow(row);
      });
    },

    async findGrantForTeammate(teammateAccountId, grantId) {
      return await sql.begin(async (transactionSql) => {
        await establishActorAccount(transactionSql, teammateAccountId);
        const rows = await transactionSql<readonly GrantRow[]>`
          SELECT
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
          FROM private_app.team_question_grants
          WHERE grant_id = ${grantId}
            AND teammate_account_id = ${teammateAccountId}
        `;
        const row = rows[0];
        return row === undefined ? null : grantFromRow(row);
      });
    },

    async findGrantByInvitationDigest(teammateAccountId, invitationTokenDigest) {
      return await sql.begin(async (transactionSql) => {
        await establishActorAccount(transactionSql, teammateAccountId);
        const rows = await transactionSql<readonly GrantRow[]>`
          SELECT
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
          FROM private_app.team_question_grants
          WHERE invitation_digest = ${invitationTokenDigest}
            AND teammate_account_id = ${teammateAccountId}
        `;
        const row = rows[0];
        return row === undefined ? null : grantFromRow(row);
      });
    },

    async acceptGrant(target, nowMs): Promise<AcceptGrantResult> {
      return await sql.begin(async (transactionSql) => {
        // Resolve the exact grant under the teammate identity first, before any
        // owner-tenant context exists.
        await establishActorAccount(transactionSql, target.teammateAccountId);
        const resolved = await transactionSql<readonly GrantRow[]>`
          SELECT
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
          FROM private_app.team_question_grants
          WHERE grant_id = ${target.grantId}
            AND teammate_account_id = ${target.teammateAccountId}
        `;
        const resolvedRow = resolved[0];
        if (resolvedRow === undefined) {
          return { outcome: "REJECTED" as const, reason: "GRANT_ALREADY_ACCEPTED" as const };
        }
        const ownerTenantId = tenantUuidForAccount(resolvedRow.owner_account_id);
        // Lock the grant under its owner tenant context; the conditional UPDATE below is
        // the atomic first-accept gate against concurrent redemption or revocation.
        await establishTenant(transactionSql, resolvedRow.owner_account_id);
        const locked = await transactionSql<readonly GrantRow[]>`
          SELECT
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
          FROM private_app.team_question_grants
          WHERE tenant_id = ${ownerTenantId}::uuid
            AND grant_id = ${target.grantId}
            AND teammate_account_id = ${target.teammateAccountId}
          FOR UPDATE
        `;
        const grant = locked[0];
        if (grant === undefined) {
          return { outcome: "REJECTED" as const, reason: "GRANT_ALREADY_ACCEPTED" as const };
        }
        if (grant.revoked_at !== null) {
          return { outcome: "REJECTED" as const, reason: "GRANT_REVOKED" as const };
        }
        if (grant.expires_at.getTime() <= nowMs) {
          return { outcome: "REJECTED" as const, reason: "GRANT_EXPIRED" as const };
        }
        if (grant.accepted_at !== null) {
          return { outcome: "REJECTED" as const, reason: "GRANT_ALREADY_ACCEPTED" as const };
        }
        const updated = await transactionSql<readonly GrantRow[]>`
          UPDATE private_app.team_question_grants
          SET accepted_at = ${new Date(nowMs)}
          WHERE tenant_id = ${ownerTenantId}::uuid
            AND grant_id = ${target.grantId}
            AND accepted_at IS NULL
            AND revoked_at IS NULL
          RETURNING
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
        `;
        const row = updated[0];
        if (row === undefined) {
          return { outcome: "REJECTED" as const, reason: "GRANT_ALREADY_ACCEPTED" as const };
        }
        return { outcome: "ACCEPTED" as const, grant: grantFromRow(row) };
      });
    },

    async revokeGrant(tenantAccountId, grantId, nowMs): Promise<RevokeGrantResult> {
      const tenantId = tenantUuidForAccount(tenantAccountId);
      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, tenantAccountId);
        const locked = await transactionSql<readonly GrantRow[]>`
          SELECT
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
          FROM private_app.team_question_grants
          WHERE tenant_id = ${tenantId}::uuid AND grant_id = ${grantId}
          FOR UPDATE
        `;
        const grant = locked[0];
        if (grant === undefined) {
          return { outcome: "REJECTED" as const, reason: "GRANT_UNKNOWN" as const };
        }
        if (grant.revoked_at !== null) {
          return { outcome: "ALREADY_REVOKED" as const, grant: grantFromRow(grant) };
        }
        const updated = await transactionSql<readonly GrantRow[]>`
          UPDATE private_app.team_question_grants
          SET revoked_at = ${new Date(nowMs)},
              revocation_revision = revocation_revision + 1
          WHERE tenant_id = ${tenantId}::uuid
            AND grant_id = ${grantId}
            AND revoked_at IS NULL
          RETURNING
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
        `;
        const row = updated[0];
        if (row === undefined) {
          return { outcome: "ALREADY_REVOKED" as const, grant: grantFromRow(grant) };
        }
        return { outcome: "REVOKED" as const, grant: grantFromRow(row) };
      });
    },

    async appendQuestion(input): Promise<AppendQuestionResult> {
      return await sql.begin(async (transactionSql) => {
        // Resolve the exact grant under the teammate identity before the owner tenant
        // context exists; RLS pins this read to the caller's account.
        await establishActorAccount(transactionSql, input.submitterAccountId);
        const resolved = await transactionSql<readonly GrantRow[]>`
          SELECT
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
          FROM private_app.team_question_grants
          WHERE grant_id = ${input.grantId}
            AND teammate_account_id = ${input.submitterAccountId}
        `;
        const resolvedRow = resolved[0];
        if (resolvedRow === undefined) {
          return { outcome: "REJECTED" as const, reason: "GRANT_UNKNOWN" as const };
        }
        const ownerTenantId = tenantUuidForAccount(resolvedRow.owner_account_id);
        // Lock the grant under its owner tenant context so the liveness verdict and the
        // append are decided atomically against any concurrent revocation.
        await establishTenant(transactionSql, resolvedRow.owner_account_id);
        const locked = await transactionSql<readonly GrantRow[]>`
          SELECT
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
          FROM private_app.team_question_grants
          WHERE tenant_id = ${ownerTenantId}::uuid
            AND grant_id = ${input.grantId}
            AND teammate_account_id = ${input.submitterAccountId}
          FOR UPDATE
        `;
        const grant = locked[0];
        if (grant === undefined) {
          return { outcome: "REJECTED" as const, reason: "GRANT_UNKNOWN" as const };
        }
        // Byte-equal idempotent retries return the recorded row; a reused key with
        // different content is a typed conflict, exactly like the Q&A exchange log.
        const idempotent = await transactionSql<readonly QuestionRow[]>`
          SELECT
            question_id, session_id::text, grant_id, submitted_by_account_id,
            question, idempotency_key, question_seq, created_at
          FROM private_app.team_questions
          WHERE tenant_id = ${ownerTenantId}::uuid
            AND grant_id = ${grant.grant_id}
            AND idempotency_key = ${input.idempotencyKey}
        `;
        const existing = idempotent[0];
        if (existing !== undefined) {
          const question = questionFromRow(existing, grant.owner_account_id, "");
          if (
            question.questionText === input.questionText &&
            question.submittedByAccountId === input.submitterAccountId
          ) {
            return { outcome: "DUPLICATE" as const, question };
          }
          return { outcome: "REJECTED" as const, reason: "IDEMPOTENCY_CONFLICT" as const };
        }
        if (grant.revoked_at !== null) {
          return { outcome: "REJECTED" as const, reason: "GRANT_REVOKED" as const };
        }
        if (grant.accepted_at === null) {
          return { outcome: "REJECTED" as const, reason: "GRANT_NOT_ACCEPTED" as const };
        }
        if (grant.expires_at.getTime() <= input.nowMs) {
          return { outcome: "REJECTED" as const, reason: "GRANT_EXPIRED" as const };
        }
        const inserted = await transactionSql<readonly QuestionRow[]>`
          INSERT INTO private_app.team_questions (
            tenant_id, session_id, question_id, grant_id, submitted_by_account_id,
            question, idempotency_key, created_at
          ) VALUES (
            ${ownerTenantId}::uuid, ${grant.session_id}::uuid, ${input.questionId},
            ${grant.grant_id}, ${input.submitterAccountId},
            ${input.questionText}, ${input.idempotencyKey}, ${new Date(input.nowMs)}
          )
          RETURNING
            question_id, session_id::text, grant_id, submitted_by_account_id,
            question, idempotency_key, question_seq, created_at
        `;
        const row = inserted[0];
        if (row === undefined) {
          throw new Error("team question insert did not return its row");
        }
        return {
          outcome: "APPENDED" as const,
          question: questionFromRow(row, grant.owner_account_id, grant.teammate_username),
        };
      });
    },

    async listGrants(tenantAccountId, presentationSessionId) {
      const tenantId = tenantUuidForAccount(tenantAccountId);
      const sessionId = presentationSessionUuid(presentationSessionId);
      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, tenantAccountId);
        const rows = await transactionSql<readonly GrantRow[]>`
          SELECT
            grant_id, tenant_id::text, session_id::text, owner_account_id,
            teammate_account_id, teammate_username, invitation_digest, idempotency_key,
            revocation_revision, created_at, expires_at, accepted_at, revoked_at
          FROM private_app.team_question_grants
          WHERE tenant_id = ${tenantId}::uuid AND session_id = ${sessionId}::uuid
          ORDER BY created_at, grant_id
        `;
        return rows.map(grantFromRow);
      });
    },

    async readInbox(tenantAccountId, presentationSessionId) {
      const tenantId = tenantUuidForAccount(tenantAccountId);
      const sessionId = presentationSessionUuid(presentationSessionId);
      return await sql.begin(async (transactionSql) => {
        await establishTenant(transactionSql, tenantAccountId);
        const rows = await transactionSql<readonly InboxRow[]>`
          SELECT
            question.question_id,
            question.session_id::text,
            question.grant_id,
            question.submitted_by_account_id,
            parent.teammate_username,
            question.question,
            question.idempotency_key,
            question.question_seq,
            question.created_at
          FROM private_app.team_questions AS question
          JOIN private_app.team_question_grants AS parent
            ON parent.tenant_id = question.tenant_id
           AND parent.grant_id = question.grant_id
          WHERE question.tenant_id = ${tenantId}::uuid
            AND question.session_id = ${sessionId}::uuid
          ORDER BY question.question_seq
        `;
        return rows.map((row) => questionFromRow(row, tenantAccountId, ""));
      });
    },
  };
}
