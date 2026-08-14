export interface DisplayIdentity {
  readonly displayId: string;
  readonly displayFingerprint: string;
}

export interface DisplayJoinView extends DisplayIdentity {
  readonly displayJoinId: string;
  readonly deckVersion: string;
  readonly expiresAtMs: number;
}

export interface StageCardView {
  readonly projectionId: string;
  readonly status: "PUBLISHED";
  readonly claim: string;
  readonly supportSummary: string;
  readonly sourceLabel: string;
  readonly publicCardRevision: string;
}

export interface StageSnapshotView {
  readonly occurrence: { readonly publicSlideKey: string; readonly occurrenceSeq: number };
  readonly cards: readonly StageCardView[];
  readonly publicCardRevision: string;
  readonly tombstoneWatermark: string;
  readonly tombstoneRetentionMs: number;
}

export interface StageSessionClient {
  createJoin(identity: DisplayIdentity, deckVersion: string): Promise<DisplayJoinView>;
  claim(join: DisplayJoinView): Promise<void>;
  snapshot(): Promise<StageSnapshotView>;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function displayJoin(value: unknown): DisplayJoinView | null {
  const candidate = record(value);
  if (
    candidate === null ||
    typeof candidate.displayJoinId !== "string" ||
    typeof candidate.displayId !== "string" ||
    typeof candidate.displayFingerprint !== "string" ||
    typeof candidate.deckVersion !== "string" ||
    typeof candidate.expiresAtMs !== "number"
  ) {
    return null;
  }
  return {
    displayJoinId: candidate.displayJoinId,
    displayId: candidate.displayId,
    displayFingerprint: candidate.displayFingerprint,
    deckVersion: candidate.deckVersion,
    expiresAtMs: candidate.expiresAtMs,
  };
}

function snapshot(value: unknown): StageSnapshotView | null {
  const candidate = record(value);
  const occurrence = record(candidate?.occurrence);
  if (
    candidate === null ||
    occurrence === null ||
    typeof occurrence.publicSlideKey !== "string" ||
    typeof occurrence.occurrenceSeq !== "number" ||
    !Array.isArray(candidate.cards) ||
    typeof candidate.publicCardRevision !== "string" ||
    typeof candidate.tombstoneWatermark !== "string" ||
    typeof candidate.tombstoneRetentionMs !== "number"
  ) {
    return null;
  }
  const cards: StageCardView[] = [];
  for (const valueCard of candidate.cards) {
    const card = record(valueCard);
    if (
      card === null ||
      typeof card.projectionId !== "string" ||
      card.status !== "PUBLISHED" ||
      typeof card.claim !== "string" ||
      typeof card.supportSummary !== "string" ||
      typeof card.sourceLabel !== "string" ||
      typeof card.publicCardRevision !== "string"
    ) {
      return null;
    }
    cards.push({
      projectionId: card.projectionId,
      status: card.status,
      claim: card.claim,
      supportSummary: card.supportSummary,
      sourceLabel: card.sourceLabel,
      publicCardRevision: card.publicCardRevision,
    });
  }
  return {
    occurrence: {
      publicSlideKey: occurrence.publicSlideKey,
      occurrenceSeq: occurrence.occurrenceSeq,
    },
    cards,
    publicCardRevision: candidate.publicCardRevision,
    tombstoneWatermark: candidate.tombstoneWatermark,
    tombstoneRetentionMs: candidate.tombstoneRetentionMs,
  };
}

export function createStageSessionClient(baseUrl = ""): StageSessionClient {
  const headers = { "content-type": "application/json" };
  return {
    async createJoin(identity, deckVersion) {
      const response = await fetch(`${baseUrl}/v1/display-joins`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ ...identity, deckVersion }),
      });
      const body = displayJoin(await json(response));
      if (!response.ok || body === null) throw new Error("Display join could not be created.");
      return body;
    },
    async claim(join) {
      const response = await fetch(`${baseUrl}/v1/display-session`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(join),
      });
      if (!response.ok) throw new Error("The controller has not approved this display yet.");
    },
    async snapshot() {
      const response = await fetch(`${baseUrl}/v1/snapshot`, { credentials: "include" });
      const body = snapshot(await json(response));
      if (!response.ok || body === null) throw new Error("Public snapshot is unavailable.");
      return body;
    },
  };
}
