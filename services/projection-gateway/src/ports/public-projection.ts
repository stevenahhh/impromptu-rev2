export interface PublicSlideProjection {
  readonly deckVersion: string;
  readonly publicSlideKey: string;
  readonly occurrenceSeq: number;
}

export interface PublicProjectionSnapshot {
  readonly presentationSessionEpoch: number;
  readonly displayBindingEpoch: number;
  readonly publicPlaybackRevision: number;
  readonly slide: PublicSlideProjection;
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
