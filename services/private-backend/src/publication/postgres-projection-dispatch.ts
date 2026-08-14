import { PublicationDispatchSchema } from "@impromptu/contracts/public";
import type { Sql } from "postgres";
import type { ProjectionDispatchBoundary, PublicationDispatch } from "./outbox-dispatcher.ts";

type DispatchOutcomeRow = Readonly<{
  outcome: "APPLIED" | "DUPLICATE";
}>;

export function createPostgresProjectionDispatchBoundary(sql: Sql): ProjectionDispatchBoundary {
  return {
    async dispatch(message: PublicationDispatch) {
      const validated = PublicationDispatchSchema.parse(message);

      const rows = await sql<readonly DispatchOutcomeRow[]>`
        SELECT public_projection.dispatch_publication(
          ${validated.dispatchKey}::uuid,
          ${validated.tenantId}::uuid,
          ${validated.projectionId}::uuid,
          ${validated.eventKind},
          ${sql.json(validated.publicPayload)}
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
