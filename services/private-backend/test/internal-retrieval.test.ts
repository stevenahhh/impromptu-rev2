import { describe, expect, test } from "bun:test";
import {
  InternalRetrievalService,
  type RetrievalObjectMetadata,
} from "../src/retrieval/internal-retrieval.ts";

const content = "Revenue was 42 million USD in 2025.";
const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
const manifestHash = "a".repeat(64);
const request = { query: "revenue", deckVersion: "deck_v1", manifestHash, maxResults: 3 };

function fixture() {
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
          ? { tenantId: "tenant-a", principalId: "actor-a", groupIds: ["finance"], attributes: { role: "analyst" } }
          : null;
      },
    },
    policy: {
      async prefilter(principal) {
        if (principal.groupIds[0] !== "finance" || !allowed) {
          return { version: "acl-v1", current, authorizedObjectIds: [] };
        }
        return { version: "acl-v1", current, authorizedObjectIds: ["object-1"] };
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
  });
  return {
    service,
    annCalls,
    revoke: () => { allowed = false; },
    stalePolicy: () => { current = false; },
    updateMetadata: (next: Partial<RetrievalObjectMetadata>) => { metadata = { ...metadata, ...next }; },
    updateContent: (next: string) => { storedContent = next; },
  };
}

describe("ACL-first internal retrieval", () => {
  test("derives the principal, applies tenant and ReBAC prefilter before ANN, then post-authorizes", async () => {
    const flow = fixture();
    const references = await flow.service.retrieve("session-a", request);
    expect(references).toHaveLength(1);
    expect(flow.annCalls).toEqual([{
      tenantId: "tenant-a",
      query: "revenue",
      authorizedObjectIds: ["object-1"],
      limit: 3,
    }]);
    const reference = references[0];
    expect(reference).toBeDefined();
    const result = await flow.service.materialize(reference!);
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

  test("denies ACL revocation between retrieval and materialization or publication", async () => {
    const flow = fixture();
    const reference = (await flow.service.retrieve("session-a", request))[0]!;
    const materialized = await flow.service.materialize(reference);
    expect(materialized.outcome).toBe("MATERIALIZED");
    if (materialized.outcome !== "MATERIALIZED") throw new Error("expected evidence");
    flow.revoke();
    expect(await flow.service.authorizeForPublication(reference, materialized.evidence)).toBe(false);
    expect(await flow.service.materialize(reference)).toEqual({ outcome: "DENIED", reason: "UNAUTHORIZED" });
  });

  test("denies stale deck metadata, source metadata, and content hash", async () => {
    const staleDeck = fixture();
    const deckRef = (await staleDeck.service.retrieve("session-a", request))[0]!;
    staleDeck.updateMetadata({ manifestHash: "b".repeat(64) });
    expect(await staleDeck.service.materialize(deckRef)).toEqual({ outcome: "DENIED", reason: "STALE_DECK" });

    const staleSource = fixture();
    const sourceRef = (await staleSource.service.retrieve("session-a", request))[0]!;
    staleSource.updateMetadata({ sourceRevision: "revision-2" });
    expect(await staleSource.service.materialize(sourceRef)).toEqual({ outcome: "DENIED", reason: "STALE_SOURCE" });

    const changedBytes = fixture();
    const bytesRef = (await changedBytes.service.retrieve("session-a", request))[0]!;
    changedBytes.updateContent("tampered");
    expect(await changedBytes.service.materialize(bytesRef)).toEqual({ outcome: "DENIED", reason: "STALE_SOURCE" });
  });
});
