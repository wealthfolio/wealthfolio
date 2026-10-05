import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Icons, MoneyInput, ResponsiveSelect } from "@wealthfolio/ui";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Sheet, SheetDescription, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import { linkLoanPayment } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useAlternativeHoldings } from "@/hooks/use-alternative-assets";
import { AccountType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import type { ActivityDetails } from "@/lib/types";
import { invalidateAlternativeAssetQueries } from "../hooks/use-alternative-asset-mutations";
import { readActiveLoanProjection } from "../lib/loan-events";
import { isDuplicateEventError, loanErrorText } from "./loan-error-text";
import {
  LoanSheetBody,
  LoanSheetContent,
  LoanSheetFooter,
  LoanSheetHeader,
} from "./loan-sheet-content";

/** The fields read here, shared by the activity table and Spending rows. */
type PaymentActivity = Pick<ActivityDetails, "id" | "accountId" | "currency" | "metadata">;

interface ActivityLoanPaymentSheetProps {
  activity: PaymentActivity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the withdrawal is linked or unlinked. */
  onChanged?: () => void;
}

type Target = "instalment" | "extra";

/** The loan a withdrawal is tagged to, if any. */
function taggedLoan(activity: PaymentActivity): string | undefined {
  const tag = activity.metadata?.loan_payment as { loan_id?: unknown } | undefined;
  return typeof tag?.loan_id === "string" ? tag.loan_id : undefined;
}

/** From an account's activity: count a withdrawal as a payment on a loan, or stop counting it. */
export function ActivityLoanPaymentSheet({
  activity,
  open,
  onOpenChange,
  onChanged,
}: ActivityLoanPaymentSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const escrowId = useId();
  const { accounts } = useAccounts({ filterActive: false });
  const { data: holdings = [] } = useAlternativeHoldings({ enabled: open });
  const linkedTo = taggedLoan(activity);
  const isCash =
    accounts.find((account) => account.id === activity.accountId)?.accountType === AccountType.CASH;
  // Calculated loans in the withdrawal's currency can take it as a payment.
  const loans = holdings.filter(
    (holding) =>
      holding.kind.toLowerCase() === "liability" &&
      holding.currency === activity.currency &&
      !!readActiveLoanProjection(holding.metadata),
  );
  const [loanId, setLoanId] = useState<string>("");
  const [target, setTarget] = useState<Target>("instalment");
  const [escrow, setEscrow] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A link that matches a recorded extra repayment, waiting for the user's choice.
  const [duplicate, setDuplicate] = useState<Extract<
    Parameters<typeof linkLoanPayment>[1],
    { type: "link" }
  > | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoanId(linkedTo ?? "");
    setTarget("instalment");
    setEscrow(null);
    setError(null);
  }, [open, linkedTo]);
  // The replace prompt answers the link it was shown for, not a changed one.
  useEffect(() => setDuplicate(null), [open, loanId, target, escrow]);

  const change = async (link: Parameters<typeof linkLoanPayment>[1]) => {
    setBusy(true);
    setError(null);
    setDuplicate(null);
    try {
      await linkLoanPayment(activity.id, link);
      await Promise.all([
        invalidateAlternativeAssetQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] }),
      ]);
      onChanged?.();
      onOpenChange(false);
    } catch (cause) {
      if (isDuplicateEventError(cause) && link.type === "link") setDuplicate(link);
      else setError(loanErrorText(t, cause, "asset:loanEvents.failed"));
    } finally {
      setBusy(false);
    }
  };

  const loanName = (id: string) => holdings.find((holding) => holding.id === id)?.name ?? id;

  return (
    <Sheet open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <LoanSheetContent>
        <LoanSheetHeader>
          <SheetTitle>{t("asset:loanPayments.activity_title")}</SheetTitle>
          <SheetDescription>{t("asset:loanPayments.activity_description")}</SheetDescription>
        </LoanSheetHeader>
        <LoanSheetBody className="space-y-5">
          {linkedTo && (
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
              <span>{t("asset:loanPayments.linked_to", { loan: loanName(linkedTo) })}</span>
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() => change({ type: "unlink" })}
              >
                {t("asset:loanPayments.unlink")}
              </Button>
            </div>
          )}
          {!isCash ? (
            <p className="text-muted-foreground text-sm">{t("asset:loanPayments.not_eligible")}</p>
          ) : loans.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("asset:loanPayments.no_loans")}</p>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>{t("asset:loanPayments.loan")}</Label>
                <ResponsiveSelect
                  aria-label={t("asset:loanPayments.loan")}
                  value={loanId}
                  onValueChange={setLoanId}
                  options={loans.map((loan) => ({ value: loan.id, label: loan.name }))}
                  placeholder={t("asset:loanPayments.choose_loan")}
                  sheetTitle={t("asset:loanPayments.loan")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("asset:loanPayments.applies_to")}</Label>
                <ResponsiveSelect
                  aria-label={t("asset:loanPayments.applies_to")}
                  value={target}
                  onValueChange={(value) => setTarget(value as Target)}
                  options={[
                    { value: "instalment", label: t("asset:loanPayments.applies_instalment") },
                    { value: "extra", label: t("asset:loanPayments.applies_extra") },
                  ]}
                  sheetTitle={t("asset:loanPayments.applies_to")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={escrowId}>{t("asset:loanPayments.escrow")}</Label>
                <MoneyInput
                  id={escrowId}
                  value={escrow}
                  placeholder={t("asset:loanPayments.escrow_default")}
                  onValueChange={(value) => setEscrow(value ?? null)}
                />
              </div>
            </div>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          {duplicate && (
            <div className="space-y-2 rounded-md border px-3 py-2 text-sm" role="alert">
              <p>{t("asset:loanPayments.duplicates_event")}</p>
              <Button
                size="xs"
                disabled={busy !== false}
                onClick={() => change({ ...duplicate, replaceEvent: true })}
              >
                {t("asset:loanPayments.replace_event")}
              </Button>
            </div>
          )}
        </LoanSheetBody>
        <LoanSheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common:cancel")}
          </Button>
          {isCash && loans.length > 0 && (
            <Button
              disabled={busy || !loanId}
              onClick={() =>
                change({
                  type: "link",
                  loanId,
                  ...(escrow != null ? { escrow } : {}),
                  ...(target === "extra" ? { appliesTo: "extra" } : {}),
                })
              }
            >
              {busy && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
              {t("asset:loanPayments.link")}
            </Button>
          )}
        </LoanSheetFooter>
      </LoanSheetContent>
    </Sheet>
  );
}
