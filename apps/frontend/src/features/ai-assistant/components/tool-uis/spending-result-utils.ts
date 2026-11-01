/** Saved successful tool results are wrapped as {data, meta} on chat reload. */
export function unwrapSpendingResult<T>(value: unknown): T | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = "data" in value ? value.data : value;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload as T;
}

export function categoryPickerScope(taxonomyId?: string | null) {
  switch (taxonomyId) {
    case "income_sources":
      return "income" as const;
    case "savings_categories":
      return "saving" as const;
    case "spending_categories":
      return "expense" as const;
    default:
      return undefined;
  }
}
