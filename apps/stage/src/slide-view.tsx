import { type PublishedSlideRuntime, PublishedSlideRuntimeSchema } from "@impromptu/contracts";
import { loadVerifiedSvg, rebaseDeckAssetUrl } from "@impromptu/ui";
import { useEffect, useRef } from "react";
import type { StageSnapshotView } from "./stage-client";

// Single source for the public API origin: deck asset URLs are rebased against it here and the
// default stage session client in stage-routes.tsx is pointed at it.
export const STAGE_PUBLIC_API_ORIGIN = import.meta.env.STAGE_PUBLIC_API_ORIGIN ?? "";

export function normalizeDeckAssetUrl(url: string) {
  return rebaseDeckAssetUrl(url, STAGE_PUBLIC_API_ORIGIN);
}

export function renderedSlideRuntime(
  slide: StageSnapshotView["deckSlides"][number],
): PublishedSlideRuntime | null {
  if (!new URL(slide.imageUrl, window.location.href).pathname.toLowerCase().endsWith(".svg")) {
    return null;
  }
  const parsed = PublishedSlideRuntimeSchema.safeParse(slide.runtime);
  return parsed.success && parsed.data.timeline.slide_key === slide.publicSlideKey
    ? parsed.data
    : null;
}

/**
 * A slide with no animation timeline still has to reach the projector intact.
 *
 * An SVG shown through `<img src>` renders in a restricted mode where the browser refuses every
 * external reference, and the render pipeline externalizes slide backgrounds into separate asset
 * files that each slide references relatively — so an `<img>`-displayed slide arrives in front of
 * the audience with its background missing. Measured on a real deck: zero of two background assets
 * requested through `<img>`, both of two when the same bytes are inlined. The animated path
 * already inlines; this is the static path, which became the normal one once animation started
 * being withheld for decks whose renderer geometry disagrees with their OOXML.
 *
 * Raster slides (PDF decks render to PNG) keep the `<img>` path, which has no such restriction.
 */
export function StaticSlide({
  onFailure,
  slide,
}: {
  readonly slide: StageSnapshotView["deckSlides"][number];
  /** Called once when this slide's bytes cannot be verified or rendered — never auto-retried. */
  readonly onFailure?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { imageUrl, imageContentHash, accessibilityLabel } = slide;
  // String-only on purpose: a resolution failure would silently degrade the slide to the raster
  // path, which is what drops its background.
  const vector = (imageUrl.split(/[?#]/)[0] ?? "").toLowerCase().endsWith(".svg");
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;

  useEffect(() => {
    if (!vector) return;
    const controller = new AbortController();
    let active = true;
    void loadVerifiedSvg({ imageUrl, imageContentHash, accessibilityLabel }, controller.signal)
      .then((svg) => {
        svg.setAttribute("class", "stage-slide");
        svg.setAttribute("data-slide-fit", "contain");
        if (active) hostRef.current?.replaceChildren(svg);
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        // Unverified bytes never reach the room: the host stays empty and the surface reports
        // the failure up so it can stop claiming a slide is on screen.
        onFailureRef.current?.();
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [vector, imageUrl, imageContentHash, accessibilityLabel]);

  return vector ? (
    <div className="stage-slide-host" ref={hostRef} />
  ) : (
    <img
      className="stage-slide"
      data-slide-fit="contain"
      src={imageUrl}
      alt={accessibilityLabel}
      onError={() => onFailureRef.current?.()}
    />
  );
}
