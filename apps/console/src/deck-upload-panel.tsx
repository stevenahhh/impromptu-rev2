import { Panel } from "@impromptu/ui";
import { useRef, useState } from "react";
import { useAuth } from "./auth-session";
import { createCorrelationId, getDebugLogger } from "./debug-log";
import { messages } from "./i18n";
import {
  type ActivePresentationView,
  type ConsoleDeckUploadClient,
  DeckUploadError,
} from "./session-client";

/**
 * Rejection reasons a presenter can act on get their own sentence; everything else keeps
 * the generic copy so backend codes never leak into the UI.
 */
function uploadFailureText(text: ReturnType<typeof messages>, error: unknown): string {
  if (error instanceof DeckUploadError && error.code === "input_too_large") {
    return text.uploadTooLarge;
  }
  return text.uploadFailed;
}

export function SessionUploadPanel({
  client,
  csrfToken,
}: {
  readonly client: ConsoleDeckUploadClient;
  readonly csrfToken: string;
}) {
  const { locale, setActivePresentation } = useAuth();
  const text = messages(locale);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"IDLE" | "UPLOADING" | "SUCCESS" | "ERROR">("IDLE");
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // The picker label carries [data-deck-upload-submit] for the Playwright harnesses, so a
  // stray click on it after the input already has files must never re-send the same deck.
  const uploadInFlight = useRef(false);

  const uploadFile = async (selected: File) => {
    if (uploadInFlight.current) return;
    uploadInFlight.current = true;
    setFile(selected);
    setPhase("UPLOADING");
    setMessage(text.uploading);
    const log = getDebugLogger();
    const correlationId = createCorrelationId();
    try {
      const next = await log.timed(
        "upload",
        "deck.upload",
        () => client.uploadDeck(csrfToken, selected),
        { correlationId, detail: { filename: selected.name, byteLength: selected.size } },
      );
      setActivePresentation({
        presentationSessionId: next.presentationSessionId,
        presentationSessionEpoch: next.presentationSessionEpoch,
        deckVersion: next.deckVersion,
        ...publicManifest(next.publicDeck),
        slides: publicSlides(next.publicDeck),
      });
      setPhase("SUCCESS");
    } catch (error) {
      // log.timed already recorded the failure as deck.upload.error.
      setPhase("ERROR");
      setMessage(uploadFailureText(text, error));
    } finally {
      uploadInFlight.current = false;
    }
  };

  return (
    <Panel className="console-upload-panel" tone="inset">
      <section
        className={`console-dropzone${phase === "UPLOADING" ? " console-dropzone--busy" : ""}`}
        data-dragging={dragging}
        data-upload-dropzone
        aria-label={text.uploadTitle}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const dropped = event.dataTransfer.files[0];
          if (dropped !== undefined) void uploadFile(dropped);
        }}
      >
        <p>{text.uploadSelect}</p>
        <label className="ui-button ui-button--quiet console-file-button" data-deck-upload-submit>
          <span>{phase === "UPLOADING" ? text.uploading : text.chooseFile}</span>
          <input
            accept=".pptx,.pdf"
            data-deck-file-input
            disabled={phase === "UPLOADING"}
            type="file"
            onChange={(event) => {
              const selected = event.currentTarget.files?.[0];
              // A browser only fires change for a differing selection, so the stale value
              // has to go or re-picking the same deck after a failure does nothing.
              event.currentTarget.value = "";
              if (selected !== undefined) void uploadFile(selected);
            }}
          />
        </label>
        {file === null ? null : <p className="console-selected-file">{file.name}</p>}
      </section>
      <p
        className={`console-status-line${phase === "ERROR" ? " console-status-line--attention" : ""}`}
        aria-live="polite"
        data-upload-status={phase}
      >
        {phase === "SUCCESS" ? `${text.deckAccepted} ${text.presentationReady}` : message}
      </p>
    </Panel>
  );
}

function publicManifest(value: unknown): Pick<ActivePresentationView, "manifestHash"> {
  if (typeof value !== "object" || value === null) return {};
  const manifestHash = (value as Record<string, unknown>).manifestHash;
  return typeof manifestHash === "string" ? { manifestHash } : {};
}

function publicSlides(value: unknown): ActivePresentationView["slides"] {
  if (typeof value !== "object" || value === null) return [];
  const slides = (value as Record<string, unknown>).slides;
  if (!Array.isArray(slides)) return [];
  return slides.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const slide = value as Record<string, unknown>;
    if (
      typeof slide.publicSlideKey !== "string" ||
      typeof slide.ordinal !== "number" ||
      typeof slide.accessibilityLabel !== "string"
    ) {
      return [];
    }
    const image = slide.image;
    const parsedImage =
      typeof image === "object" &&
      image !== null &&
      typeof (image as Record<string, unknown>).url === "string" &&
      typeof (image as Record<string, unknown>).contentHash === "string" &&
      typeof (image as Record<string, unknown>).width === "number" &&
      typeof (image as Record<string, unknown>).height === "number"
        ? {
            url: (image as Record<string, unknown>).url as string,
            contentHash: (image as Record<string, unknown>).contentHash as string,
            width: (image as Record<string, unknown>).width as number,
            height: (image as Record<string, unknown>).height as number,
          }
        : undefined;
    return [
      {
        publicSlideKey: slide.publicSlideKey,
        ordinal: slide.ordinal,
        accessibilityLabel: slide.accessibilityLabel,
        ...(parsedImage === undefined ? {} : { image: parsedImage }),
      },
    ];
  });
}
