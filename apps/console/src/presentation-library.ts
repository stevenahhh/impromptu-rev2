// Owner-scoped presentation library calls against the private backend: the persisted list a
// returning presenter reads, the resume detail that re-enters a deck without re-uploading,
// the title edit, and the playback-lease takeover a fresh account session needs. Every read
// is a closed parse: a malformed or widened payload fails loudly instead of silently
// hydrating a presentation the backend never described.

import {
  mutationHeaders,
  type PrivateClientContext,
  responseBody,
  stringField,
} from "./private-transport";

export interface PresentationSummaryView {
  readonly presentationSessionId: string;
  readonly presentationSessionEpoch: string;
  readonly title: string;
  readonly status: "ACTIVE" | "ENDED";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly endedAtMs: number | null;
  readonly deckVersion: string;
  readonly slideCount: number;
}

export interface PresentationListView {
  readonly presentations: readonly PresentationSummaryView[];
  /** Opaque server-issued continuation token; echoed back verbatim, never constructed. */
  readonly nextCursor: string | null;
}

export interface PresentationPlaybackView {
  readonly displayBindingEpoch: string;
  readonly controlRevision: string;
  readonly stageStatus: "READY" | "DISCONNECTED" | "UNBOUND";
  readonly occurrence: {
    readonly publicSlideKey: string;
    readonly occurrenceSeq: number;
  };
  readonly activeLease: {
    readonly actorId: string;
    readonly expiresAtMs: number;
  };
}

