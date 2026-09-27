import { createContext, useContext } from "react";
import en from "./locales/en.json";
import ko from "./locales/ko.json";

export type StageLocale = "ko" | "en";
export type StageMessages = { readonly [Key in keyof typeof ko]: string };

const catalogs = { ko, en } satisfies Record<StageLocale, StageMessages>;

export function stageMessages(locale: StageLocale): StageMessages {
  return catalogs[locale];
}

function recognizedTag(tag: string | undefined): StageLocale | null {
  const base = (tag ?? "").split("-")[0]?.toLowerCase();
  return base === "ko" ? "ko" : base === "en" ? "en" : null;
}

/**
 * Audience-side language resolution. The `lang` query parameter wins because it is the one
 * channel the presenter's own Console choice can pass through when it opens the window; after
 * that the device's browser language applies, and Korean is the default for everything else.
 * Resolution happens once at app mount, so ?lang= on the landing URL survives the SPA
 * navigation onto /display/:displayId.
 */
export function resolveStageLocale(
  search: string,
  languageTags: readonly (string | undefined)[],
): StageLocale {
  const requested = recognizedTag(new URLSearchParams(search).get("lang") ?? undefined);
  if (requested !== null) return requested;
  for (const tag of languageTags) {
    const recognized = recognizedTag(tag);
    if (recognized !== null) return recognized;
  }
  return "ko";
}

const StageCopyContext = createContext<StageMessages>(catalogs.ko);

export const StageCopyProvider = StageCopyContext.Provider;

/** The resolved audience-language catalog for the mounted Stage route tree. */
export function useStageCopy(): StageMessages {
  return useContext(StageCopyContext);
}

/** Locale of the mounted Stage route tree, for document.title/lang sync. */
export const StageLocaleContext = createContext<StageLocale>("ko");

export function useStageLocale(): StageLocale {
  return useContext(StageLocaleContext);
}
