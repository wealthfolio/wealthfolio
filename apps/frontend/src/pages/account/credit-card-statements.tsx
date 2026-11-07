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
  PrivacyAmount,
  Skeleton,
  useDateFormatting,
} from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
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
      <CardHeader>
        <CardTitle>{t("account:billing.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
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
            <ul className="divide-y">
              {query.data.slice(0, 2).map((statement) => (
                <StatementRow
                  key={statement.closingDate}
                  accountId={account.id}
                  statement={statement}
                />
              ))}
            </ul>
            {query.data.length > 2 && (
              <details>
                <summary className="cursor-pointer text-sm">
                  {t("account:billing.previous")}
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
            <p className="text-muted-foreground text-xs">{t("account:billing.balance_hint")}</p>
          </>
        )}
      </CardContent>
    </Card>
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
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">
          <Link className="hover:underline" to={`/activities?${params}`}>
            {formatCalendarDateRange(statement.startDate, statement.closingDate)}
          </Link>
        </p>
        <p className="text-muted-foreground text-xs">
          {statement.isClosed ? t("account:billing.closed") : t("account:billing.open")}
          {" · "}
          {t("account:billing.due", { date: formatCalendarDate(statement.dueDate) })}
        </p>
      </div>
      <div className="max-w-full space-y-1 text-end text-sm">
        <p className="text-muted-foreground text-xs">
          {statement.isClosed
            ? t("account:billing.statement_balance")
            : t("account:billing.balance_so_far")}
        </p>
        {statement.balances.map(({ currency, balance }) => (
          <p key={currency}>
            <PrivacyAmount value={Number(balance)} currency={currency} />
          </p>
        ))}
      </div>
    </li>
  );
}
