import en from "./locales/en.json";
import ko from "./locales/ko.json";

export type Locale = "ko" | "en";
export type Messages = { readonly [Key in keyof typeof en]: string };

const catalogs = { en, ko } satisfies Record<Locale, Messages>;

export function messages(locale: Locale): Messages {
  return catalogs[locale];
}
