import {
  createProjectionGatewayStore,
  ProjectionGatewaySnapshotError,
  type ProjectionGatewayStore,
  restoreDisplayInvitationState,
  restoreProjectionGatewayStore,
  snapshotDisplayInvitationState,
  snapshotProjectionGatewayStore,
} from "../prepared-evidence.ts";

export type PostgresStateSql = <Rows = readonly Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => PromiseLike<Rows>;

export class PreparedEvidenceStateConflictError extends Error {
  readonly code = "PREPARED_EVIDENCE_STATE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "PreparedEvidenceStateConflictError";
  }
}

export interface ProjectionGatewayPersistence {
  readonly store: ProjectionGatewayStore;
  persist(): Promise<void>;
}

type StateRow = Readonly<{ revision: number | string; snapshot: unknown }>;

function revisionNumber(value: number | string): number {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new ProjectionGatewaySnapshotError("projection database revision is invalid");
  }
  return revision;
}

/**
 * Loads one named public gateway state and returns a CAS-backed persistence callback.
 * The callback rejects stale writers instead of silently overwriting another instance.
 */
export async function createPostgresProjectionGatewayPersistence(
  sql: PostgresStateSql,
  options: { readonly stateKey?: string } = {},
): Promise<ProjectionGatewayPersistence> {
  const stateKey = options.stateKey ?? "default";
  const rows = await sql<readonly StateRow[]>`
    SELECT revision, snapshot
    FROM public_projection.read_gateway_state(${stateKey})
  `;
  const row = rows[0];
  let store = createProjectionGatewayStore();
  let revision = 0;
  if (row !== undefined) {
    const restored = restoreProjectionGatewayStore(row.snapshot);
    if (restored.outcome !== "RESTORED") {
      throw new ProjectionGatewaySnapshotError("projection database snapshot failed validation");
    }
    store = restored.store;
    revision = revisionNumber(row.revision);
  }

  let writeQueue = Promise.resolve();
  const write = async () => {
    const snapshot = snapshotProjectionGatewayStore(store);
    try {
      const written = await sql<readonly Readonly<{ revision: number | string }>[]>`
        SELECT public_projection.write_gateway_state(
          ${stateKey},
          ${revision},
          ${snapshot}::jsonb
        ) AS revision
      `;
      const next = written[0];
      if (next === undefined) throw new Error("projection state write returned no revision");
      revision = revisionNumber(next.revision);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "40001") ||
          ("errno" in error && error.errno === "40001"))
      ) {
        throw new PreparedEvidenceStateConflictError(
          `projection gateway state ${stateKey} was changed by another instance`,
        );
      }
      throw error;
    }
  };

  return {
    store,
    persist() {
      const pending = writeQueue.then(write);
      writeQueue = pending.catch(() => {});
      return pending;
    },
  };
}

export interface DisplayInvitationPersistence {
  persist(): Promise<void>;
}

/**
 * Loads the invitation record set into an existing gateway store and returns a CAS-backed
 * persist callback for it. Invitation state is versioned apart from the main gateway
 * snapshot so a previous binary still restores its own document unchanged.
 */
export async function createPostgresDisplayInvitationPersistence(
  sql: PostgresStateSql,
  store: ProjectionGatewayStore,
  options: { readonly stateKey?: string } = {},
): Promise<DisplayInvitationPersistence> {
  const stateKey = options.stateKey ?? "display-invitations";
  const rows = await sql<readonly StateRow[]>`
    SELECT revision, snapshot
    FROM public_projection.read_invitation_state(${stateKey})
  `;
  const row = rows[0];
  let revision = 0;
  if (row !== undefined) {
    if (restoreDisplayInvitationState(store, row.snapshot).outcome !== "RESTORED") {
      throw new ProjectionGatewaySnapshotError("display invitation snapshot failed validation");
    }
    revision = revisionNumber(row.revision);
  }

  let writeQueue = Promise.resolve();
  const write = async () => {
    const snapshot = snapshotDisplayInvitationState(store);
    try {
      const written = await sql<readonly Readonly<{ revision: number | string }>[]>`
        SELECT public_projection.write_invitation_state(
          ${stateKey},
          ${revision},
          ${snapshot}::jsonb
        ) AS revision
      `;
      const next = written[0];
      if (next === undefined) {
        throw new Error("display invitation state write returned no revision");
      }
      revision = revisionNumber(next.revision);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "40001") ||
          ("errno" in error && error.errno === "40001"))
      ) {
        throw new PreparedEvidenceStateConflictError(
          `display invitation state ${stateKey} was changed by another instance`,
        );
      }
      throw error;
    }
  };

  return {
    persist() {
      const pending = writeQueue.then(write);
      writeQueue = pending.catch(() => {});
      return pending;
    },
  };
}
