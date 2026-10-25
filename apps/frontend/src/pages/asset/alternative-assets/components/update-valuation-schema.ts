import { invalidTypeError, requiredError } from "@/lib/zod-errors";
import * as z from "zod";

/**
 * Zod schema for the update valuation form
 */
export const updateValuationSchema = z.object({
  // New value - allow zero (e.g. a paid-off liability) but not negative
  value: z.coerce
    .number({ error: invalidTypeError("Value must be a number.") })
    .min(0, "Value cannot be negative"),

  // As of date - required
  date: z.date({ error: requiredError("Date is required") }),

  // Optional notes
  notes: z.string().max(500, "Notes must be less than 500 characters").optional(),
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