export interface PresentationDetailView extends PresentationSummaryView {
  readonly publicDeck: {
    readonly deckVersion: string;
    readonly manifestHash: string;
    readonly slides: readonly Readonly<{
      publicSlideKey: string;
      ordinal: number;
      accessibilityLabel: string;
      image?: Readonly<{
        url: string;
        contentHash: string;
        width: number;
        height: number;
      }>;
    }>[];
  };
  readonly playback: PresentationPlaybackView;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberField(value: Record<string, unknown>, field: string): number | null {
  const candidate = value[field];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function presentationSummary(value: unknown): PresentationSummaryView | null {
  const candidate = record(value);
  if (candidate === null) return null;
  const endedAtMs = candidate.endedAtMs;
  if (endedAtMs !== null && typeof endedAtMs !== "number") return null;
  const createdAtMs = numberField(candidate, "createdAtMs");
  const updatedAtMs = numberField(candidate, "updatedAtMs");
  const slideCount = numberField(candidate, "slideCount");
  const status = candidate.status;
  return typeof candidate.presentationSessionId === "string" &&
    typeof candidate.presentationSessionEpoch === "string" &&
    typeof candidate.title === "string" &&
    (status === "ACTIVE" || status === "ENDED") &&
    createdAtMs !== null &&
    updatedAtMs !== null &&
    slideCount !== null &&
    typeof candidate.deckVersion === "string"
    ? {
        presentationSessionId: candidate.presentationSessionId,
        presentationSessionEpoch: candidate.presentationSessionEpoch,
        title: candidate.title,
        status,
        createdAtMs,
        updatedAtMs,
        endedAtMs,
        deckVersion: candidate.deckVersion,
        slideCount,
      }
    : null;
}

function playbackView(value: unknown): PresentationPlaybackView | null {
  const playback = record(value);
  const occurrence = record(playback?.occurrence);
  const activeLease = record(playback?.activeLease);
  const stageStatus = playback?.stageStatus;
  const expiresAtMs = activeLease === null ? null : numberField(activeLease, "expiresAtMs");
  const occurrenceSeq = occurrence === null ? null : numberField(occurrence, "occurrenceSeq");
  return playback === null ||
    occurrence === null ||
    activeLease === null ||
    typeof playback.displayBindingEpoch !== "string" ||
    typeof playback.controlRevision !== "string" ||
    (stageStatus !== "READY" && stageStatus !== "DISCONNECTED" && stageStatus !== "UNBOUND") ||
    typeof occurrence.publicSlideKey !== "string" ||
    occurrenceSeq === null ||
    typeof activeLease.actorId !== "string" ||
    expiresAtMs === null
    ? null
    : {
        displayBindingEpoch: playback.displayBindingEpoch,
        controlRevision: playback.controlRevision,
        stageStatus,
        occurrence: {
          publicSlideKey: occurrence.publicSlideKey,
          occurrenceSeq,
        },
        activeLease: { actorId: activeLease.actorId, expiresAtMs },
      };
}

function deckSlide(value: unknown): PresentationDetailView["publicDeck"]["slides"][number] | null {
  const slide = record(value);
  if (
    slide === null ||
    typeof slide.publicSlideKey !== "string" ||
    typeof slide.ordinal !== "number" ||
    typeof slide.accessibilityLabel !== "string"
  ) {
    return null;
  }
  const image = record(slide.image);
  const width = image === null ? null : numberField(image, "width");
  const height = image === null ? null : numberField(image, "height");
  return {
    publicSlideKey: slide.publicSlideKey,
    ordinal: slide.ordinal,
    accessibilityLabel: slide.accessibilityLabel,
    ...(image !== null &&
    typeof image.url === "string" &&
    typeof image.contentHash === "string" &&
    width !== null &&
    height !== null
      ? {
          image: {
            url: image.url,
            contentHash: image.contentHash,
            width,
            height,
          },
        }
      : {}),
  };
}

function presentationDetail(body: unknown): PresentationDetailView | null {
  const candidate = record(body);
  const presentation = presentationSummary(candidate?.presentation);
  const publicDeck = record(candidate?.publicDeck);
  const slides = publicDeck?.slides;
  if (
    presentation === null ||
    publicDeck === null ||
    typeof publicDeck.manifestHash !== "string" ||
    !Array.isArray(slides)
  ) {
    return null;
  }
  const parsedSlides = slides.map(deckSlide);
  if (parsedSlides.some((slide) => slide === null)) return null;
  const playback = playbackView(candidate?.playback);
  if (playback === null) return null;
  // Off-contract drift fails the whole read rather than hydrating a mismatched deck.
  if (publicDeck.deckVersion !== presentation.deckVersion) return null;
  return {
    ...presentation,
    publicDeck: {
      deckVersion: presentation.deckVersion,
      manifestHash: publicDeck.manifestHash,
      slides: parsedSlides as PresentationDetailView["publicDeck"]["slides"],
    },
    playback,
  };
}

/**
 * The persisted owner-scoped list. A non-200 or an off-contract body is a thrown failure —
 * callers must never render it as an empty library.
 */
export async function listPresentations(
  context: PrivateClientContext,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): Promise<PresentationListView> {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  const response = await fetch(`${context.baseUrl}/v1/presentations${suffix}`, {
    credentials: "include",
  });
  const body = await responseBody(response);
  const envelope = record(body);
  const presentations = envelope?.presentations;
  const nextCursor = envelope?.nextCursor;
  if (!response.ok || !Array.isArray(presentations)) {
    throw new Error("The presentation list could not be read.");
  }
  const rows = presentations.map(presentationSummary);
  if (
    rows.some((row) => row === null) ||
    (nextCursor !== null && nextCursor !== undefined && typeof nextCursor !== "string")
  ) {
    throw new Error("The presentation list could not be read.");
  }
  return {
    presentations: rows as readonly PresentationSummaryView[],
    nextCursor: typeof nextCursor === "string" ? nextCursor : null,
  };
}

/** Owner-scoped resume read; 403/404 and malformed payloads throw so stale ids never hydrate. */
export async function readPresentation(
  context: PrivateClientContext,
  presentationSessionId: string,
): Promise<PresentationDetailView> {
  const response = await fetch(
    `${context.baseUrl}/v1/presentations/${encodeURIComponent(presentationSessionId)}`,
    { credentials: "include" },
  );
  const body = await responseBody(response);
  const detail = presentationDetail(body);
  if (!response.ok || detail === null) {
    throw new Error("The presentation could not be read.");
  }
  return detail;
}

export async function renamePresentation(
  context: PrivateClientContext,
  csrfToken: string,
  presentationSessionId: string,
  title: string,
): Promise<PresentationSummaryView> {
  const response = await fetch(
    `${context.baseUrl}/v1/presentations/${encodeURIComponent(presentationSessionId)}`,
    {
      method: "POST",
      credentials: "include",
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ title }),
    },
  );
  const body = await responseBody(response);
  const presentation = presentationSummary(record(body)?.presentation);
  if (!response.ok || presentation === null) {
    throw new Error("The presentation could not be renamed.");
  }
  return presentation;
}

/**
 * Re-entry control-plane write: a fresh account session (every sign-in mints a new actor)
 * takes over the playback lease against the display-binding epoch the resume read reported.
 * The server still CAS-checks the epoch, so a takeover against stale state is rejected here
 * instead of silently controlling someone else's binding.
 */
export async function takeoverPlaybackLease(
  context: PrivateClientContext,
  csrfToken: string,
  presentationSessionId: string,
  expectedDisplayBindingEpoch: string,
): Promise<{ readonly leaseActorId: string }> {
  const response = await fetch(`${context.baseUrl}/v1/playback/lease-takeover`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(csrfToken),
    body: JSON.stringify({ presentationSessionId, expectedDisplayBindingEpoch }),
  });
  const body = await responseBody(response);
  const lease = record(record(body)?.lease);
  const leaseActorId = lease === null ? null : stringField(lease, "actorId");
  if (!response.ok || leaseActorId === null) {
    throw new Error("The presentation lease could not be taken over.");
  }
  return { leaseActorId };
}
