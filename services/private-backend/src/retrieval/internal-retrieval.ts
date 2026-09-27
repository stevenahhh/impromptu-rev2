import type { RetrievalRequest, RetrievedEvidence } from "@impromptu/contracts/retrieval";
import { RetrievalRequestSchema, RetrievedEvidenceSchema } from "@impromptu/contracts/retrieval";

export interface RetrievalPrincipal {
  readonly tenantId: string;
  readonly principalId: string;
  readonly groupIds: readonly string[];
  readonly attributes: Readonly<Record<string, string>>;
}

export interface RetrievalPrincipalAuthority {
  resolve(accountSessionId: string): Promise<RetrievalPrincipal | null>;
}

export interface RetrievalCorpusPreparer {
  prepare(principal: RetrievalPrincipal, request: RetrievalRequest): Promise<void>;
}

export interface AuthorizationSnapshot {
  readonly version: string;
  readonly current: boolean;
  readonly authorizedObjectIds: readonly string[];
  /** Source revisions observed in the same ACL/RLS prefilter as the authorized object ids. */
  readonly sourceRevisions: Readonly<Record<string, string>>;
}

export interface RetrievalAuthorizationPolicy {
  prefilter(
    principal: RetrievalPrincipal,
    request: RetrievalRequest,
  ): Promise<AuthorizationSnapshot>;
  authorizeObject(
    principal: RetrievalPrincipal,
    object: RetrievalObjectMetadata,
    authorizationVersion: string,
  ): Promise<boolean>;
  isCurrent(tenantId: string, authorizationVersion: string): Promise<boolean>;
}

export interface AnnCandidate {
  readonly tenantId: string;
  readonly objectId: string;
  readonly score: number;
  readonly indexedSourceRevision?: string;
  readonly indexedSourceHash: string;
  readonly indexedDeckVersion: string;
  readonly indexedManifestHash: string;
  readonly indexedAuthorizationVersion: string;
}

export interface AuthorizedAnnIndex {
  search(input: {
    readonly tenantId: string;
    readonly query: string;
    readonly queryVector: readonly number[];
    readonly authorizedObjectIds: readonly string[];
    readonly limit: number;
  }): Promise<readonly AnnCandidate[]>;
}

export interface RetrievalObjectMetadata {
  readonly tenantId: string;
  readonly objectId: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly sourceHash: string;
  readonly deckVersion: string;
  readonly manifestHash: string;
  readonly title: string;
  readonly anchor: string;
  readonly rights: "APPROVED" | "UNKNOWN" | "DENIED";
  readonly containsPii: boolean;
}

export interface PrivateRetrievalObjectStore {
  readMetadata(tenantId: string, objectId: string): Promise<RetrievalObjectMetadata | null>;
  readContent(tenantId: string, objectId: string): Promise<string | null>;
}

export interface AuthorizedEvidenceReference {
  readonly principal: RetrievalPrincipal;
  readonly object: RetrievalObjectMetadata;
  readonly authorizationVersion: string;
}

export type EvidenceMaterialization =
  | Readonly<{ outcome: "MATERIALIZED"; evidence: RetrievedEvidence }>
  | Readonly<{ outcome: "DENIED"; reason: "UNAUTHORIZED" | "STALE_DECK" | "STALE_SOURCE" }>;

/** ACL-first retrieval. Every policy or metadata uncertainty intentionally collapses to no candidates. */
export class InternalRetrievalService {
  readonly #principals: RetrievalPrincipalAuthority;
  readonly #policy: RetrievalAuthorizationPolicy;
  readonly #ann: AuthorizedAnnIndex;
  readonly #objects: PrivateRetrievalObjectStore;
  readonly #corpus: RetrievalCorpusPreparer | undefined;
  readonly #preparations = new Map<string, Promise<void>>();

