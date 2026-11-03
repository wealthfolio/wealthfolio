import { invalidTypeError, requiredError } from "@/lib/zod-errors";
import * as z from "zod";

/**
 * Zod schema for the update valuation form
 */
export const updateValuationSchema = z.object({
  // New value - allow zero (e.g. a paid-off liability) but not negative
  value: z.coerce
    .number({ error: invalidTypeError("asset:updateValuation.validation.number") })
    .min(0, "asset:updateValuation.validation.non_negative"),

  // As of date - required
  date: z.date({ error: requiredError("activity:validation.date_is_required") }),

  // Optional notes
  notes: z.string().max(500, "asset:updateValuation.validation.notes").optional(),
});

export type UpdateValuationFormValues = z.infer<typeof updateValuationSchema>;

/**
 * Get default form values for the update valuation form
 */
export const getUpdateValuationDefaultValues = (
  currentValue?: string,
): UpdateValuationFormValues => ({
  value: currentValue ? parseFloat(currentValue) : 0,
  date: new Date(),
  notes: "",
});
