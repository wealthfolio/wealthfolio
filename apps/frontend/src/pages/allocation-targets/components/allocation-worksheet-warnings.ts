import type { TFunction } from "i18next";

import type { AllocationWorksheetResult, WorksheetWarning } from "@/lib/types";

/** How the user reads amounts, shares, dates, accounts and securities. */
export interface WarningFormatting {
  /** An amount in the planning currency. */
  amount: (value: number) => string;
  price: (value: number) => string;
  /** A share as a fraction of one. */
  percent: (fraction: number, digits: number) => string;
  /** A calendar date, as `YYYY-MM-DD`. */
  date: (isoDate: string) => string;
  accountName: (accountId: string) => string;
}

function bpsShare(bps: number, format: WarningFormatting): string {
  return format.percent(bps / 10_000, bps % 100 === 0 ? 0 : 2);
}

/**
 * Words a warning from the figures the core sent with it, in the user's
 * language and number format. A warning missing a figure its wording needs
 * keeps the core's English message.
 */
export function describeWarning(
  warning: WorksheetWarning,
  result: Pick<AllocationWorksheetResult, "lines">,
  format: WarningFormatting,
  t: TFunction,
): string {
  const facts = warning.facts ?? {};
  const symbol = warning.lineId
    ? result.lines.find((line) => line.lineId === warning.lineId)?.symbol
    : undefined;
  const key = (name: string) => `allocation:worksheet.warning.${name}`;
  const { amount, limit, unitPrice, shareBps, limitBps, accountId, asOf, reason } = facts;

  switch (warning.kind) {
    case "cash_unavailable":
      if (amount == null || limit == null) break;
      return t(key("cashUnavailable"), {
        amount: format.amount(amount),
        asked: format.amount(limit),
      });
    case "external_contribution":
      if (amount == null) break;
      return t(key("externalContribution"), { amount: format.amount(amount) });
    case "avoid_constraint":
      if (!symbol) break;
      return reason
        ? t(key("avoidConstraintReason"), { symbol, reason })
        : t(key("avoidConstraint"), { symbol });
    case "stale_quote":
      if (!symbol || !asOf) break;
      return t(key("staleQuote"), { symbol, date: format.date(asOf.slice(0, 10)) });
    case "stale_fx":
      if (!symbol || !asOf) break;
      return t(key("staleFx"), { symbol, date: format.date(asOf.slice(0, 10)) });
    case "unclassified_asset":
      if (!symbol) break;
      return t(key("unclassifiedAsset"), { symbol });
    case "partial_classification":
      if (!symbol || shareBps == null) break;
      return t(key("partialClassification"), {
        symbol,
        share: bpsShare(shareBps, format),
        rest: bpsShare(10_000 - shareBps, format),
      });
    case "below_one_unit":
      if (!symbol || amount == null || unitPrice == null) break;
      return t(key("belowOneUnit"), {
        symbol,
        amount: format.amount(amount),
        price: format.price(unitPrice),
      });
    case "below_minimum_line":
      if (!symbol || amount == null || limit == null) break;
      return t(key("belowMinimumLine"), {
        symbol,
        amount: format.amount(amount),
        minimum: format.amount(limit),
      });
    case "insufficient_funding":
      if (amount == null || limit == null) break;
      return t(key("insufficientFunding"), {
        amount: format.amount(amount),
        funding: format.amount(limit),
      });
    case "account_funding":
      if (amount == null || limit == null || !accountId) break;
      return t(key("accountFunding"), {
        amount: format.amount(amount),
        funding: format.amount(limit),
        account: format.accountName(accountId),
      });
    case "turnover_exceeded":
      if (shareBps == null || limitBps == null) break;
      return t(key("turnoverExceeded"), {
        share: bpsShare(shareBps, format),
        limit: bpsShare(limitBps, format),
      });
  }
  return warning.message;
}
