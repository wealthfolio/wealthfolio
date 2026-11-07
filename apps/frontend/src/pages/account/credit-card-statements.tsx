import { getCreditCardStatements, type CreditCardStatement } from "@/adapters";
import { getCreditCardBillingSettings } from "@/lib/credit-card-billing";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import type { Account } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Icons,
  PrivacyAmount,
  Skeleton,
  useDateFormatting,
} from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { buttonVariants } from "@wealthfolio/ui/components/ui/button-variants";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

export function CreditCardStatements({ account }: { account: Account }) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const billing = getCreditCardBillingSettings(account.meta);
  const query = useQuery({
    queryKey: [
      QueryKeys.CREDIT_CARD_STATEMENTS,
      account.id,
      billing?.closingDay,
      billing?.dueDay,
      settings?.timezone,
    ],
    queryFn: () => getCreditCardStatements(account.id),
    enabled: billing !== null,
    refetchInterval: 60_000,
  });

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-6">
        <CardTitle>{t("account:billing.title")}</CardTitle>
        {billing && (
          <Link
            to="/settings/accounts"
            className={buttonVariants({ variant: "ghost", className: "min-h-11" })}
            aria-label={t("account:billing.manage")}
          >
            <Icons.Settings className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t("account:billing.manage")}</span>
          </Link>
        )}
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 sm:px-6 sm:pb-6">
        {!billing ? (
          <p className="text-muted-foreground text-sm">
            <Link to="/settings/accounts" className="underline">
              {t("account:billing.setup")}
            </Link>
          </p>
        ) : query.isError ? (
          <div role="alert" className="space-y-2">
            <p>{t("account:billing.load_error")}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              {t("common:retry")}
            </Button>
          </div>
        ) : query.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            <ul className="grid gap-4 md:grid-cols-2 md:gap-8">
              {query.data.slice(0, 2).map((statement) => (
                <StatementSummary
                  key={statement.closingDate}
                  accountId={account.id}
                  statement={statement}
                />
              ))}
            </ul>
            {query.data.length > 2 && (
              <details className="group border-t">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm [&::-webkit-details-marker]:hidden">
                  {t("account:billing.previous")}
                  <Icons.ChevronDown
                    className="size-4 shrink-0 group-open:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <ul className="mt-2 divide-y">
                  {query.data.slice(2).map((statement) => (
                    <StatementRow
                      key={statement.closingDate}
                      accountId={account.id}
                      statement={statement}
                    />
                  ))}
                </ul>
              </details>
            )}
            <details className="group border-t">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm [&::-webkit-details-marker]:hidden">
                {t("account:billing.calculation_help")}
                <Icons.ChevronDown
                  className="size-4 shrink-0 group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <p className="text-muted-foreground max-w-3xl pb-2 text-sm leading-relaxed">
                {t("account:billing.balance_hint")}
              </p>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatementSummary({
  accountId,
  statement,
}: {
  accountId: string;
  statement: CreditCardStatement;
}) {
  const { t } = useTranslation();
  const { formatCalendarDate, formatCalendarDateRange } = useDateFormatting();
  const params = new URLSearchParams({
    account: accountId,
    from: statement.startDate,
    to: statement.closingDate,
  });
  return (
    <li className="min-w-0 space-y-3 border-t pt-4 first:border-0 first:pt-0 md:space-y-4 md:border-s md:border-t-0 md:ps-8 md:pt-0 md:first:ps-0">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">
          {statement.isClosed
            ? t("account:billing.last_closed")
            : t("account:billing.current_balance")}
        </h3>
        {statement.balances.map(({ currency, balance }) => (
          <p
            key={currency}
            className="text-3xl font-semibold tracking-tight break-words tabular-nums"
          >
            <PrivacyAmount value={Number(balance)} currency={currency} />
          </p>
        ))}
        <p className="text-muted-foreground text-sm">
          {!statement.isClosed && <>{t("account:billing.open")} · </>}
          {formatCalendarDateRange(statement.startDate, statement.closingDate)}
        </p>
      </div>
      <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
        <div className="space-y-1">
          <dt className="text-muted-foreground">
            {statement.isClosed ? t("account:billing.closed_on") : t("account:billing.closes_on")}
          </dt>
          <dd className="font-medium">{formatCalendarDate(statement.closingDate)}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">{t("account:billing.payment_due")}</dt>
          <dd className="font-medium">{formatCalendarDate(statement.dueDate)}</dd>
        </div>
      </dl>
      <p className="text-muted-foreground text-sm">
        {statement.isClosed ? t("account:billing.closed_hint") : t("account:billing.current_hint")}
      </p>
      <Link
        to={`/activities?${params}`}
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium hover:underline"
      >
        {t("account:billing.view_transactions")}
        <Icons.ArrowRight className="size-4 shrink-0 rtl:rotate-180" aria-hidden="true" />
      </Link>
    </li>
  );
}

function StatementRow({
  accountId,
  statement,
}: {
  accountId: string;
  statement: CreditCardStatement;
}) {
  const { t } = useTranslation();
  const { formatCalendarDate, formatCalendarDateRange } = useDateFormatting();
  const params = new URLSearchParams({
    account: accountId,
    from: statement.startDate,
    to: statement.closingDate,
  });
  return (
    <li>
      <Link
        className="flex min-h-11 flex-wrap items-center justify-between gap-3 py-3 hover:underline"
        to={`/activities?${params}`}
      >
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {formatCalendarDateRange(statement.startDate, statement.closingDate)}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("account:billing.due", { date: formatCalendarDate(statement.dueDate) })}
          </p>
        </div>
        <div className="max-w-full space-y-1 text-end text-sm break-words tabular-nums">
          <p className="text-muted-foreground text-xs">{t("account:billing.statement_balance")}</p>
          {statement.balances.map(({ currency, balance }) => (
            <p key={currency}>
              <PrivacyAmount value={Number(balance)} currency={currency} />
            </p>
          ))}
        </div>
      </Link>
    </li>
  );
}
