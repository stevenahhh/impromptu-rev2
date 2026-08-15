import { z } from "zod";

const SlideKeySchema = z.string().regex(/^slide_[0-9a-f]{64}$/);
const SvgElementIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const MotionPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[MmLlCcQqAaHhVvZzEe0-9 ,.-]+$/);

export const FadeBehaviorSchema = z
  .strictObject({
    kind: z.literal("fade"),
    direction: z.enum(["in", "out"]),
  })
  .readonly();

export const WipeBehaviorSchema = z
  .strictObject({
    kind: z.literal("wipe"),
    direction: z.enum(["in", "out"]),
    edge: z.enum(["left", "right", "up", "down"]),
  })
  .readonly();

export const MotionBehaviorSchema = z
  .strictObject({
    kind: z.literal("motion"),
    path: MotionPathSchema,
  })
  .readonly();

export const ColorBehaviorSchema = z
  .strictObject({
    kind: z.literal("color"),
    from_color: HexColorSchema,
    to_color: HexColorSchema,
  })
  .readonly();

export const BehaviorSchema = z.discriminatedUnion("kind", [
  FadeBehaviorSchema,
  WipeBehaviorSchema,
  MotionBehaviorSchema,
  ColorBehaviorSchema,
]);

export const ResolvedTargetSchema = z
  .strictObject({
    shape_id: z.number().int().positive(),
    shape_name: z.string().min(1).max(128),
    svg_element_id: SvgElementIdSchema,
  })
  .readonly();

export const SlideEffectSchema = z
  .strictObject({
    trigger: z.enum(["on_click", "with_previous", "after_previous"]),
    effect_class: z.enum(["entrance", "emphasis", "exit", "motion"]),
    preset_id: z.number().int().min(0),
    preset_subtype: z.number().int().min(0).nullable().default(null),
    duration_ms: z.number().int().min(0).max(600_000),
    delay_ms: z.number().int().min(0).max(600_000),
    target: ResolvedTargetSchema,
    behavior: BehaviorSchema,
  })
  .readonly();

export const UnsupportedEffectSchema = z
  .strictObject({
    reason_code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    preset_id: z.number().int().min(0).nullable().default(null),
    detail: z.string().min(1).max(512),
  })
  .readonly();

export const SlideTransitionSchema = z
  .strictObject({
    kind: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    advance_on_click: z.boolean().default(true),
  })
  .readonly();

export const SlideTimelineSchema = z
  .strictObject({
    slide_key: SlideKeySchema,
    click_groups: z.array(z.array(SlideEffectSchema).readonly()).readonly().default([]),
    transition: SlideTransitionSchema.nullable().default(null),
    unsupported: z.array(UnsupportedEffectSchema).readonly().default([]),
  })
  .readonly();

export type FadeBehavior = z.infer<typeof FadeBehaviorSchema>;
export type WipeBehavior = z.infer<typeof WipeBehaviorSchema>;
export type MotionBehavior = z.infer<typeof MotionBehaviorSchema>;
export type ColorBehavior = z.infer<typeof ColorBehaviorSchema>;
export type Behavior = z.infer<typeof BehaviorSchema>;
export type ResolvedTarget = z.infer<typeof ResolvedTargetSchema>;
export type SlideEffect = z.infer<typeof SlideEffectSchema>;
export type UnsupportedEffect = z.infer<typeof UnsupportedEffectSchema>;
export type SlideTransition = z.infer<typeof SlideTransitionSchema>;
export type SlideTimeline = z.infer<typeof SlideTimelineSchema>;

export function parseSlideTimeline(input: unknown): SlideTimeline {
  return SlideTimelineSchema.parse(input);
}
