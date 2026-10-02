import { LoanInterestMethodSelect } from "./loan-interest-method-select";
import type { LoanInterestMethod } from "../lib/loan-events";
import { AmountDisplay, Button, DatePickerInput, Icons, MoneyInput } from "@wealthfolio/ui";
import { Sheet, SheetDescription, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import {
  LoanSheetContent,
  LoanSheetHeader,
  LoanSheetBody,
  LoanSheetFooter,
} from "./loan-sheet-content";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Quote } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import { loanCalculationRequest } from "../hooks/use-loan-calculation";
import { inheritedLoanSettings } from "../lib/loan-event-editing";
import { recalculateLoan } from "@/adapters";
import { useQuery } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";

interface CloseLoanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (date: Date) => Promise<void>;
  originationDate: Date | null;
}

export function CloseLoanDialog({
  open,
  onOpenChange,
  onSubmit,
  originationDate,
}: CloseLoanDialogProps) {
  const { t } = useTranslation();
  const [date, setDate] = useState<Date>(() => new Date());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isDateInvalid = (originationDate !== null && date < originationDate) || date > new Date();

  useEffect(() => {
    if (open) setDate(new Date());
  }, [open]);

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(date);
      setDate(new Date());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <LoanSheetContent>
        <LoanSheetHeader>
          <SheetTitle>{t("asset:loanActions.close_loan")}</SheetTitle>
          <SheetDescription>{t("asset:loanActions.close_loan_description")}</SheetDescription>
        </LoanSheetHeader>
        <LoanSheetBody>
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.closure_date")}</Label>
            <DatePickerInput
              aria-label={t("asset:loanActions.closure_date")}
              value={date}
              onChange={(d) => d && setDate(d)}
              disabled={isSubmitting}
            />
          </div>
          {isDateInvalid && (
            <p className="text-destructive text-sm" role="alert">
              {t("asset:loanActions.validation.closure_date_invalid")}
            </p>
          )}
        </LoanSheetBody>
        <LoanSheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={isSubmitting || isDateInvalid}
          >
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {t("asset:loanActions.confirm_close")}
          </Button>
        </LoanSheetFooter>
      </LoanSheetContent>
    </Sheet>
  );
}

interface RecalculateScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currency: string;
  interestRate: number;
  endDate: Date | null;
  assetId: string;
  metadata: Record<string, unknown>;
  quoteHistory: Quote[];
  onSubmit: (newRate: number, effectiveDate: Date) => Promise<void>;
}