  constructor(dependencies: {
    readonly principals: RetrievalPrincipalAuthority;
    readonly policy: RetrievalAuthorizationPolicy;
    readonly ann: AuthorizedAnnIndex;
    readonly objects: PrivateRetrievalObjectStore;
    readonly corpus?: RetrievalCorpusPreparer;
  }) {
    this.#principals = dependencies.principals;
    this.#policy = dependencies.policy;
    this.#ann = dependencies.ann;
    this.#objects = dependencies.objects;
    this.#corpus = dependencies.corpus;
  }

  /**
   * Starts corpus preparation without awaiting it. Preparation embeds and writes deck chunks
   * under an advisory lock, so awaiting it inline serialized every concurrent first-wave
   * recommendation behind one multi-second provider pass and burned each run's own deadline -
   * the baseline's every-request DEADLINE_EXCEEDED. Kicking it off once per deck scope and
   * reading whatever is already committed keeps retrieval fail-closed (a cold or partially
   * built corpus just produces no candidates) while the committed waves converge; the map
   * entry clears on settle so a failed run is retried by the next retrieval instead of wedging.
   */
  #prepareInBackground(principal: RetrievalPrincipal, request: RetrievalRequest): void {
    const preparer = this.#corpus;
    if (preparer === undefined) return;
    const scope = `${principal.tenantId}:${request.deckVersion}:${request.manifestHash}`;
    if (this.#preparations.has(scope)) return;
    const run = preparer.prepare(principal, request).catch(() => undefined);
    this.#preparations.set(scope, run);
    void run.finally(() => {
      if (this.#preparations.get(scope) === run) this.#preparations.delete(scope);
    });
  }

  async retrieve(
    accountSessionId: string,
    input: unknown,
    queryVector: readonly number[] = [],
  ): Promise<readonly AuthorizedEvidenceReference[]> {
    const request = RetrievalRequestSchema.safeParse(input);
    if (!request.success) return [];
    try {
      const principal = await this.#principals.resolve(accountSessionId);
      if (principal === null) return [];
      this.#prepareInBackground(principal, request.data);
      const snapshot = await this.#policy.prefilter(principal, request.data);
      if (
        !snapshot.current ||
        !(await this.#policy.isCurrent(principal.tenantId, snapshot.version))
      ) {
        return [];
      }
      const allowed = new Set(snapshot.authorizedObjectIds);
      if (allowed.size === 0 || allowed.size !== snapshot.authorizedObjectIds.length) return [];

      // Resolve and validate the complete authorized revision set before either retriever runs.
      // The cached metadata is reused below so this gate is performed exactly once.
      const authorizedObjects = new Map<string, RetrievalObjectMetadata>();
      for (const objectId of [...allowed].sort()) {
        const object = await this.#objects.readMetadata(principal.tenantId, objectId);
        const snapshotRevision = snapshot.sourceRevisions[objectId];
        if (
          object === null ||
          object.tenantId !== principal.tenantId ||
          object.objectId !== objectId ||
          object.deckVersion !== request.data.deckVersion ||
          object.manifestHash !== request.data.manifestHash ||
          snapshotRevision === undefined ||
          object.sourceRevision !== snapshotRevision ||
          object.rights !== "APPROVED" ||
          object.containsPii ||
          !(await this.#policy.authorizeObject(principal, object, snapshot.version))
        ) {
          return [];
        }
        authorizedObjects.set(objectId, object);
      }

      const candidates = await this.#ann.search({
        tenantId: principal.tenantId,
        query: request.data.query,
        queryVector: [...queryVector],
        authorizedObjectIds: [...allowed],
        limit: request.data.maxResults,
      });
      const authorized: AuthorizedEvidenceReference[] = [];
      for (const candidate of candidates) {
        if (
          authorized.length >= request.data.maxResults ||
          candidate.tenantId !== principal.tenantId ||
          !allowed.has(candidate.objectId) ||
          candidate.indexedAuthorizationVersion !== snapshot.version ||
          candidate.indexedDeckVersion !== request.data.deckVersion ||
          candidate.indexedManifestHash !== request.data.manifestHash
        )
          continue;
        const object = authorizedObjects.get(candidate.objectId);
        if (
          object === undefined ||
          object.sourceHash !== candidate.indexedSourceHash ||
          (candidate.indexedSourceRevision !== undefined &&
            object.sourceRevision !== candidate.indexedSourceRevision)
        )
          continue;
        authorized.push(
          Object.freeze({ principal, object, authorizationVersion: snapshot.version }),
        );
      }
      return authorized;
    } catch {
      return [];
    }
  }

  async materialize(reference: AuthorizedEvidenceReference): Promise<EvidenceMaterialization> {
    const { principal, object, authorizationVersion } = reference;
    try {
      // Re-authorize immediately before reading private bytes. This catches revocation after ANN.
      if (
        !(await this.#policy.isCurrent(principal.tenantId, authorizationVersion)) ||
        !(await this.#policy.authorizeObject(principal, object, authorizationVersion))
      )
        return { outcome: "DENIED", reason: "UNAUTHORIZED" };
      const current = await this.#objects.readMetadata(principal.tenantId, object.objectId);
      if (current === null || current.tenantId !== principal.tenantId) {
        return { outcome: "DENIED", reason: "UNAUTHORIZED" };
      }
      if (
        current.deckVersion !== object.deckVersion ||
        current.manifestHash !== object.manifestHash
      ) {
        return { outcome: "DENIED", reason: "STALE_DECK" };
      }
      if (
        current.sourceHash !== object.sourceHash ||
        current.sourceRevision !== object.sourceRevision
      ) {
        return { outcome: "DENIED", reason: "STALE_SOURCE" };
      }
      if (
        current.rights !== "APPROVED" ||
        current.containsPii ||
        !(await this.#policy.authorizeObject(principal, current, authorizationVersion))
      ) {
        return { outcome: "DENIED", reason: "UNAUTHORIZED" };
      }
      const content = await this.#objects.readContent(principal.tenantId, object.objectId);
      if (content === null || (await sha256(content)) !== current.sourceHash) {
        return { outcome: "DENIED", reason: "STALE_SOURCE" };
      }
      const evidence = RetrievedEvidenceSchema.parse({
        evidenceId: `internal:${current.objectId}:${current.sourceRevision}`,
        sourceId: current.sourceId,
        sourceRevision: current.sourceRevision,
        sourceHash: current.sourceHash,
        deckVersion: current.deckVersion,
        manifestHash: current.manifestHash,
        title: current.title,
        content,
        quote: content.slice(0, 2_000),
        anchor: current.anchor,
        canonicalUrl: null,
        sourceDate: null,
        rights: current.rights,
        containsPii: current.containsPii,
        authorizationVersion,
      });
      return { outcome: "MATERIALIZED", evidence };
    } catch {
      return { outcome: "DENIED", reason: "UNAUTHORIZED" };
    }
  }

  async authorizeForPublication(
    reference: AuthorizedEvidenceReference,
    evidence: RetrievedEvidence,
  ): Promise<boolean> {
    try {
      const current = await this.#objects.readMetadata(
        reference.principal.tenantId,
        reference.object.objectId,
      );
      return (
        current !== null &&
        current.sourceHash === evidence.sourceHash &&
        current.sourceRevision === evidence.sourceRevision &&
        current.deckVersion === evidence.deckVersion &&
        current.manifestHash === evidence.manifestHash &&
        current.rights === "APPROVED" &&
        !current.containsPii &&
        (await this.#policy.isCurrent(
          reference.principal.tenantId,
          reference.authorizationVersion,
        )) &&
        (await this.#policy.authorizeObject(
          reference.principal,
          current,
          reference.authorizationVersion,
        ))
      );
    } catch {
      return false;
    }
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
