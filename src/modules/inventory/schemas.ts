import { z } from "zod";
import { CABIN_CODES } from "@/models";

export const bookingClassSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z]$/, "Booking class must be a single letter"));

const cabinSchema = z.enum(CABIN_CODES);
const classList = z.array(bookingClassSchema).min(1);

export const loadFactorRuleSchema = z.object({
  thresholdPct: z.number().min(0).max(100),
  closeClasses: classList,
});

export const timeToDepartureRuleSchema = z.object({
  daysBeforeDeparture: z.number().min(0),
  closeClasses: classList,
});

/** Optional configuration when creating a flight's inventory; everything defaults from the aircraft layout. */
export const inventoryConfigSchema = z.object({
  cabins: z
    .array(
      z.object({
        cabin: cabinSchema,
        capacity: z.number().int().min(1).optional(),
        buckets: z
          .array(z.object({ class: bookingClassSchema, authorized: z.number().int().min(0).optional() }))
          .min(1)
          .optional(),
      }),
    )
    .min(1)
    .optional(),
  loadFactorRules: z.array(loadFactorRuleSchema).optional(),
  timeToDepartureRules: z.array(timeToDepartureRuleSchema).optional(),
});

export const patchBucketSchema = z
  .object({
    open: z.boolean().optional(),
    authorized: z.number().int().min(0).optional(),
    /** Hand the bucket back to the rules engine (clears the manual override). */
    releaseToRules: z.boolean().optional(),
  })
  .refine((v) => v.open !== undefined || v.authorized !== undefined || v.releaseToRules, {
    message: "Provide at least one of: open, authorized, releaseToRules",
  });

export const rulesSchema = z.object({
  loadFactorRules: z.array(loadFactorRuleSchema).default([]),
  timeToDepartureRules: z.array(timeToDepartureRuleSchema).default([]),
});

export const availabilityQuerySchema = z.object({
  history: z.enum(["true", "false"]).optional(),
});

export type InventoryConfig = z.infer<typeof inventoryConfigSchema>;
export type RulesInput = z.infer<typeof rulesSchema>;
export type PatchBucketInput = z.infer<typeof patchBucketSchema>;
