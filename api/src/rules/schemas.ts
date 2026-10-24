import { z } from 'zod';

/**
 * Parameter shape for each rule in the `rules` table. Used twice:
 * the engine validates before evaluating, and PATCH /rules validates what admins submit.
 */
export const ruleParamSchemas: Record<string, z.ZodTypeAny> = {
  velocity_5_in_10m: z
    .object({
      count: z.number().int().min(2).max(100),
      window_minutes: z.number().int().min(1).max(1440),
    })
    .strict(),
  new_city: z
    .object({
      compare_last_n: z.number().int().min(1).max(20),
      window_minutes: z.number().int().min(1).max(10_080),
    })
    .strict(),
  amount_spike: z
    .object({
      multiplier: z.number().min(1.5).max(1000),
      window_days: z.number().int().min(1).max(365),
      min_history: z.number().int().min(1).max(1000).optional(),
    })
    .strict(),
  dormant_account: z
    .object({
      inactive_days: z.number().int().min(7).max(3650),
      min_amount: z.number().positive(),
    })
    .strict(),
};
