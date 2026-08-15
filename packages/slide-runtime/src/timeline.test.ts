import { describe, expect, test } from "bun:test";
import type { SlideTimeline } from "./timeline.ts";
import { parseSlideTimeline } from "./timeline.ts";

const slideKey = `slide_${"a".repeat(64)}`;

function validTimeline() {
  return {
    slide_key: slideKey,
    click_groups: [
      [
        {
          trigger: "on_click",
          effect_class: "entrance",
          preset_id: 10,
          preset_subtype: null,
          duration_ms: 500,
          delay_ms: 20,
          target: {
            shape_id: 2,
            shape_name: "Title",
            svg_element_id: "id3",
          },
          behavior: { kind: "wipe", direction: "in", edge: "left" },
        },
      ],
    ],
    transition: { kind: "fade", advance_on_click: true },
    unsupported: [],
  } satisfies SlideTimeline;
}

describe("parseSlideTimeline", () => {
  test("parses the frozen snake_case timeline contract", () => {
    expect(parseSlideTimeline(validTimeline())).toEqual(validTimeline());
  });

  test("applies the Python contract defaults", () => {
    expect(parseSlideTimeline({ slide_key: slideKey })).toEqual({
      slide_key: slideKey,
      click_groups: [],
      transition: null,
      unsupported: [],
    });
  });

  test("rejects malformed fields and unknown keys", () => {
    expect(() =>
      parseSlideTimeline({
        ...validTimeline(),
        click_groups: [
          [
            {
              ...validTimeline().click_groups[0]?.[0],
              behavior: { kind: "wipe", direction: "sideways", edge: "left" },
            },
          ],
        ],
      }),
    ).toThrow();
    expect(() => parseSlideTimeline({ ...validTimeline(), extra: true })).toThrow();
    expect(() => parseSlideTimeline({ ...validTimeline(), slide_key: "slide_short" })).toThrow();
  });

  test("parses every behavior variant through the discriminated union", () => {
    const behaviors = [
      { kind: "fade", direction: "out" },
      { kind: "wipe", direction: "in", edge: "up" },
      { kind: "motion", path: "M 0 1 L 0 0 E" },
      { kind: "color", from_color: "#112233", to_color: "#AABBCC" },
    ];
    const effect = validTimeline().click_groups[0]?.[0];
    expect(effect).toBeDefined();
    const parsed = parseSlideTimeline({
      ...validTimeline(),
      click_groups: behaviors.map((behavior) => [{ ...effect, behavior }]),
    });
    expect(parsed.click_groups.map((group) => group[0]?.behavior.kind)).toEqual([
      "fade",
      "wipe",
      "motion",
      "color",
    ]);
  });
});
