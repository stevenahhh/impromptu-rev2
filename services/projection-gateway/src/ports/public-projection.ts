export interface PublicSlideProjection {
  readonly deckVersion: string;
  readonly publicSlideKey: string;
  readonly occurrenceSeq: number;
}

export interface PublishedAudienceCard {
  readonly projectionId: string;
  readonly publicCardRevision: number;
  readonly state: "PUBLISHED";
  readonly title: string;
  readonly body: string;
  readonly expiresAt: string | null;
}

export interface PublicProjectionSnapshot {
  readonly presentationSessionEpoch: number;
  readonly displayBindingEpoch: number;
  readonly publicPlaybackRevision: number;
  readonly publicCardRevision: number;
  readonly slide: PublicSlideProjection;
  readonly cards: readonly PublishedAudienceCard[];
}

export interface StageAppliedReceipt {
  readonly displaySessionId: string;
  readonly presentationSessionEpoch: number;
  readonly displayBindingEpoch: number;
  readonly commandId: string;
  readonly publicPlaybackRevision: number;
  readonly appliedAt: string;
}

export interface PublicProjectionReader {
  readSnapshot(displaySessionId: string): Promise<PublicProjectionSnapshot | null>;
}

export interface DisplayReceiptWriter {
  recordApplied(receipt: StageAppliedReceipt): Promise<void>;
}
