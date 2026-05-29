import { Navigate, useNavigate } from "react-router-dom";

import { Button, Icons } from "@wealthfolio/ui";

import { BudgetEditor } from "@/features/spending/components/budget-editor";
import { useSpendingSettings } from "@/features/spending/hooks/use-spending-settings";

import { SpendingBackLink } from "../components/spending-back-link";

export default function SpendingSetupPage() {
  const { isEnabled, isLoading: settingsLoading } = useSpendingSettings();
  const navigate = useNavigate();

  if (!settingsLoading && !isEnabled) {
    return <Navigate to="/settings/spending" replace />;
  }

  return (
    <div className="space-y-5">
      <SpendingBackLink />

      <header className="flex items-center gap-1.5 sm:block">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/settings/spending")}
          className="text-muted-foreground hover:text-foreground -ml-1 h-8 w-8 shrink-0 p-0 sm:hidden"
          aria-label="Back to Spending Tracker"
        >
          <Icons.ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-foreground text-base font-semibold tracking-tight sm:text-lg lg:text-xl">
            Default monthly budget plan
          </h1>
          <p className="text-muted-foreground mt-1 hidden text-sm sm:block">
            Define groups, default monthly targets, and rollover behavior. Used as the baseline for
            every month.
          </p>
        </div>
      </header>

      {settingsLoading ? null : <BudgetEditor mode="setup" periodKey="default" />}
    </div>
  );
}