export function RecalculateScheduleDialog({
  open,
  onOpenChange,
  currency,
  interestRate,
  endDate,
  assetId,
  metadata,
  quoteHistory,
  onSubmit,
}: RecalculateScheduleDialogProps) {
  const { t, i18n } = useTranslation();
  const [effectiveDate, setEffectiveDate] = useState(() => new Date());
  const rateInputId = useId();
  const [newRate, setNewRate] = useState<string>(() => String(interestRate));
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setNewRate(String(interestRate));
      setEffectiveDate(new Date());
    }
  }, [interestRate, open]);

  const parsedRate = Number(newRate);
  const isRateInvalid =
    newRate === "" ||
    !Number.isFinite(parsedRate) ||
    parsedRate < 0 ||
    parsedRate > 100 ||
    effectiveDate > new Date();
  const request = {
    ...loanCalculationRequest(metadata, quoteHistory, formatDateISO(effectiveDate)),
    annualRate: parsedRate,
  };
  const {
    data: calculation,
    isFetching,
    isError,
  } = useQuery({
    queryKey: [QueryKeys.ASSET_DATA, assetId, "loan-recalculation", request],
    queryFn: () => recalculateLoan(request),
    enabled: open && !isRateInvalid,
  });
  const currentBalance = calculation?.currentBalance ?? 0;
  const remainingPayments = calculation?.remainingPayments ?? 0;
  const newPayment = calculation?.paymentAmount ?? null;
  const [submitError, setSubmitError] = useState(false);

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      setSubmitError(false);
      await onSubmit(parsedRate, effectiveDate);
    } catch {
      setSubmitError(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <LoanSheetContent>
        <LoanSheetHeader>
          <SheetTitle>{t("asset:loanActions.recalculate_schedule")}</SheetTitle>
          <SheetDescription>{t("asset:loanActions.recalculate_description")}</SheetDescription>
        </LoanSheetHeader>
        <LoanSheetBody>
          <div className="space-y-1.5">
            <Label>{t("asset:loanOverview.effective_date")}</Label>
            <DatePickerInput
              aria-label={t("asset:loanOverview.effective_date")}
              value={effectiveDate}
              onChange={(date) => date && setEffectiveDate(date)}
            />
          </div>
          <div className="bg-muted grid grid-cols-2 gap-x-4 gap-y-1 rounded-md px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              {t("asset:loanActions.recalculate_current_balance")}
            </span>
            <span className="text-right font-medium">
              <AmountDisplay value={currentBalance} currency={currency} />
            </span>
            <span className="text-muted-foreground">
              {t("asset:loanActions.remaining_payments")}
            </span>
            <span className="text-right font-medium">{remainingPayments}</span>
            {endDate && (
              <>
                <span className="text-muted-foreground">{t("asset:altContent.end_date")}</span>
                <span className="text-right font-medium">
                  {endDate.toLocaleDateString(i18n.language, {
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={rateInputId}>{t("asset:loanActions.recalculate_new_rate")}</Label>
            <MoneyInput
              id={rateInputId}
              maxDecimalPlaces={8}
              value={newRate}
              onValueChange={(value) => setNewRate(value == null ? "" : String(value))}
              disabled={isSubmitting}
            />
          </div>
          {newPayment !== null && (
            <div className="bg-muted rounded-md px-3 py-2 text-sm">
              <span className="text-muted-foreground">{t("asset:valueHistory.payment")}: </span>
              <span className="font-medium">
                <AmountDisplay value={newPayment} currency={currency} />
              </span>
            </div>
          )}
          {(isRateInvalid || isError || submitError) && (
            <p className="text-destructive text-sm" role="alert">
              {t("asset:quickAdd.validation.invalid")}
            </p>
          )}
        </LoanSheetBody>
        <LoanSheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              isSubmitting ||
              isFetching ||
              !calculation ||
              remainingPayments <= 0 ||
              isRateInvalid ||
              newPayment === null ||
              newPayment <= 0
            }
          >
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {t("asset:loanActions.recalculate_confirm")}
          </Button>
        </LoanSheetFooter>
      </LoanSheetContent>
    </Sheet>
  );
}

interface RenewLoanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBalance: number;
  currency: string;
  interestRate: number;
  metadata: Record<string, unknown>;
  endDate: Date | null;
  onSubmit: (
    effectiveDate: Date,
    newRate: number,
    paymentAmount?: number,
    termEndDate?: Date,
    interestMethod?: LoanInterestMethod,
  ) => Promise<void>;
}

/** Record a dated renewal without rewriting any historical quote. */
export function RenewLoanDialog({
  open,
  onOpenChange,
  currentBalance,
  currency,
  interestRate,
  metadata,
  endDate,
  onSubmit,
}: RenewLoanDialogProps) {
  const { t } = useTranslation();
  const [effectiveDate, setEffectiveDate] = useState<Date>(() => new Date());
  const [method, setMethod] = useState<LoanInterestMethod | undefined>();
  const inherited = inheritedLoanSettings(metadata, -1, formatDateISO(effectiveDate));
  const endDateTime = endDate?.getTime();
  const rateInputId = useId();
  const [newRate, setNewRate] = useState(String(interestRate));
  const [payment, setPayment] = useState<number | undefined>();
  const [termEndDate, setTermEndDate] = useState<Date | undefined>(endDate ?? undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEffectiveDate(new Date());
    setNewRate(String(interestRate));
    setMethod(undefined);
    setPayment(undefined);
    setTermEndDate(endDateTime === undefined ? undefined : new Date(endDateTime));
  }, [endDateTime, interestRate, open]);

  const parsedRate = Number(newRate);
  const isInvalid =
    !Number.isFinite(parsedRate) ||
    parsedRate < 0 ||
    parsedRate > 100 ||
    effectiveDate > new Date() ||
    (termEndDate !== undefined && termEndDate <= effectiveDate) ||
    (payment !== undefined && (!Number.isFinite(payment) || payment <= 0));

  const handleSubmit = async () => {
    if (isSubmitting || isInvalid) return;
    setIsSubmitting(true);
    try {
      await onSubmit(effectiveDate, parsedRate, payment, termEndDate, method);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <LoanSheetContent>
        <LoanSheetHeader>
          <SheetTitle>{t("asset:loanActions.renew_loan")}</SheetTitle>
          <SheetDescription>{t("asset:loanActions.renew_description")}</SheetDescription>
        </LoanSheetHeader>
        <LoanSheetBody>
          <div className="space-y-2">
            <Label>{t("asset:loanInterest.method")}</Label>
            <LoanInterestMethodSelect
              value={method ?? inherited.interestMethod}
              onChange={setMethod}
            />
          </div>
          <div className="bg-muted rounded-md px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              {t("asset:loanActions.recalculate_current_balance")}:{" "}
            </span>
            <AmountDisplay value={currentBalance} currency={currency} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("asset:loanOverview.effective_date")}</Label>
            <DatePickerInput
              aria-label={t("asset:loanOverview.effective_date")}
              value={effectiveDate}
              onChange={(date) => date && setEffectiveDate(date)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={rateInputId}>{t("asset:loanActions.recalculate_new_rate")}</Label>
            <MoneyInput
              id={rateInputId}
              maxDecimalPlaces={8}
              value={newRate}
              onValueChange={(value) => setNewRate(value == null ? "" : String(value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("asset:valueHistory.payment")}</Label>
            <MoneyInput
              aria-label={t("asset:valueHistory.payment")}
              maxDecimalPlaces={2}
              value={payment ?? 0}
              onValueChange={(value) => setPayment(value || undefined)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.renewal_maturity")}</Label>
            <DatePickerInput
              aria-label={t("asset:loanActions.renewal_maturity")}
              value={termEndDate}
              onChange={(date) => setTermEndDate(date ?? undefined)}
            />
          </div>
          {isInvalid && (
            <p className="text-destructive text-sm" role="alert">
              {t("asset:quickAdd.validation.invalid")}
            </p>
          )}
        </LoanSheetBody>
        <LoanSheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || isInvalid}>
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {t("asset:loanActions.renew_loan")}
          </Button>
        </LoanSheetFooter>
      </LoanSheetContent>
    </Sheet>
  );
}

interface LoanBalanceEventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "balance_correction" | "extra_repayment";
  currentBalance: number;
  onSubmit: (date: Date, amount: number) => Promise<void>;
}

export function LoanBalanceEventDialog({
  open,
  onOpenChange,
  mode,
  onSubmit,
}: LoanBalanceEventDialogProps) {
  const { t } = useTranslation();
  const amountId = useId();
  const [amountTouched, setAmountTouched] = useState(false);
  const [dateTouched, setDateTouched] = useState(false);
  const [date, setDate] = useState<Date>(() => new Date());
  const [amount, setAmount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isCorrection = mode === "balance_correction";
  const amountInvalid = !Number.isFinite(amount) || amount < 0 || (!isCorrection && amount === 0);
  const dateInvalid = !Number.isFinite(date.getTime()) || date > new Date();
  const invalid = amountInvalid || dateInvalid;
  const showValidation = (amountTouched && amountInvalid) || (dateTouched && dateInvalid);

  useEffect(() => {
    if (!open) return;
    setDate(new Date());
    setAmount(0);
    setError(null);
    setAmountTouched(false);
    setDateTouched(false);
  }, [open, mode]);

  const handleSubmit = async () => {
    if (invalid || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(date, amount);
      onOpenChange(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("asset:quickAdd.validation.invalid"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <LoanSheetContent>
        <LoanSheetHeader>
          <SheetTitle>
            {t(
              isCorrection
                ? "asset:loanActions.confirm_balance"
                : "asset:loanActions.extra_repayment",
            )}
          </SheetTitle>
          <SheetDescription>
            {t(
              isCorrection
                ? "asset:loanActions.balance_correction_description"
                : "asset:loanActions.extra_repayment_description",
            )}
          </SheetDescription>
        </LoanSheetHeader>
        <LoanSheetBody>
          <div className="space-y-1.5">
            <Label>{t("asset:loanOverview.effective_date")}</Label>
            <DatePickerInput
              aria-label={t("asset:loanOverview.effective_date")}
              value={date}
              onChange={(value) => {
                if (!value) return;
                setDate(value);
                setDateTouched(true);
                setError(null);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={amountId}>
              {t(
                isCorrection
                  ? "asset:loanActions.recalculate_current_balance"
                  : "asset:loanActions.repayment_amount",
              )}
            </Label>
            <MoneyInput
              id={amountId}
              value={amount}
              onValueChange={(value, isUserEdit) => {
                setAmount(value ?? 0);
                if (isUserEdit) setError(null);
              }}
              onBlur={() => setAmountTouched(true)}
              aria-invalid={amountTouched && amountInvalid}
            />
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          {showValidation && !error && (
            <p className="text-destructive text-sm" role="alert">
              {t("asset:quickAdd.validation.invalid")}
            </p>
          )}
        </LoanSheetBody>
        <LoanSheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={invalid || isSubmitting}>
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {t(
              isCorrection
                ? "asset:loanActions.confirm_balance"
                : "asset:loanActions.confirm_extra_repayment",
            )}
          </Button>
        </LoanSheetFooter>
      </LoanSheetContent>
    </Sheet>
  );
}
