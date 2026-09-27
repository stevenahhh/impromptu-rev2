import { describe, expect, test } from "bun:test";
import {
  InternalRetrievalService,
  type RetrievalObjectMetadata,
} from "../src/retrieval/internal-retrieval.ts";

const content = "Revenue was 42 million USD in 2025.";
const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
const manifestHash = "a".repeat(64);
const request = { query: "revenue", deckVersion: "deck_v1", manifestHash, maxResults: 3 };

function fixture(
  overrides: Partial<ConstructorParameters<typeof InternalRetrievalService>[0]> = {},
) {
  let current = true;
  let allowed = true;
  let metadata: RetrievalObjectMetadata = {
    tenantId: "tenant-a",
    objectId: "object-1",
    sourceId: "source-1",
    sourceRevision: "revision-1",
    sourceHash: hash,
    deckVersion: "deck_v1",
    manifestHash,
    title: "Annual report",
    anchor: "page=4",
    rights: "APPROVED",
    containsPii: false,
  };
  let storedContent = content;
  const annCalls: unknown[] = [];
  const service = new InternalRetrievalService({
    principals: {
      async resolve(sessionId) {
        return sessionId === "session-a"
          ? {
              tenantId: "tenant-a",
              principalId: "actor-a",
              groupIds: ["finance"],
              attributes: { role: "analyst" },
            }
          : null;
      },
    },
    policy: {
      async prefilter(principal) {
        if (principal.groupIds[0] !== "finance" || !allowed) {
          return { version: "acl-v1", current, authorizedObjectIds: [], sourceRevisions: {} };
        }
        return {
          version: "acl-v1",
          current,
          authorizedObjectIds: ["object-1"],
          sourceRevisions: { "object-1": "revision-1" },
        };
      },
      async authorizeObject(principal, object, version) {
        return allowed && current && principal.tenantId === object.tenantId && version === "acl-v1";
      },
      async isCurrent(_tenantId, version) {
        return current && version === "acl-v1";
      },
    },
    ann: {
      async search(input) {
        annCalls.push(input);
        return [
          {
            tenantId: "tenant-b",
            objectId: "cross-tenant",
            score: 1,
            indexedSourceHash: hash,
            indexedDeckVersion: "deck_v1",
            indexedManifestHash: manifestHash,
            indexedAuthorizationVersion: "acl-v1",
          },
          {
            tenantId: "tenant-a",
            objectId: "object-1",
            score: 0.9,
            indexedSourceHash: hash,
            indexedDeckVersion: "deck_v1",
            indexedManifestHash: manifestHash,
            indexedAuthorizationVersion: "acl-v1",
          },
        ];
      },
    },
    objects: {
      async readMetadata(tenantId, objectId) {
        return tenantId === "tenant-a" && objectId === "object-1" ? metadata : null;
      },
      async readContent(tenantId, objectId) {
        return tenantId === "tenant-a" && objectId === "object-1" ? storedContent : null;
      },
    },
    ...overrides,
  });
  return {
    service,
    annCalls,
    revoke: () => {
      allowed = false;
    },
    stalePolicy: () => {
      current = false;
    },
    updateMetadata: (next: Partial<RetrievalObjectMetadata>) => {
      metadata = { ...metadata, ...next };
    },
    updateContent: (next: string) => {
      storedContent = next;
    },
  };
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("fixture value is required");
  return value;
}

