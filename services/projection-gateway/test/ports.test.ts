import { describe, expect, test } from "bun:test";
import type {
  DisplayReceiptWriter,
  PublicProjectionReader,
  PublicProjectionSnapshot,
} from "../src/index.ts";

describe("projection gateway ports", () => {
  test("represent only the public snapshot and display receipt paths", () => {
    const snapshot: PublicProjectionSnapshot = {
      presentationSessionEpoch: 3,
      displayBindingEpoch: 2,
      publicPlaybackRevision: 8,
      slide: {
        deckVersion: "deck-v1",
        publicSlideKey: "public-slide-2",
        occurrenceSeq: 1,
      },
    };
    const reader: PublicProjectionReader | undefined = undefined;
    const receiptWriter: DisplayReceiptWriter | undefined = undefined;

    expect(snapshot.slide.publicSlideKey).toBe("public-slide-2");
    expect(reader).toBeUndefined();
    expect(receiptWriter).toBeUndefined();
  });
});
