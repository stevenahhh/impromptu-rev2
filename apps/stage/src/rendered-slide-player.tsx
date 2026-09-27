import type { PublishedSlideRuntime, RuntimeEmbeddedFont } from "@impromptu/contracts";
import { createSlidePlayer, type SlidePlayer } from "@impromptu/slide-runtime";
import { loadVerifiedSvg } from "@impromptu/ui";
import {
  forwardRef,
  type AnimationEvent as ReactAnimationEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export interface RenderedSlidePlayerSlide {
  readonly publicSlideKey: string;
  readonly imageUrl: string;
  readonly imageContentHash: string;
  readonly accessibilityLabel: string;
}

export interface RenderedSlidePlayerHandle {
  readonly exhausted: boolean;
  advance(): Promise<boolean>;
}

interface RenderedSlidePlayerProps {
  readonly slide: RenderedSlidePlayerSlide;
  readonly runtime: PublishedSlideRuntime;
  readonly occurrenceSeq?: number;
  readonly onAllClickGroupsExhausted?: () => void;
  /**
   * Called when even the last-resort still image cannot render — the slide is not on screen
   * at all, so the surface must stop claiming it is.
   */
  readonly onFailure?: () => void;
}

type RuntimeStatus = "loading" | "active" | "error";
type SupportedTransition = "fade" | "none";

function fontPreload(url: string): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "font";
  link.href = url;
  link.crossOrigin = "anonymous";
  document.head.append(link);
  return link;
}

function isEmbeddedFont(font: PublishedSlideRuntime["fonts"][number]): font is RuntimeEmbeddedFont {
  return typeof font !== "string";
}

function supportedTransition(runtime: PublishedSlideRuntime): SupportedTransition {
  return runtime.timeline.transition?.kind === "fade" ? "fade" : "none";
}

function resetPlayer(player: SlidePlayer | null): void {
  if (player === null) return;
  try {
    player.reset();
  } catch {
    // Cleanup is best-effort: a browser animation cancellation must not mask the static fallback.
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "AbortError"
  );
}