describe("corpus preparation during retrieval", () => {
  // A freshly uploaded deck triggers a burst of recommendations. Preparation used to run
  // inline inside `retrieve`, so every concurrent request waited on (or duplicated) the same
  // advisory-locked embedding pass and burned its whole model budget before ANN could start.
  // Retrieval now kicks one background preparation per deck scope and reads whatever is
  // already committed; the recommendation abstains fast on a cold corpus instead of timing
  // out, and the committed waves make the index converge.
  function corpusFixture() {
    const prepared: string[] = [];
    const gates: Array<() => void> = [];
    const startsWaiters: Array<() => void> = [];
    const corpus = {
      async prepare(_principal: unknown, retrieval: { deckVersion: string }) {
        prepared.push(retrieval.deckVersion);
        for (const waiter of startsWaiters.splice(0)) waiter();
        await new Promise<void>((resolve) => gates.push(resolve));
      },
    };
    const { service } = fixture({ corpus });
    // Deterministic signal that a preparation has actually started: subscribe before the
    // triggering retrieval, never poll or sleep for it.
    const waitForPrepares = async (count: number) => {
      while (prepared.length < count) {
        await new Promise<void>((resolve) => startsWaiters.push(resolve));
      }
    };
    const releaseAll = () => {
      for (const gate of gates.splice(0)) gate();
    };
    return { service, prepared, gates, waitForPrepares, releaseAll };
  }

  test("retrieve resolves without waiting for a pending preparation", async () => {
    const { service, prepared, waitForPrepares, releaseAll } = corpusFixture();
    const retrieved = await Promise.race([
      service.retrieve("session-a", request).then((value) => ({ outcome: "done", value })),
      new Promise<{ outcome: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ outcome: "timeout" }), 2_000),
      ),
    ]);
    expect(retrieved.outcome).toBe("done");
    expect(retrieved.outcome === "done" ? retrieved.value : []).toHaveLength(1);
    await waitForPrepares(1);
    expect(prepared).toEqual(["deck_v1"]);
    releaseAll();
  });

  test("concurrent retrievals share one in-flight preparation per deck scope", async () => {
    const { service, prepared, waitForPrepares, releaseAll } = corpusFixture();
    const other = { ...request, deckVersion: "deck_v2" };
    const pending = [
      service.retrieve("session-a", request),
      service.retrieve("session-a", request),
      service.retrieve("session-a", other),
    ];
    // Both scopes' preparations start before either is released.
    await waitForPrepares(2);
    releaseAll();
    const results = await Promise.all(pending);
    expect(prepared.sort()).toEqual(["deck_v1", "deck_v2"]);
    expect(results[0]).toHaveLength(1);
    expect(results[1]).toHaveLength(1);
    // The fixture's stored object carries deck_v1, so the other scope authorizes nothing.
    expect(results[2]).toEqual([]);
    // A settled preparation is retried by the next retrieval rather than wedged forever.
    // The dedup entry clears in a microtask when the shared run settles, so this tick just
    // drains already-queued continuations - it is not a timing wait.
    await Bun.sleep(0);
    const retried = service.retrieve("session-a", request);
    await waitForPrepares(3);
    expect(prepared.sort()).toEqual(["deck_v1", "deck_v1", "deck_v2"]);
    releaseAll();
    await retried;
  });

  test("a rejected preparation does not fail the retrieval that triggered it", async () => {
    const { service } = fixture({
      corpus: {
        async prepare() {
          throw new Error("indexing backend offline");
        },
      },
    });
    expect(await service.retrieve("session-a", request)).toHaveLength(1);
  });
});

