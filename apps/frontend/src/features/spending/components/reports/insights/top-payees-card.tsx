import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { PrivacyAmount } from "@wealthfolio/ui";
import { Card } from "@wealthfolio/ui/components/ui/card";

import type { TaxonomyCategory } from "@/lib/types";

import { UNCATEGORIZED_CATEGORY_ID } from "../../../lib/insight-projection";
import type { ReportsRange } from "../../../lib/reports-period";
import { formatZonedDateKey } from "../../../lib/timezone";
import type { CategoryBreakdownRow } from "../../../types/report";

/** How many payees the card lists. The rest are one filter away in the list. */
const MAX_PAYEES = 5;

interface TopPayeesCardProps {
  /** Spending by payee from the insight; the uncategorized row is spending with no payee. */
  rows: CategoryBreakdownRow[];
  payees: TaxonomyCategory[];
  currency: string;
  /** The period shown, carried into each payee's link to its transactions. */
  range: ReportsRange;
  /** The application's timezone, which the period's days are in. */
  timezone?: string | null;
}

/**
 * The payees the period's spending went to, largest first, each linking to
 * its transactions. Renders nothing until some spending in the period has a
 * payee.
 */
export function TopPayeesCard({ rows, payees, currency, range, timezone }: TopPayeesCardProps) {
  const { t } = useTranslation();
  const nameById = useMemo(() => new Map(payees.map((p) => [p.id, p.name])), [payees]);
  const top = useMemo(
    () =>
      rows
        .filter((row) => row.categoryId !== UNCATEGORIZED_CATEGORY_ID && row.amount > 0)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, MAX_PAYEES),
    [rows],
  );
  if (top.length === 0) return null;

  const largest = top[0].amount;
  const transactionsLink = (payeeId: string) => {
    const params = new URLSearchParams({
      tab: "spending",
      payees: payeeId,
      from: formatZonedDateKey(range.start, timezone),
      to: formatZonedDateKey(range.end, timezone),
    });
    return `/activities?${params.toString()}`;
  };

  return (
    <Card className="p-5" data-testid="top-payees-card">
      <h3 className="text-muted-foreground/70 text-2xs font-semibold tracking-[0.12em] uppercase">
        {t("spending:insightsPage.topPayees")}
      </h3>
      <ul className="mt-3 space-y-2.5">
        {top.map((row) => (
          <li key={row.categoryId}>
            <Link
              to={transactionsLink(row.categoryId)}
              className="hover:bg-muted/40 -mx-2 block rounded-md px-2 py-1 transition-colors"
            >
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  {nameById.get(row.categoryId) ?? row.categoryId}
                </span>
                <span className="shrink-0 font-medium tabular-nums">
                  <PrivacyAmount value={row.amount} currency={currency} />
                </span>
              </div>
              {/* Bars compare the payees with each other, so the largest is full width. */}
              <div className="bg-muted mt-1 h-1 overflow-hidden rounded-full">
                <div
                  className="bg-primary/60 h-full rounded-full"
                  style={{ width: `${(row.amount / largest) * 100}%` }}
                />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
