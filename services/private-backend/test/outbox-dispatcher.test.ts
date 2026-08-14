import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import {
  dispatchPublicationOutboxBatch,
  type PrivatePublicationOutbox,
  type PrivatePublicationOutboxTransaction,
  type ProjectionDispatchBoundary,
  type PublicationDispatch,
} from "../src/publication/outbox-dispatcher.ts";
import { createPostgresProjectionDispatchBoundary } from "../src/publication/postgres-projection-dispatch.ts";

function publishPayload(title: string) {
  return {
    cardId: "50000000-0000-4000-8000-000000000001",
    cardVersion: 1,
    publicSlideKey: "slide-public-1",
    occurrenceSeq: 1,
    title,
    body: "Audience-safe body",
    sourceLabel: "Public source",
    canonicalUrl: "https://example.test/evidence",
    publishedAt: "2026-08-14T08:00:00Z",
    expiresAt: "2026-08-14T09:00:00Z",
    revision: 1,
  };
}

const dispatches = [
  {
    tenantId: "10000000-0000-4000-8000-000000000001",
    dispatchKey: "30000000-0000-4000-8000-000000000001",
    projectionId: "40000000-0000-4000-8000-000000000001",
    eventKind: "publish_card",
    publicPayload: publishPayload("one"),
  },
  {
    tenantId: "10000000-0000-4000-8000-000000000001",
    dispatchKey: "30000000-0000-4000-8000-000000000002",
    projectionId: "40000000-0000-4000-8000-000000000001",
    eventKind: "publish_card",
    publicPayload: publishPayload("two"),
  },
  {
    tenantId: "10000000-0000-4000-8000-000000000001",
    dispatchKey: "30000000-0000-4000-8000-000000000003",
    projectionId: "40000000-0000-4000-8000-000000000001",
    eventKind: "publish_card",
    publicPayload: publishPayload("three"),
  },
] as const satisfies readonly PublicationDispatch[];

class TransactionalOutboxFake implements PrivatePublicationOutbox {
  readonly delivered = new Set<string>();
  failCommit = false;

  async transaction<T>(
    operation: (transaction: PrivatePublicationOutboxTransaction) => Promise<T>,
  ): Promise<T> {
    const pending = new Set(this.delivered);
    const result = await operation({
      claimUndelivered: async (limit) =>
        dispatches.filter((dispatch) => !pending.has(dispatch.dispatchKey)).slice(0, limit),
      markDelivered: async (dispatch) => {
        pending.add(dispatch.dispatchKey);
      },
    });
    if (this.failCommit) {
      this.failCommit = false;
      throw new Error("private commit failed");
    }
    this.delivered.clear();
    for (const key of pending) this.delivered.add(key);
    return result;
  }
}

class IdempotentProjectionFake implements ProjectionDispatchBoundary {
  readonly attempts: string[] = [];
  readonly applied = new Set<string>();
  failOnKey: string | undefined;

  async dispatch(message: PublicationDispatch): Promise<"APPLIED" | "DUPLICATE"> {
    this.attempts.push(message.dispatchKey);
    if (message.dispatchKey === this.failOnKey) throw new Error("projection unavailable");
    if (this.applied.has(message.dispatchKey)) return "DUPLICATE";
    this.applied.add(message.dispatchKey);
    return "APPLIED";
  }
}

describe("publication outbox dispatcher", () => {
  test("claims and delivers no more than the bounded batch", async () => {
    const outbox = new TransactionalOutboxFake();
    const projection = new IdempotentProjectionFake();

    const result = await dispatchPublicationOutboxBatch(outbox, projection, 2);

    expect(result).toEqual({ claimed: 2, applied: 2, duplicates: 0 });
    expect(projection.attempts).toEqual(
      dispatches.slice(0, 2).map(({ dispatchKey }) => dispatchKey),
    );
    expect([...outbox.delivered]).toEqual(
      dispatches.slice(0, 2).map(({ dispatchKey }) => dispatchKey),
    );
  });

  test("fails closed and rolls back delivery marks when projection dispatch fails", async () => {
    const outbox = new TransactionalOutboxFake();
    const projection = new IdempotentProjectionFake();
    projection.failOnKey = dispatches[1]?.dispatchKey;

    await expect(dispatchPublicationOutboxBatch(outbox, projection, 3)).rejects.toThrow(
      "projection unavailable",
    );

    expect(outbox.delivered.size).toBe(0);
  });

  test("replays after a private commit failure for at-least-once delivery", async () => {
    const outbox = new TransactionalOutboxFake();
    const projection = new IdempotentProjectionFake();
    outbox.failCommit = true;

    await expect(dispatchPublicationOutboxBatch(outbox, projection, 1)).rejects.toThrow(
      "private commit failed",
    );
    const replay = await dispatchPublicationOutboxBatch(outbox, projection, 1);

    expect(projection.attempts).toEqual([dispatches[0]?.dispatchKey, dispatches[0]?.dispatchKey]);
    expect(projection.applied.size).toBe(1);
    expect(replay).toEqual({ claimed: 1, applied: 0, duplicates: 1 });
    expect(outbox.delivered).toEqual(new Set([dispatches[0]?.dispatchKey]));
  });

  test("rejects an open DTO before issuing a projection query", async () => {
    let queryCount = 0;
    const sql = (() => {
      queryCount += 1;
      throw new Error("query must not execute");
    }) as unknown as Sql;
    const projection = createPostgresProjectionDispatchBoundary(sql);
    const payloadWithPrivateField = {
      ...dispatches[0].publicPayload,
      presenterNotes: "PRIVATE_CANARY",
    };
    const openDispatch: PublicationDispatch = {
      ...dispatches[0],
      publicPayload: payloadWithPrivateField,
    };

    await expect(projection.dispatch(openDispatch)).rejects.toBeInstanceOf(Error);
    expect(queryCount).toBe(0);
  });

  test("rejects unbounded or invalid batch sizes before opening a transaction", async () => {
    const outbox = new TransactionalOutboxFake();
    const projection = new IdempotentProjectionFake();

    for (const limit of [0, -1, 1.5, 101]) {
      await expect(dispatchPublicationOutboxBatch(outbox, projection, limit)).rejects.toThrow(
        "batch limit must be an integer between 1 and 100",
      );
    }
  });
});
