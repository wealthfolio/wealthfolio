/**
 * Region options in alphabetical order of their translated names, with "system"
 * kept first. Sorting by the shown label (not the code) keeps the list ordered
 * in every interface language.
 */
export function sortFormattingRegions<T extends readonly [string, string]>(
  regions: readonly T[],
  labelFor: (labelKey: T[1]) => string,
  locale: string | undefined,
): T[] {
  const collator = new Intl.Collator(locale);
  return [...regions].sort(([aValue, aKey], [bValue, bKey]) => {
    if (aValue === "system") return -1;
    if (bValue === "system") return 1;
    return collator.compare(labelFor(aKey), labelFor(bKey));
  });
}
