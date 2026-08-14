import {
  type PublicationDispatchDto,
  PublicationDispatchSchema,
} from "@impromptu/contracts/public";
import type { Sql } from "postgres";

export type PublicationEventKind = PublicationDispatchDto["eventKind"];
export type PublicationDispatch = PublicationDispatchDto;

export interface PrivatePublicationOutboxTransaction {
  claimUndelivered(limit: number): Promise<readonly PublicationDispatch[]>;
  markDelivered(dispatch: PublicationDispatch): Promise<void>;
}

export interface PrivatePublicationOutbox {
  transaction<T>(
    operation: (transaction: PrivatePublicationOutboxTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ProjectionDispatchBoundary {
  dispatch(message: PublicationDispatch): Promise<"APPLIED" | "DUPLICATE">;
}

export type PublicationDispatchBatchResult = Readonly<{
  claimed: number;
  applied: number;
  duplicates: number;
}>;

const MAX_BATCH_SIZE = 100;

export async function dispatchPublicationOutboxBatch(
  outbox: PrivatePublicationOutbox,
  projection: ProjectionDispatchBoundary,
  limit: number,
): Promise<PublicationDispatchBatchResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new RangeError(`batch limit must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }

  return outbox.transaction(async (transaction) => {
    const messages = await transaction.claimUndelivered(limit);
    let applied = 0;
    let duplicates = 0;

    for (const message of messages) {
      const outcome = await projection.dispatch(message);
      if (outcome === "APPLIED") applied += 1;
      else duplicates += 1;
      await transaction.markDelivered(message);
    }

    return { claimed: messages.length, applied, duplicates };
  });
}

type PublicationOutboxRow = Readonly<{
  tenant_id: string;
  dispatch_key: string;
  projection_id: string;
  event_kind: PublicationEventKind;
  public_payload: unknown;
}>;

export function createPostgresPrivatePublicationOutbox(sql: Sql): PrivatePublicationOutbox {
  return {
    transaction: async (operation) => {
      const result = await sql.begin(async (transactionSql) => ({
        value: await operation({
          claimUndelivered: async (limit) => {
            const rows = await transactionSql<readonly PublicationOutboxRow[]>`
              SELECT
                tenant_id::text,
                outbox_id::text AS dispatch_key,
                projection_id::text,
                event_kind::text,
                public_payload
              FROM private_app.publication_outbox
              WHERE delivered_at IS NULL
              ORDER BY created_at, tenant_id, outbox_id
              FOR UPDATE SKIP LOCKED
              LIMIT ${limit}
            `;
            return rows.map((row) =>
              PublicationDispatchSchema.parse({
                tenantId: row.tenant_id,
                dispatchKey: row.dispatch_key,
                projectionId: row.projection_id,
                eventKind: row.event_kind,
                publicPayload: row.public_payload,
              }),
            );
          },
          markDelivered: async (dispatch) => {
            const updated = await transactionSql`
              UPDATE private_app.publication_outbox
              SET delivered_at = transaction_timestamp(),
                  attempt_count = attempt_count + 1
              WHERE tenant_id = ${dispatch.tenantId}::uuid
                AND outbox_id = ${dispatch.dispatchKey}::uuid
                AND delivered_at IS NULL
              RETURNING outbox_id
            `;
            if (updated.count !== 1) {
              throw new Error(`outbox dispatch was not claimable: ${dispatch.dispatchKey}`);
            }
          },
        }),
      }));
      return result.value;
    },
  };
}
