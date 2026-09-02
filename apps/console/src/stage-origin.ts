/**
 * The public Stage resolves its canonical entry for a deck through the landing
 * URL (`/?deck=<version>`, see apps/stage/src/App.tsx). The origin is the stage
 * dev server by default and can be overridden with VITE_STAGE_ORIGIN for
 * deployed rehearsal topologies.
 */
export const STAGE_ORIGIN = process.env.NEXT_PUBLIC_STAGE_ORIGIN ?? "http://localhost:4174";

export function stageUrl(deckVersion: string): string {
  return `${STAGE_ORIGIN}/?deck=${encodeURIComponent(deckVersion)}`;
}
