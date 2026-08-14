import { z } from "zod";

export function prefixedId<const Brand extends string>(prefix: string) {
  return z
    .string()
    .min(prefix.length + 1)
    .max(200)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9._-]*$`))
    .brand<Brand>();
}

export function encodedCounter<const Brand extends string>(prefix: string) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}(0|[1-9][0-9]*)$`))
    .brand<Brand>();
}

export function encodedCounterValue(value: string): number {
  const separator = value.lastIndexOf("_");
  if (separator < 0) throw new Error("encoded counter is missing its domain prefix");
  const numeric = Number(value.slice(separator + 1));
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error("encoded counter is outside the safe non-negative integer range");
  }
  return numeric;
}
