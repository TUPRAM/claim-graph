import { z } from "zod";

export const publicProductionHealthSchema = z.object({
  status: z.enum(["ready", "degraded", "unhealthy"]),
  checkedAt: z.string().datetime()
}).strict();

export type PublicProductionHealth = z.infer<
  typeof publicProductionHealthSchema
>;

export function sanitizeProductionHealthForPublic(input: {
  status: "ready" | "degraded" | "unhealthy";
  checkedAt: string;
}): PublicProductionHealth {
  // Construct the public response field-by-field. Parsing an internal object
  // directly would make future internal fields eligible for accidental
  // exposure if this schema ever became permissive.
  return publicProductionHealthSchema.parse({
    status: input.status,
    checkedAt: input.checkedAt
  });
}
