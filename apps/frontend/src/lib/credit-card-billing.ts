import { z } from "zod";

export const creditCardBillingSchema = z.object({
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
});

export function getCreditCardBillingSettings(meta?: string | null) {
  try {
    const parsed = JSON.parse(meta ?? "{}");
    const result = creditCardBillingSchema.safeParse(parsed?.creditCardBilling);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
