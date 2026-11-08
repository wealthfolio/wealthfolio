import { useTranslation } from "react-i18next";
import type { IncompleteHoldingsAccount } from "@/lib/types";

export function HoldingsScopeNotice({
  isComplete,
  isLoading,
  isError,
  incompleteAccounts = [],
}: {
  isComplete: boolean;
  isLoading?: boolean;
  isError?: boolean;
  incompleteAccounts?: IncompleteHoldingsAccount[];
}) {
  const { t } = useTranslation();
  if (isComplete !== false || isLoading) return null;
  const unavailable =
    isError || incompleteAccounts.some((account) => account.status === "unavailable");
  return (
    <p role="status" className="text-muted-foreground rounded-md border px-4 py-3 text-sm">
      {t(unavailable ? "holdings:scope_unavailable" : "holdings:scope_updating")}
    </p>
  );
}
