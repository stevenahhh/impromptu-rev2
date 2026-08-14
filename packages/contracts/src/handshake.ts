import { z } from "zod";
import { VersionIdSchema } from "./common.ts";

export const ProtocolRangeSchema = z
  .object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  })
  .strict()
  .refine(({ min, max }) => min <= max, { message: "protocol min must not exceed max" });

export const BuildHandshakeSchema = z
  .object({
    releaseId: VersionIdSchema,
    protocolRange: ProtocolRangeSchema,
    buildId: VersionIdSchema,
  })
  .strict();

export type BuildHandshake = z.infer<typeof BuildHandshakeSchema>;
export type HandshakeCompatibility =
  | { compatible: true; protocolVersion: number }
  | { compatible: false; reason: "RELEASE_MISMATCH" | "PROTOCOL_RANGE_MISMATCH" };

export function checkHandshakeCompatibility(
  client: BuildHandshake,
  server: BuildHandshake,
): HandshakeCompatibility {
  if (client.releaseId !== server.releaseId) {
    return { compatible: false, reason: "RELEASE_MISMATCH" };
  }
  const lowestMaximum = Math.min(client.protocolRange.max, server.protocolRange.max);
  const highestMinimum = Math.max(client.protocolRange.min, server.protocolRange.min);
  if (lowestMaximum < highestMinimum) {
    return { compatible: false, reason: "PROTOCOL_RANGE_MISMATCH" };
  }
  return { compatible: true, protocolVersion: lowestMaximum };
}
