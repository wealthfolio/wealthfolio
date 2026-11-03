import { useDirection } from "@wealthfolio/ui";
import type { TFunction } from "i18next";
import { getCategoryLabel } from "@/lib/taxonomy-labels";
import { UNCLASSIFIED_CATEGORY_ID } from "./allocation-worksheet-utils";

/** The arrow from a figure now to the figure after it, pointing the way the line reads. */
export function useChangeArrow(): string {
  return useDirection() === "rtl" ? "←" : "→";
}

/** Display only: drift, synthetic positions and result exposures use distinct sentinel labels. */
export function worksheetCategoryLabel(
  t: TFunction,
  taxonomyId: string,
  categoryId: string,
  name: string,
): string {
  if (categoryId !== UNCLASSIFIED_CATEGORY_ID) {
    return getCategoryLabel(t, taxonomyId, categoryId, name);
  }
  switch (name) {
    case "Unknown":
      return t("taxonomies:unknown");
    case "Unclassified":
      return t("allocation:worksheet.unclassified");
    case "Unclassified exposure":
      return t("allocation:worksheet.unclassifiedExposure");
    default:
      return name;
  }
}
