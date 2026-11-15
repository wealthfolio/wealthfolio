import type { FxConversionIssue } from "@/lib/types";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

/** Kept beside the amount: a hover-only notice cannot qualify an unknown total. */
export function ValuationNotice({
  issues = [],
  history = false,
}: {
  issues?: FxConversionIssue[];
  history?: boolean;
}) {
  const { t } = useTranslation();
  const pairs = [...new Set(issues.map((issue) => `${issue.fromCurrency} → ${issue.toCurrency}`))];
  return (
    <div role="status" className="text-warning-subtle-foreground mt-2 text-sm">
      <p>{t(history ? "common:valuation_history_incomplete" : "common:valuation_incomplete")}</p>
      {pairs.length > 0 && (
        <Link to="/settings/general" className="underline underline-offset-4">
          <bdi>{pairs.join(", ")}</bdi>
        </Link>
      )}
    </div>
  );
}
