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
  const pattern = new RegExp(`^${prefix}(0|[1-9][0-9]*)$`);
  return z
    .string()
    .regex(pattern)
    .refine((value) => {
      if (!pattern.test(value)) return false;
      const digits = value.slice(prefix.length);
      return BigInt(digits) <= BigInt(Number.MAX_SAFE_INTEGER);
    }, "counter exceeds Number.MAX_SAFE_INTEGER")
    .brand<Brand>();
}

export function safeEncodedCounterValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const separator = value.lastIndexOf("_");
  if (separator < 0) return null;
  const numeric = Number(value.slice(separator + 1));
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function encodedCounterValue(value: string): number {
  const numeric = safeEncodedCounterValue(value);
  if (numeric === null) {
    throw new Error("encoded counter is outside the safe non-negative integer range");
  }
  return numeric;
}
