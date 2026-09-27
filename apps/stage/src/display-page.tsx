import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RenderedSlidePlayer, type RenderedSlidePlayerHandle } from "./rendered-slide-player";
import { normalizeDeckAssetUrl, renderedSlideRuntime, StaticSlide } from "./slide-view";
import type { StageSessionClient } from "./stage-client";
import { publishStageEvent } from "./stage-events";
import { useStageCopy } from "./stage-i18n";
import { useScreenTopology } from "./use-screen-topology";
import { useStageSubscription } from "./use-stage-subscription";
import { emergencyPublicSlideSet, windowsDisplayMode } from "./windows-topology";

function DisplayPage({ client }: { readonly client: StageSessionClient }) {
  const copy = useStageCopy();
  const titleId = useId();
  const requestedMode = windowsDisplayMode(new URL(window.location.href).searchParams.get("mode"));
  const { mode, placementMessage } = useScreenTopology(requestedMode);
  // Truthful slide failure: the identity (slide key + occurrence) of the one occurrence whose
  // verified bytes could not be rendered. A later occurrence — even of the same slide — clears
  // it because the keyed player remounts and gets a fresh chance.
  const [failedSlide, setFailedSlide] = useState<string | null>(null);
  const renderedSlidePlayerRef = useRef<RenderedSlidePlayerHandle>(null);
  const { snapshot, unavailable, setSnapshot } = useStageSubscription(client, mode, requestedMode);

  const navigateCachedSlide = useCallback(
    (offset: -1 | 1) => {
      setSnapshot((current) => {
        if (current === null) return null;
        const slides = [...current.deckSlides].sort((left, right) => left.ordinal - right.ordinal);
        const index = slides.findIndex(
          (slide) => slide.publicSlideKey === current.occurrence.publicSlideKey,
        );
        const target = slides[index + offset];
        if (target === undefined) return current;
        const occurrence = {
          publicSlideKey: target.publicSlideKey,
          occurrenceSeq: current.occurrence.occurrenceSeq + 1,
        };
        publishStageEvent("impromptu:local-slide", occurrence);
        return { ...current, occurrence };
      });
    },
    [setSnapshot],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const unmodified = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (unmodified && (event.key === "ArrowRight" || event.key === "PageDown")) {
        const player = renderedSlidePlayerRef.current;
        if (player !== null && !player.exhausted) {
          event.preventDefault();
          void player.advance();
          return;
        }
      }
      if (mode === "single" && snapshot !== null) {
        const command = emergencyPublicSlideSet(
          event,
          snapshot.deckSlides.map((slide) => slide.publicSlideKey),
          snapshot.occurrence.publicSlideKey,
        );
        if (command !== null) {
          event.preventDefault();
          publishStageEvent("impromptu:public-slide-set", command);
          setSnapshot((current) =>
            current === null
              ? null
              : {
                  ...current,
                  occurrence: {
                    publicSlideKey: command.publicSlideKey,
                    occurrenceSeq: current.occurrence.occurrenceSeq + 1,
                  },
                },
          );
          return;
        }
      }
      if (unmodified && event.key === "ArrowLeft") navigateCachedSlide(-1);
      if (unmodified && event.key === "ArrowRight") navigateCachedSlide(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, navigateCachedSlide, snapshot, setSnapshot]);
  const projectedSlide = snapshot?.deckSlides.find(
    (slide) => slide.publicSlideKey === snapshot.occurrence.publicSlideKey,
  );
  const currentSlide =
    projectedSlide === undefined
      ? undefined
      : { ...projectedSlide, imageUrl: normalizeDeckAssetUrl(projectedSlide.imageUrl) };
  const currentSlideRuntime =
    currentSlide === undefined ? null : renderedSlideRuntime(currentSlide);
  const currentOccurrenceKey =
    currentSlide === undefined || snapshot === null
      ? null
      : `${currentSlide.publicSlideKey}:${snapshot.occurrence.occurrenceSeq}`;
  const slideFailed = currentOccurrenceKey !== null && failedSlide === currentOccurrenceKey;
  const visibleSlide = slideFailed ? undefined : currentSlide;

  return (
    <div
      className="stage-display"
      data-audience-readiness={
        snapshot === null ? "RECOVERING" : slideFailed ? "SLIDE_FAILED" : "READY"
      }
      data-blackout={snapshot?.blackout === true ? "true" : "false"}
      data-stage-chrome="hidden"
    >
      <main
        className={`stage-display__content${currentSlide === undefined ? "" : " stage-display__content--slide"}`}
        aria-labelledby={visibleSlide === undefined ? titleId : undefined}
      >
        {visibleSlide === undefined ? (
          <section
            className="stage-claim ui-reveal"
            data-stage-state={slideFailed ? "SLIDE_FAILED" : undefined}
          >
            <h1 id={titleId}>
              {slideFailed
                ? copy.slideUnavailable
                : unavailable === null
                  ? copy.awaitingPresentation
                  : copy.audienceUnavailable}
            </h1>
          </section>
        ) : (
          <section
            className="stage-slide-surface ui-reveal"
            data-stage-slide-surface="uploaded"
            aria-label={currentSlide?.accessibilityLabel}
          >
            {currentSlideRuntime !== null ? (
              <RenderedSlidePlayer
                key={currentOccurrenceKey}
                ref={renderedSlidePlayerRef}
                slide={visibleSlide}
                runtime={currentSlideRuntime}
                occurrenceSeq={snapshot?.occurrence.occurrenceSeq ?? 0}
                onFailure={() => setFailedSlide(currentOccurrenceKey)}
              />
            ) : (
              <StaticSlide
                slide={visibleSlide}
                onFailure={() => setFailedSlide(currentOccurrenceKey)}
              />
            )}
          </section>
        )}
      </main>
      {/* Placement outcomes stay reachable for assistive tech without painting status prose onto
          the room-facing screen; placement itself runs automatically on mount. */}
      <p className="ui-sr-only" aria-live="polite">
        {placementMessage}
      </p>
    </div>
  );
}

export default DisplayPage;
