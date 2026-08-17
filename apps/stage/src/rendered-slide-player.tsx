import type { PublishedSlideRuntime, RuntimeEmbeddedFont } from "@impromptu/contracts";
import { createSlidePlayer, type SlidePlayer } from "@impromptu/slide-runtime";
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
}

type RuntimeStatus = "loading" | "active" | "error";
type SupportedTransition = "fade" | "none";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const MAX_SVG_BYTES = 16_000_000;
const MAX_SVG_ELEMENTS = 250_000;
const SVG_FRAGMENT_REFERENCE = /^#[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const FORBIDDEN_SVG_ELEMENTS = new Set([
  "a",
  "animate",
  "animatemotion",
  "animatetransform",
  "audio",
  "discard",
  "embed",
  "foreignobject",
  "handler",
  "iframe",
  "object",
  "script",
  "set",
  "style",
  "video",
]);

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

function cssValueIsSafe(value: string): boolean {
  if (/(?:javascript\s*:|data\s*:|@import|expression\s*\(|-moz-binding)/i.test(value)) {
    return false;
  }
  const withoutSafeFragments = value.replace(
    /url\s*\(\s*(["']?)(#[A-Za-z][A-Za-z0-9_.:-]{0,127})\1\s*\)/gi,
    "",
  );
  return !/url\s*\(/i.test(withoutSafeFragments);
}

function safeHref(element: Element, value: string, sourceUrl: string): string | null {
  if (SVG_FRAGMENT_REFERENCE.test(value)) return value;
  if (element.localName.toLowerCase() !== "image") return null;
  try {
    const source = new URL(sourceUrl, window.location.href);
    const resolved = new URL(value, source);
    return (resolved.protocol === "https:" || resolved.protocol === "http:") &&
      resolved.origin === source.origin
      ? resolved.href
      : null;
  } catch {
    return null;
  }
}

function cloneSafeSvgElement(source: Element, sourceUrl: string): SVGElement | null {
  if (
    source.namespaceURI !== SVG_NAMESPACE ||
    FORBIDDEN_SVG_ELEMENTS.has(source.localName.toLowerCase())
  ) {
    return null;
  }

  const clone = document.createElementNS(SVG_NAMESPACE, source.localName);
  for (const attribute of source.attributes) {
    if (attribute.namespaceURI === XMLNS_NAMESPACE) continue;
    const localName = attribute.localName.toLowerCase();
    if (localName.startsWith("on")) return null;
    if (attribute.namespaceURI === XML_NAMESPACE && localName === "base") return null;

    let value = attribute.value;
    if (localName === "href") {
      const href = safeHref(source, value, sourceUrl);
      if (href === null) return null;
      value = href;
    } else if (!cssValueIsSafe(value)) {
      return null;
    }
    clone.setAttributeNS(attribute.namespaceURI, attribute.name, value);
  }

  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
      clone.append(document.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType === Node.COMMENT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) return null;
    const childElement = child as Element;
    // LibreOffice emits inert SMIL/OOo metadata in foreign namespaces inside <defs>.
    // The runtime uses the separately verified PPTX timeline, so drop those subtrees while
    // retaining the SVG drawing tree. Active or malformed content in the SVG namespace still
    // fails closed below.
    if (childElement.namespaceURI !== SVG_NAMESPACE) continue;
    const childClone = cloneSafeSvgElement(childElement, sourceUrl);
    if (childClone === null) return null;
    clone.append(childClone);
  }
  return clone;
}

function parseSafeSvg(source: string, sourceUrl: string): SVGSVGElement | null {
  const upper = source.toUpperCase();
  if (upper.includes("<!DOCTYPE") || upper.includes("<!ENTITY")) return null;

  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (
    parsed.querySelector("parsererror") !== null ||
    parsed.documentElement.localName !== "svg" ||
    parsed.getElementsByTagName("*").length > MAX_SVG_ELEMENTS
  ) {
    return null;
  }
  const clone = cloneSafeSvgElement(parsed.documentElement, sourceUrl);
  return clone instanceof SVGSVGElement ? clone : null;
}

async function verifiedSvg(
  slide: RenderedSlidePlayerSlide,
  signal: AbortSignal,
): Promise<SVGSVGElement> {
  const response = await fetch(slide.imageUrl, { signal });
  if (!response.ok) throw new Error(`Rendered slide fetch failed (${response.status})`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SVG_BYTES) {
    throw new Error("Rendered slide exceeds the SVG byte limit");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actualHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actualHash !== slide.imageContentHash) {
    throw new Error("Rendered slide bytes do not match imageContentHash");
  }

  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const svg = parseSafeSvg(source, slide.imageUrl);
  if (svg === null) throw new Error("Rendered slide is not a safe SVG document");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", slide.accessibilityLabel);
  return svg;
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
  { slide, runtime, occurrenceSeq = 0, onAllClickGroupsExhausted }: RenderedSlidePlayerProps,
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
      verifiedSvg(
        { publicSlideKey, imageUrl, imageContentHash, accessibilityLabel },
        abortController.signal,
      ),
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
  }, [
    occurrenceSeq,
    accessibilityLabel,
    imageContentHash,
    imageUrl,
    publicSlideKey,
    stableRuntime,
    transition,
  ]);

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
        <img className="stage-slide" src={imageUrl} alt={accessibilityLabel} />
      ) : null}
    </div>
  );
}

export const RenderedSlidePlayer = forwardRef(RenderedSlidePlayerComponent);
