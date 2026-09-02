import { RenderedSlide, rebaseDeckAssetUrl } from "@impromptu/ui";
import { useAuth } from "./auth-session";
import { messages } from "./i18n";
import type { ActivePresentationView } from "./session-client";

export function orderedSlides(
  presentation: ActivePresentationView,
): ActivePresentationView["slides"] {
  return [...presentation.slides].sort((left, right) => left.ordinal - right.ordinal);
}

export function SlidePreview({ index }: { readonly index: number }) {
  const { activePresentation, locale } = useAuth();
  if (activePresentation === null) return null;
  const text = messages(locale);
  const slides = orderedSlides(activePresentation);
  const slide = slides[index];
  return (
    <section className="console-preview" aria-label={text.slidePreview}>
      <div className="console-preview__frame" data-slide-preview>
        {slide?.image === undefined ? (
          <p className="console-preview__status" role="alert">
            {text.slideLoadFailed}
          </p>
        ) : (
          <RenderedSlide
            key={`${slide.publicSlideKey}:${slide.image.contentHash}`}
            slide={{
              imageUrl: rebaseDeckAssetUrl(slide.image.url),
              imageContentHash: slide.image.contentHash,
              accessibilityLabel: slide.accessibilityLabel,
            }}
            loadingLabel={text.slideLoading}
            errorLabel={text.slideLoadFailed}
          />
        )}
        <p className="console-preview__position">
          {index + 1} / {slides.length}
        </p>
      </div>
    </section>
  );
}