describe("ACL-first internal retrieval", () => {
  test("derives the principal, applies tenant and ReBAC prefilter before ANN, then post-authorizes", async () => {
    const flow = fixture();
    const references = await flow.service.retrieve("session-a", request);
    expect(references).toHaveLength(1);
    expect(flow.annCalls).toEqual([
      {
        tenantId: "tenant-a",
        query: "revenue",
        queryVector: [],
        authorizedObjectIds: ["object-1"],
        limit: 3,
      },
    ]);
    const reference = references[0];
    expect(reference).toBeDefined();
    const result = await flow.service.materialize(required(reference));
    expect(result.outcome).toBe("MATERIALIZED");
  });

  test("returns zero without querying ANN for another session, denied group, or stale policy", async () => {
    const unknown = fixture();
    expect(await unknown.service.retrieve("session-b", request)).toEqual([]);
    expect(unknown.annCalls).toEqual([]);

    const denied = fixture();
    denied.revoke();
    expect(await denied.service.retrieve("session-a", request)).toEqual([]);
    expect(denied.annCalls).toEqual([]);

    const stale = fixture();
    stale.stalePolicy();
    expect(await stale.service.retrieve("session-a", request)).toEqual([]);
    expect(stale.annCalls).toEqual([]);
  });

  test("fails closed before retrieval for cross-tenant metadata or a stale source revision", async () => {
    const crossTenant = fixture();
    crossTenant.updateMetadata({ tenantId: "tenant-b" });
    expect(await crossTenant.service.retrieve("session-a", request)).toEqual([]);
    expect(crossTenant.annCalls).toEqual([]);

    const staleRevision = fixture();
    staleRevision.updateMetadata({ sourceRevision: "revision-2" });
    expect(await staleRevision.service.retrieve("session-a", request)).toEqual([]);
    expect(staleRevision.annCalls).toEqual([]);
  });

  test("denies ACL revocation between retrieval and materialization or publication", async () => {
    const flow = fixture();
    const reference = required((await flow.service.retrieve("session-a", request))[0]);
    const materialized = await flow.service.materialize(reference);
    expect(materialized.outcome).toBe("MATERIALIZED");
    if (materialized.outcome !== "MATERIALIZED") throw new Error("expected evidence");
    flow.revoke();
    expect(await flow.service.authorizeForPublication(reference, materialized.evidence)).toBe(
      false,
    );
    expect(await flow.service.materialize(reference)).toEqual({
      outcome: "DENIED",
      reason: "UNAUTHORIZED",
    });
  });

  test("denies publication when current metadata gains PII or loses approved rights", async () => {
    const rights = fixture();
    const rightsReference = required((await rights.service.retrieve("session-a", request))[0]);
    const rightsEvidence = await rights.service.materialize(rightsReference);
    if (rightsEvidence.outcome !== "MATERIALIZED") throw new Error("expected evidence");
    rights.updateMetadata({ rights: "UNKNOWN" });
    expect(
      await rights.service.authorizeForPublication(rightsReference, rightsEvidence.evidence),
    ).toBe(false);
    expect(await rights.service.materialize(rightsReference)).toEqual({
      outcome: "DENIED",
      reason: "UNAUTHORIZED",
    });

    const pii = fixture();
    const piiReference = required((await pii.service.retrieve("session-a", request))[0]);
    const piiEvidence = await pii.service.materialize(piiReference);
    if (piiEvidence.outcome !== "MATERIALIZED") throw new Error("expected evidence");
    pii.updateMetadata({ containsPii: true });
    expect(await pii.service.authorizeForPublication(piiReference, piiEvidence.evidence)).toBe(
      false,
    );
    expect(await pii.service.materialize(piiReference)).toEqual({
      outcome: "DENIED",
      reason: "UNAUTHORIZED",
    });
  });

  test("denies stale deck metadata, source metadata, and content hash", async () => {
    const staleDeck = fixture();
    const deckRef = required((await staleDeck.service.retrieve("session-a", request))[0]);
    staleDeck.updateMetadata({ manifestHash: "b".repeat(64) });
    expect(await staleDeck.service.materialize(deckRef)).toEqual({
      outcome: "DENIED",
      reason: "STALE_DECK",
    });

    const staleSource = fixture();
    const sourceRef = required((await staleSource.service.retrieve("session-a", request))[0]);
    staleSource.updateMetadata({ sourceRevision: "revision-2" });
    expect(await staleSource.service.materialize(sourceRef)).toEqual({
      outcome: "DENIED",
      reason: "STALE_SOURCE",
    });

    const changedBytes = fixture();
    const bytesRef = required((await changedBytes.service.retrieve("session-a", request))[0]);
    changedBytes.updateContent("tampered");
    expect(await changedBytes.service.materialize(bytesRef)).toEqual({
      outcome: "DENIED",
      reason: "STALE_SOURCE",
    });
  });
});
