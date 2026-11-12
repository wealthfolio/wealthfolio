/** A missing accounting amount makes the combined amount unavailable. */
export function sumAmounts(values: Iterable<number | null | undefined>): number | null {
  let total = 0;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

export function subtractAmounts(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  return left == null || right == null ? null : left - right;
}
