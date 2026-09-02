import type {
  PrivateDeckContext,
  ReferenceDocumentRejectionReason,
  ReferenceDocumentSummary,
} from "@impromptu/contracts/private";
import type { PublishedDeckArtifact } from "@impromptu/contracts/public";
import type { RecommendationOutcome } from "@impromptu/contracts/retrieval";
import type { AccountDirectory } from "../account-directory.ts";
import type { AudioIngestService } from "../audio-ingest.ts";
import type { DeckUploadRejectionCode } from "../deck-upload-worker.ts";
import type { JsonLogger, MetricsRegistry } from "../observability.ts";
import type { PreparedEvidenceCoordinator } from "../prepared-evidence.ts";
import type { RateLimiter } from "../rate-limit.ts";
import type { SessionReportReadRouteHandler } from "../report/http.ts";
import type { QaDefenseRouteDependencies } from "./routes/qa-defense.ts";
import type { SpokenQuestionRouteDependencies } from "./routes/spoken-question.ts";

export type { ReferenceDocumentSummary };

export type PrivateBackendHandler = (request: Request) => Response | Promise<Response>;

export interface AccountIdentityVerifier {
  verifyCredentials(
    username: string,
    password: string,
  ): Promise<{
    readonly accountId: string;
    readonly actorId: string;
  } | null>;
}

export type DeckUploadContentType =
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "application/pdf";

export interface RawDeckUpload {
  readonly filename: string;
  readonly contentType: DeckUploadContentType;
  readonly byteLength?: number;
  readonly body: ReadableStream<Uint8Array>;
}

export interface DeckUploadReceipt {
  readonly privateDeck: PrivateDeckContext;
  readonly publicDeck: PublishedDeckArtifact;
  readonly sourceHash: string;
}

export interface DeckUploadAccepted extends DeckUploadReceipt {
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly deckVersion: string;
}

export type DeckUploadRejectedResponse = Readonly<{
  error: "deck_upload_rejected";
  code: DeckUploadRejectionCode;
}>;

export interface RawReferenceDocument {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface ReferenceDocumentServiceInput {
  readonly accountId: string;
  readonly actorId: string;
  readonly presentationSessionId: string;
}

/**
 * The service returns deeply readonly outcomes, which the schema-inferred type does not
 * express; widening here keeps the boundary parse authoritative without forcing the
 * implementation to hand out mutable arrays.
 */
export type ReferenceDocumentUploadResult =
  | Readonly<{ outcome: "ACCEPTED"; documents: readonly ReferenceDocumentSummary[] }>
  | Readonly<{ outcome: "REJECTED"; reason: ReferenceDocumentRejectionReason }>;

export interface ReferenceDocumentService {
  acceptReferenceDocuments(
    input: ReferenceDocumentServiceInput & {
      readonly documents: readonly RawReferenceDocument[];
    },
  ): Promise<ReferenceDocumentUploadResult>;
  listReferenceDocuments(input: {
    readonly accountId: string;
    readonly presentationSessionId: string;
  }): Promise<readonly ReferenceDocumentSummary[]>;
}

export interface DeckUploadService {
  acceptRawDeck(input: {
    readonly accountId: string;
    readonly actorId: string;
    readonly upload: RawDeckUpload;
  }): Promise<DeckUploadReceipt>;
}

export interface PrivateBackendHttpDependencies {
  readonly coordinator: PreparedEvidenceCoordinator;
  readonly identityVerifier: AccountIdentityVerifier;
  readonly audio?: AudioIngestService;
  /** Optional so deployments can explicitly leave public account creation disabled. */
  readonly accountRegistrar?: Pick<AccountDirectory, "register">;
  readonly internalAuthToken: string;
  readonly now: () => number;
  readonly recommendations?: {
    recommend(accountSessionId: string, input: unknown): Promise<RecommendationOutcome>;
  };
  readonly sessionReportRead?: SessionReportReadRouteHandler;
  /** Optional exactly like `recommendations?`: the handler answers Q&A routes with 503 without it. */
  readonly qaDefense?: QaDefenseRouteDependencies;
  readonly spokenQuestions?: SpokenQuestionRouteDependencies;
  readonly persist?: () => Promise<void>;
  readonly uploads?: DeckUploadService;
  readonly referenceDocuments?: ReferenceDocumentService;
  readonly logger?: JsonLogger;
  readonly metrics?: MetricsRegistry;
  readonly readiness?: {
    check(): Promise<
      Readonly<{ outcome: "READY" }> | Readonly<{ outcome: "NOT_READY"; reason: string }>
    >;
  };
  readonly loginRateLimiters?: Readonly<{
    account: RateLimiter;
    ip: RateLimiter;
  }>;
}
