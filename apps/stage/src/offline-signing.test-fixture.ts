import type { StageCardView } from "./stage-client";

const OFFLINE_DISPLAY_PRIVATE_KEY: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "F3i88NgsJwVGOI-F9iyV35t8q2aDHOM_5-qwXCG2xCg",
  y: "DSD6ou2ZeGoJ0LZ2GJa2aQ99YI2d5PraViGUpS1PHaI",
  d: "2pIwYtHTHjfPBqQuhZOAyFLpdmIhtsTJWH_-s4QJZws",
  ext: true,
  key_ops: ["sign"],
};

function base64Url(value: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(value));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function signOfflineCard(card: StageCardView): Promise<StageCardView> {
  if (card.offlinePackage === undefined) throw new Error("offline package required");
  const key = await crypto.subtle.importKey(
    "jwk",
    OFFLINE_DISPLAY_PRIVATE_KEY,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const payload = JSON.stringify({
    projectionId: card.projectionId,
    offlineDisplayAllowed: card.offlinePackage.offlineDisplayAllowed,
    localExpiresAtMs: card.offlinePackage.localExpiresAtMs,
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(payload),
  );
  return {
    ...card,
    offlinePackage: {
      ...card.offlinePackage,
      signature: base64Url(signature),
      signatureVerified: false,
    },
  };
}
