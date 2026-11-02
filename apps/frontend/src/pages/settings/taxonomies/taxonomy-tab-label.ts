import type { TFunction } from "i18next";
import english from "@/i18n/locales/en/taxonomies.json";
import { getTaxonomyLabel } from "@/lib/taxonomy-labels";

/** The built-in GICS tab is abbreviated; editable names and full titles are not. */
export function taxonomyTabLabel(t: TFunction, taxonomyId: string, name: string): string {
  const label = getTaxonomyLabel(t, taxonomyId, name);
  return taxonomyId === "industries_gics" && name === english.taxonomyNames.industries_gics
    ? label.replace(/\s*(?:\(GICS\)|（GICS）)$/, "")
    : label;
}
