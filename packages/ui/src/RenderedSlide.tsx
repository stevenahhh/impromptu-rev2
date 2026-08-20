import { useState } from "react";

export interface RenderedSlideSource {
  readonly imageUrl: string;
  readonly imageContentHash: string;
  readonly accessibilityLabel: string;
}

export type RenderedSlideStatus = "loading" | "active" | "error";

export interface RenderedSlideProps {
  readonly slide: RenderedSlideSource;
  readonly loadingLabel: string;
  readonly errorLabel: string;
}

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

/** Rebase a published deck-asset URL onto a browser-safe origin or same-origin route. */
export function rebaseDeckAssetUrl(url: string, base = ""): string {
  try {
    const parsed = new URL(url, "http://deck-asset.invalid");
    if (!parsed.pathname.startsWith("/v1/deck-assets/")) return url;
    return `${base}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
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

  for (const attribute of source.attributes) {
    if (attribute.namespaceURI === XMLNS_NAMESPACE) continue;
    const localName = attribute.localName.toLowerCase();
    if (localName.startsWith("on")) return null;
    if (attribute.namespaceURI === XML_NAMESPACE && localName === "base") return null;

    if (localName === "href") {
      const href = safeHref(source, attribute.value, sourceUrl);
      if (href === null) return null;
      if (href !== attribute.value) {
        // DOMParser owns this detached document, so rebasing cannot execute live-page style.
        source.setAttributeNS(attribute.namespaceURI, attribute.name, href);
      }
    } else if (!cssValueIsSafe(attribute.value)) {
      return null;
    }
  }

  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) continue;
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return null;
    const childElement = child as Element;
    // LibreOffice emits inert metadata in foreign namespaces. The drawing tree remains SVG-only.
    if (childElement.namespaceURI !== SVG_NAMESPACE) {
      childElement.remove();
      continue;
    }
    if (cloneSafeSvgElement(childElement, sourceUrl) === null) return null;
  }
  return source as SVGElement;
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

async function verifiedSvgSource(slide: RenderedSlideSource, signal: AbortSignal): Promise<string> {
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

  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function loadVerifiedSvg(
  slide: RenderedSlideSource,
  signal: AbortSignal,
): Promise<SVGSVGElement> {
  const source = await verifiedSvgSource(slide, signal);
  const svg = parseSafeSvg(source, slide.imageUrl);
  if (svg === null) throw new Error("Rendered slide is not a safe SVG document");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", slide.accessibilityLabel);
  return svg;
}

export function RenderedSlide({ slide, loadingLabel, errorLabel }: RenderedSlideProps) {
  const { imageUrl, accessibilityLabel } = slide;
  const [status, setStatus] = useState<RenderedSlideStatus>("loading");

  return (
    <div className="ui-rendered-slide" data-rendered-slide={status}>
      {status === "error" ? null : (
        <div className="ui-rendered-slide__canvas">
          <img
            className="ui-rendered-slide__image"
            src={imageUrl}
            alt={accessibilityLabel}
            onLoad={() => setStatus("active")}
            onError={() => setStatus("error")}
          />
        </div>
      )}
      {status === "loading" ? (
        <output className="ui-rendered-slide__status">{loadingLabel}</output>
      ) : null}
      {status === "error" ? (
        <p className="ui-rendered-slide__status" role="alert">
          {errorLabel}
        </p>
      ) : null}
    </div>
  );
}
