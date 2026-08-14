import { createHash } from "node:crypto";
import type { AccountId } from "@impromptu/contracts/private";
import { PrivateDeckContextSchema } from "@impromptu/contracts/private";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";

export function createPreparedDeckArtifacts(
  ownerAccountId: AccountId,
  input: { readonly title: string; readonly content: string },
) {
  const sourceHash = createHash("sha256").update(input.content, "utf8").digest("hex");
  const manifestHash = createHash("sha256")
    .update(`prepared-manifest:${input.title}:${sourceHash}`, "utf8")
    .digest("hex");
  const imageHash = createHash("sha256").update(`public-slide:${sourceHash}`, "utf8").digest("hex");
  const deckVersion = `deck_${sourceHash}`;
  const publicSlideKey = `slide_${sourceHash}`;
  return {
    privateDeck: PrivateDeckContextSchema.parse({
      deckId: `private_deck_${sourceHash}`,
      deckVersion,
      manifestHash,
      title: input.title,
      ownerAccountId,
      aclPolicyVersion: "acl-1",
      privateObjectPrefix: `private-decks/${ownerAccountId}/${sourceHash}`,
      slides: [
        {
          privateSlideId: `private_slide_${sourceHash}`,
          publicSlideKey,
          ordinal: 1,
          speakerNotes: "",
          extractedText: input.content,
          sourceAssetIds: [`asset_${sourceHash}`],
        },
      ],
    }),
    publicDeck: PublishedDeckArtifactSchema.parse({
      deckVersion,
      manifestHash,
      title: input.title,
      slides: [
        {
          publicSlideKey,
          ordinal: 1,
          image: {
            url: `https://public.example.test/slides/${imageHash}.png`,
            contentHash: imageHash,
            width: 1920,
            height: 1080,
          },
          accessibilityLabel: input.title,
        },
      ],
    }),
    sourceHash,
  };
}
