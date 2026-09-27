import { describe, expect, test } from "bun:test";

// Placeholders a component interpolates (e.g. "{count}") must exist in both locales: a key
// missing its variable renders a literal "{count}" to a presenter in one language.
function placeholders(message: unknown): string[] {
  return typeof message === "string"
    ? [...message.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1] ?? "").sort()
    : [];
}

describe("locale catalogs", () => {
  test("ko and en expose the same key set", async () => {
    const ko = await Bun.file(new URL("./locales/ko.json", import.meta.url)).json();
    const en = await Bun.file(new URL("./locales/en.json", import.meta.url)).json();
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
  });

  test("ko and en values interpolate the same placeholder set for every key", async () => {
    const ko = await Bun.file(new URL("./locales/ko.json", import.meta.url)).json();
    const en = await Bun.file(new URL("./locales/en.json", import.meta.url)).json();
    for (const key of Object.keys(en)) {
      expect(placeholders(ko[key]), `placeholder set for "${key}"`).toEqual(placeholders(en[key]));
    }
  });

  test("no catalog value is blank or leaks the placeholder braces", async () => {
    const ko = await Bun.file(new URL("./locales/ko.json", import.meta.url)).json();
    const en = await Bun.file(new URL("./locales/en.json", import.meta.url)).json();
    for (const [locale, catalog] of [
      ["ko", ko],
      ["en", en],
    ] as const) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect((value as string).trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
