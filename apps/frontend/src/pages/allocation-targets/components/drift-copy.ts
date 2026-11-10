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

export function formatPp(
  bps: number,
  formatting: Pick<FormattingApi, "formatPercent">,
  decimals = 1,
) {
  return formatting.formatPercent(bps / 10000, {
    digits: decimals,
    signDisplay: bps > 0 ? "always" : "auto",
  });
}

export function formatTolerance(bps: number, formatting: Pick<FormattingApi, "formatPercent">) {
  return `±${formatting.formatPercent(bps / 10000, { digits: Number.isInteger(bps / 100) ? 0 : 1 })}`;
}

export function formatRoundedCurrency(
  amount: number,
  currency: string,
  formatting: Pick<FormattingApi, "formatRoundedAmount">,
) {
  return formatting.formatRoundedAmount(amount, currency);
}
