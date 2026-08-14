import type { Sql } from "postgres";
import type { ProjectionDispatchBoundary, PublicationDispatch } from "./outbox-dispatcher.ts";

type DispatchOutcomeRow = Readonly<{
  outcome: "APPLIED" | "DUPLICATE";
}>;

export function createPostgresProjectionDispatchBoundary(sql: Sql): ProjectionDispatchBoundary {
  return {
    async dispatch(message: PublicationDispatch) {
      const payload = JSON.stringify(message.publicPayload);
      if (payload === undefined) {
        throw new TypeError("public payload must be JSON serializable");
      }

      const rows = await sql<readonly DispatchOutcomeRow[]>`
        SELECT public_projection.dispatch_publication(
          ${message.dispatchKey}::uuid,
          ${message.tenantId}::uuid,
          ${message.projectionId}::uuid,
          ${message.eventKind},
          ${payload}::jsonb
        ) AS outcome
      `;
      const outcome = rows[0]?.outcome;
      if (rows.length !== 1 || (outcome !== "APPLIED" && outcome !== "DUPLICATE")) {
        throw new Error("projection dispatch returned an invalid outcome");
      }
      return outcome;
    },
  };
}
