import { useCallback } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Button, Icons, Page, PageContent, PageHeader } from "@wealthfolio/ui";

import { BudgetEditor } from "../components/budget-editor";
import { useSpendingSettings } from "../hooks/use-spending-settings";

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Strict YYYY-MM check so `?month=garbage` doesn't poison the editor. */
function isValidMonthKey(s: string | null): s is string {
  return !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export default function SpendingBudgetPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isEnabled, isLoading: settingsLoading } = useSpendingSettings();
  // URL-driven so `/spending/budget?month=2026-03` is shareable + reload-stable.
  // Matches the Insights / Transactions pattern; falls back to the current
  // local month when absent or malformed.
  const urlMonth = searchParams.get("month");
  const monthKey = isValidMonthKey(urlMonth) ? urlMonth : currentMonthKey();
  const setMonthKey = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set("month", next);
          return p;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  if (!settingsLoading && !isEnabled) {
    return <Navigate to="/dashboard?tab=spending" replace />;
  }

  const headerActions = (
    <div className="flex items-center gap-2">
      <MonthSwitcher monthKey={monthKey} onChange={setMonthKey} />
      <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
        <Link to="/settings/spending/setup">
          <Icons.Settings className="mr-1.5 h-3.5 w-3.5" />
          {t("spending:budgetPage.defaults")}
        </Link>
      </Button>
    </div>
  );

  return (
    <Page>
      <PageHeader
        heading={t("spending:budgetPage.heading")}
        text={t("spending:budgetPage.subheading")}
        onBack={() => {
          if (window.history.length > 1) navigate(-1);
          else navigate("/dashboard?tab=spending");
        }}
        actions={headerActions}
      />
      <PageContent className="space-y-5">
        {settingsLoading ? null : <BudgetEditor mode="monthly" periodKey={monthKey} />}
      </PageContent>
    </Page>
  );
}

function MonthSwitcher({
  monthKey,
  onChange,
}: {
  monthKey: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const shift = (delta: number) => {
    const [year, month] = monthKey.split("-").map(Number);
    const date = new Date(year, (month ?? 1) - 1 + delta, 1);
    onChange(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  };

  const current = currentMonthKey();

  return (
    <div className="bg-card/40 border-border/60 shadow-xs inline-flex items-center gap-0.5 rounded-full border px-1 py-0.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="hover:bg-muted/60 h-7 w-7 rounded-full p-0"
        aria-label={t("spending:calendar.previousMonth")}
        onClick={() => shift(-1)}
      >
        <Icons.ChevronLeft className="h-4 w-4" />
      </Button>
      <label className="hover:bg-muted/40 flex cursor-pointer items-center gap-1 rounded-full px-2 transition-colors">
        <Icons.Calendar className="text-muted-foreground h-3.5 w-3.5" />
        <input
          type="month"
          value={monthKey}
          onChange={(event) => onChange(event.target.value || current)}
          className="text-foreground h-7 w-[110px] cursor-pointer bg-transparent text-xs outline-none"
        />
      </label>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="hover:bg-muted/60 h-7 w-7 rounded-full p-0"
        aria-label={t("spending:calendar.nextMonth")}
        onClick={() => shift(1)}
      >
        <Icons.ChevronRight className="h-4 w-4" />
      </Button>
      {monthKey !== current && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:bg-muted/60 hover:text-foreground h-7 rounded-full px-2.5 text-xs"
          onClick={() => onChange(current)}
        >
          {t("spending:period.thisMonth")}
        </Button>
      )}
    </div>
  );
}
