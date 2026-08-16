import { z } from "zod";
import { Sha256Schema } from "./common.ts";
import { DeckVersionIdSchema, PublicSlideKeySchema } from "./public-identifiers.ts";

// ---------------------------------------------------------------------------
// Runtime render metadata for SVG slides.
//
// Shape-compatible with @impromptu/slide-runtime's timeline schemas so a parsed
// artifact slide can be handed to the runtime player unchanged. Re-implemented
// (not imported) to keep @impromptu/contracts dependency-free. All objects are
// `.strict()`: unknown keys reject.
// ---------------------------------------------------------------------------

const SvgElementIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const MotionPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[MmLlCcQqAaHhVvZzEe0-9 ,.-]+$/);

export const RuntimeFadeBehaviorSchema = z
  .object({
    kind: z.literal("fade"),
    direction: z.enum(["in", "out"]),
  })
  .strict();

export const RuntimeWipeBehaviorSchema = z
  .object({
    kind: z.literal("wipe"),
    direction: z.enum(["in", "out"]),
    edge: z.enum(["left", "right", "up", "down"]),
  })
  .strict();

export const RuntimeMotionBehaviorSchema = z
  .object({
    kind: z.literal("motion"),
    path: MotionPathSchema,
  })
  .strict();

export const RuntimeColorBehaviorSchema = z
  .object({
    kind: z.literal("color"),
    from_color: HexColorSchema,
    to_color: HexColorSchema,
  })
  .strict();

export const RuntimeBehaviorSchema = z.discriminatedUnion("kind", [
  RuntimeFadeBehaviorSchema,
  RuntimeWipeBehaviorSchema,
  RuntimeMotionBehaviorSchema,
  RuntimeColorBehaviorSchema,
]);

export const RuntimeResolvedTargetSchema = z
  .object({
    shape_id: z.number().int().positive(),
    shape_name: z.string().min(1).max(128),
    svg_element_id: SvgElementIdSchema,
  })
  .strict();

export const RuntimeSlideEffectSchema = z
  .object({
    trigger: z.enum(["on_click", "with_previous", "after_previous"]),
    effect_class: z.enum(["entrance", "emphasis", "exit", "motion"]),
    preset_id: z.number().int().min(0),
    preset_subtype: z.number().int().min(0).nullable().default(null),
    duration_ms: z.number().int().min(0).max(600_000),
    delay_ms: z.number().int().min(0).max(600_000),
    target: RuntimeResolvedTargetSchema,
    behavior: RuntimeBehaviorSchema,
  })
  .strict();

export const RuntimeUnsupportedEffectSchema = z
  .object({
    reason_code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    preset_id: z.number().int().min(0).nullable().default(null),
    detail: z.string().min(1).max(512),
  })
  .strict();

export const RuntimeSlideTransitionSchema = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    advance_on_click: z.boolean().default(true),
  })
  .strict();

export const RuntimeSlideTimelineSchema = z
  .object({
    slide_key: PublicSlideKeySchema,
    click_groups: z.array(z.array(RuntimeSlideEffectSchema)).default([]),
    transition: RuntimeSlideTransitionSchema.nullable().default(null),
    unsupported: z.array(RuntimeUnsupportedEffectSchema).default([]),
  })
  .strict();

export const RuntimeEmbeddedFontSchema = z
  .object({
    family: z.string().min(1).max(256),
    url: z.url(),
    format: z.enum(["woff2", "woff", "truetype", "opentype"]),
  })
  .strict();

/** A bare FontFace URL or a full embedded-font entry. */
export const RuntimeFontReferenceSchema = z.union([RuntimeEmbeddedFontSchema, z.url()]);

export const PublishedSlideRuntimeSchema = z
  .object({
    timeline: RuntimeSlideTimelineSchema,
    fonts: z.array(RuntimeFontReferenceSchema).default([]),
  })
  .strict();

export const PublishedSlideImageSchema = z
  .object({
    url: z.url(),
    contentHash: Sha256Schema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const PublishedSlideSchema = z
  .object({
    publicSlideKey: PublicSlideKeySchema,
    ordinal: z.number().int().positive(),
    image: PublishedSlideImageSchema,
    accessibilityLabel: z.string().min(1).max(1_000),
    runtime: PublishedSlideRuntimeSchema.optional(),
  })
  .strict();

export const PublishedDeckArtifactSchema = z
  .object({
    deckVersion: DeckVersionIdSchema,
    manifestHash: Sha256Schema,
    title: z.string().min(1).max(500),
    slides: z.array(PublishedSlideSchema).min(1),
  })
  .strict();

export type PublishedDeckArtifact = z.infer<typeof PublishedDeckArtifactSchema>;

export type RuntimeFadeBehavior = z.infer<typeof RuntimeFadeBehaviorSchema>;
export type RuntimeWipeBehavior = z.infer<typeof RuntimeWipeBehaviorSchema>;
export type RuntimeMotionBehavior = z.infer<typeof RuntimeMotionBehaviorSchema>;
export type RuntimeColorBehavior = z.infer<typeof RuntimeColorBehaviorSchema>;
export type RuntimeBehavior = z.infer<typeof RuntimeBehaviorSchema>;
export type RuntimeResolvedTarget = z.infer<typeof RuntimeResolvedTargetSchema>;
export type RuntimeSlideEffect = z.infer<typeof RuntimeSlideEffectSchema>;
export type RuntimeUnsupportedEffect = z.infer<typeof RuntimeUnsupportedEffectSchema>;
export type RuntimeSlideTransition = z.infer<typeof RuntimeSlideTransitionSchema>;
export type RuntimeSlideTimeline = z.infer<typeof RuntimeSlideTimelineSchema>;
export type RuntimeEmbeddedFont = z.infer<typeof RuntimeEmbeddedFontSchema>;
export type RuntimeFontReference = z.infer<typeof RuntimeFontReferenceSchema>;
export type PublishedSlideRuntime = z.infer<typeof PublishedSlideRuntimeSchema>;
