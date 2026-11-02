import type { TFunction } from "i18next";
import type { FormattingApi } from "@wealthfolio/ui";
import { getTaxonomyLabel } from "@/lib/taxonomy-labels";

export function categoryNoun(
  t: TFunction,
  taxonomyId: string,
  _taxonomyName: string | undefined,
  count?: number,
) {
  const kind =
    (
      { asset_classes: "assetClass", regions: "region", industries_gics: "industry" } as Record<
        string,
        string
      >
    )[taxonomyId] ?? "category";
  return t(`allocation:categoryNouns.${kind}`, { count });
}

export function taxonomyLabel(t: TFunction, taxonomyId: string, taxonomyName: string | undefined) {
  return taxonomyName
    ? getTaxonomyLabel(t, taxonomyId, taxonomyName)
    : t("allocation:editor.category");
}

export function targetLabel(t: TFunction, targetName: string | undefined) {
  return targetName?.trim() || t("allocation:editor.savedTarget");
}

export function formatPp(bps: number, decimals = 1) {
  const pp = bps / 100;
  return `${pp > 0 ? "+" : ""}${pp.toFixed(decimals)}%`;
}

export function formatTolerance(bps: number) {
  const pp = bps / 100;
  const value = Number.isInteger(pp) ? pp.toFixed(0) : pp.toFixed(1);
  return `±${value}%`;
}

export function formatRoundedCurrency(
  amount: number,
  currency: string,
  formatting: Pick<FormattingApi, "formatRoundedAmount">,
) {
  return formatting.formatRoundedAmount(amount, currency);
}
