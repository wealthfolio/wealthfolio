import { FacetedFilter } from "@wealthfolio/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { HoldingsVisibilityFilter } from "./holdings-visibility";

interface HoldingsVisibilityFacetProps {
  value: HoldingsVisibilityFilter[];
  onChange: (value: HoldingsVisibilityFilter[]) => void;
  showClosedPositions?: boolean;
}

export function HoldingsVisibilityFacet({
  value,
  onChange,
  showClosedPositions = true,
}: HoldingsVisibilityFacetProps) {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      [
        { value: "open", label: t("holdings:open") },
        ...(showClosedPositions ? [{ value: "closed", label: t("holdings:closed") }] : []),
        { value: "cash", label: t("holdings:cash") },
      ] as { value: HoldingsVisibilityFilter; label: string }[],
    [showClosedPositions, t],
  );

  return (
    <FacetedFilter
      title={t("common:view")}
      options={options}
      selectedValues={new Set(value)}
      onFilterChange={(values) => {
        const nextValues = Array.from(values) as HoldingsVisibilityFilter[];
        onChange(nextValues.length > 0 ? nextValues : ["open"]);
      }}
    />
  );
}