function RenderedSlidePlayerComponent(
  {
    slide,
    runtime,
    occurrenceSeq = 0,
    onAllClickGroupsExhausted,
    onFailure,
  }: RenderedSlidePlayerProps,
  ref: Ref<RenderedSlidePlayerHandle>,
) {
  const { publicSlideKey, imageUrl, imageContentHash, accessibilityLabel } = slide;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<SlidePlayer | null>(null);
  const statusRef = useRef<RuntimeStatus>("loading");
  const currentGroupRef = useRef(0);
  const advancingRef = useRef<SlidePlayer | null>(null);
  const exhaustedCallbackSentRef = useRef(false);
  const callbackRef = useRef(onAllClickGroupsExhausted);
  const [status, setStatus] = useState<RuntimeStatus>("loading");
  const [currentGroup, setCurrentGroup] = useState(0);
  const runtimeIdentity = `${publicSlideKey}:${imageContentHash}:${occurrenceSeq}`;
  const stableRuntimeRef = useRef({ identity: runtimeIdentity, value: runtime });
  if (stableRuntimeRef.current.identity !== runtimeIdentity) {
    stableRuntimeRef.current = { identity: runtimeIdentity, value: runtime };
  }
  const stableRuntime = stableRuntimeRef.current.value;
  const transition = supportedTransition(stableRuntime);
  const [transitionFinished, setTransitionFinished] = useState(transition === "none");
  const groupCount = runtime.timeline.click_groups.length;
  const displayedTransition = status === "error" ? "none" : transition;

  callbackRef.current = onAllClickGroupsExhausted;

  useImperativeHandle(
    ref,
    () => ({
      get exhausted() {
        if (statusRef.current === "error") return true;
        return statusRef.current === "active" && currentGroupRef.current >= groupCount;
      },
      async advance() {
        const player = playerRef.current;
        if (
          statusRef.current !== "active" ||
          player === null ||
          advancingRef.current !== null ||
          currentGroupRef.current >= groupCount
        ) {
          return false;
        }

        advancingRef.current = player;
        try {
          await player.advance();
          if (playerRef.current !== player || statusRef.current !== "active") return false;
          const nextGroup = player.currentGroup;
          currentGroupRef.current = nextGroup;
          hostRef.current?.setAttribute("data-click-group", String(nextGroup));
          setCurrentGroup(nextGroup);
          if (nextGroup >= groupCount && !exhaustedCallbackSentRef.current) {
            exhaustedCallbackSentRef.current = true;
            callbackRef.current?.();
          }
          return true;
        } catch {
          if (playerRef.current === player) {
            playerRef.current = null;
            resetPlayer(player);
            statusRef.current = "error";
            const host = hostRef.current;
            canvasRef.current?.replaceChildren();
            if (host !== null) host.dataset.slideRuntime = "error";
            setStatus("error");
          }
          return false;
        } finally {
          if (advancingRef.current === player) advancingRef.current = null;
        }
      },
    }),
    [groupCount],
  );

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (host === null || canvas === null) return;

    const abortController = new AbortController();
    const preloads: HTMLLinkElement[] = [];
    const loadedFaces: FontFace[] = [];
    let active = true;

    const previousPlayer = playerRef.current;
    playerRef.current = null;
    advancingRef.current = null;
    statusRef.current = "loading";
    currentGroupRef.current = 0;
    exhaustedCallbackSentRef.current = false;
    resetPlayer(previousPlayer);
    setStatus("loading");
    setCurrentGroup(0);
    setTransitionFinished(transition === "none");
    host.dataset.occurrenceSeq = String(occurrenceSeq);
    host.dataset.slideRuntime = "loading";
    canvas.replaceChildren();

    const fontReadiness = Promise.all(
      stableRuntime.fonts.map(async (font) => {
        if (
          isEmbeddedFont(font) &&
          typeof FontFace !== "undefined" &&
          document.fonts !== undefined
        ) {
          try {
            const source = `url(${JSON.stringify(font.url)}) format(${JSON.stringify(font.format)})`;
            const loaded = await new FontFace(font.family, source).load();
            if (!active) return;
            document.fonts.add(loaded);
            loadedFaces.push(loaded);
            return;
          } catch {
            if (!active) return;
          }
        }
        if (active) preloads.push(fontPreload(typeof font === "string" ? font : font.url));
      }),
    );

    void Promise.all([
      loadVerifiedSvg({ imageUrl, imageContentHash, accessibilityLabel }, abortController.signal),
      fontReadiness,
    ])
      .then(([svg]) => {
        if (!active) return;
        canvas.replaceChildren(svg);
        const player = createSlidePlayer({ svgRoot: svg, timeline: stableRuntime.timeline });
        if (!active) {
          resetPlayer(player);
          canvas.replaceChildren();
          return;
        }
        playerRef.current = player;
        statusRef.current = "active";
        host.dataset.slideRuntime = "active";
        setStatus("active");
      })
      .catch((error: unknown) => {
        if (!active || isAbortError(error)) return;
        const player = playerRef.current;
        playerRef.current = null;
        advancingRef.current = null;
        resetPlayer(player);
        statusRef.current = "error";
        canvas.replaceChildren();
        host.dataset.slideRuntime = "error";
        setStatus("error");
      });

    return () => {
      active = false;
      abortController.abort();
      const player = playerRef.current;
      playerRef.current = null;
      advancingRef.current = null;
      statusRef.current = "loading";
      resetPlayer(player);
      canvas.replaceChildren();
      for (const preload of preloads) preload.remove();
      for (const face of loadedFaces) document.fonts.delete(face);
    };
  }, [occurrenceSeq, accessibilityLabel, imageContentHash, imageUrl, stableRuntime, transition]);

  useEffect(() => {
    if (status !== "active" || groupCount !== 0 || exhaustedCallbackSentRef.current) return;
    exhaustedCallbackSentRef.current = true;
    callbackRef.current?.();
  }, [groupCount, status]);

  const onAnimationEnd = (event: ReactAnimationEvent<HTMLDivElement>) => {
    if (
      event.currentTarget === event.target &&
      event.animationName === "stage-slide-fade" &&
      transition === "fade" &&
      statusRef.current === "active"
    ) {
      setTransitionFinished(true);
    }
  };

  return (
    <div
      ref={hostRef}
      className="stage-slide-runtime"
      data-slide-runtime={status}
      data-slide-key={publicSlideKey}
      data-occurrence-seq={occurrenceSeq}
      data-click-groups={groupCount}
      data-click-group={currentGroup}
      data-transition={displayedTransition}
      data-transition-complete={displayedTransition === "none" || transitionFinished}
      onAnimationEnd={onAnimationEnd}
    >
      <div ref={canvasRef} className="stage-slide-runtime" />
      {status === "error" ? (
        <img
          className="stage-slide"
          src={imageUrl}
          alt={accessibilityLabel}
          onError={() => onFailure?.()}
        />
      ) : null}
    </div>
  );
}

export const RenderedSlidePlayer = forwardRef(RenderedSlidePlayerComponent);
