import { AmountDisplay, Button, DatePickerInput, Icons, MoneyInput } from "@wealthfolio/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { addMonths, differenceInCalendarMonths } from "date-fns";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  calculateMonthlyPayment,
  calculateRemainingPaymentCount,
  getRemainingScheduleWindow,
} from "../lib/loan-schedule";

interface EarlyRepaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBalance: number;
  currency: string;
  interestRate: number;
  remainingMonths: number;
  monthlyPayment: number | null;
  originationDate: Date | null;
  endDate: Date | null;
  onSubmit: (
    date: Date,
    amount: number,
    mode: "reduce_duration" | "reduce_payment",
  ) => Promise<void>;
}

export function EarlyRepaymentDialog({
  open,
  onOpenChange,
  currentBalance,
  currency,
  interestRate,
  remainingMonths,
  monthlyPayment,
  originationDate,
  endDate,
  onSubmit,
}: EarlyRepaymentDialogProps) {
  const { t, i18n } = useTranslation();
  const [date, setDate] = useState<Date>(() => new Date());
  const [amount, setAmount] = useState<number>(0);
  const [mode, setMode] = useState<"reduce_duration" | "reduce_payment">("reduce_duration");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isDateInvalid =
    (originationDate !== null && date < originationDate) || (endDate !== null && date > endDate);
  const isAmountInvalid = amount <= 0 || amount > currentBalance;

  useEffect(() => {
    if (!open) return;
    setDate(new Date());
    setAmount(0);
    setMode("reduce_duration");
  }, [open]);

  const bNew = Math.max(0, currentBalance - amount);
  const selectedWindow =
    originationDate && endDate ? getRemainingScheduleWindow(originationDate, date, endDate) : null;
  const selectedRemainingMonths = selectedWindow?.paymentCount ?? remainingMonths;

  let newEndDate: Date | null = null;
  if (mode === "reduce_duration" && monthlyPayment !== null) {
    const paymentCount = calculateRemainingPaymentCount(bNew, interestRate, monthlyPayment);
    if (paymentCount !== null && paymentCount > 0) newEndDate = addMonths(date, paymentCount);
  }

  const newMonthlyPayment =
    mode === "reduce_payment"
      ? calculateMonthlyPayment(bNew, interestRate, selectedRemainingMonths)
      : null;

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(date, amount, mode);
      setAmount(0);
      setMode("reduce_duration");
      setDate(new Date());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("asset:loanActions.early_repayment")}</DialogTitle>
          <DialogDescription>
            {t("asset:loanActions.early_repayment_description")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.repayment_date")}</Label>
            <DatePickerInput
              value={date}
              onChange={(d) => d && setDate(d)}
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.repayment_amount")}</Label>
            <MoneyInput
              value={amount}
              onValueChange={(v) => setAmount(v ?? 0)}
              disabled={isSubmitting}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMode("reduce_duration")}
              disabled={isSubmitting}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                mode === "reduce_duration"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-accent",
              )}
            >
              <div className="font-medium">{t("asset:loanActions.reduce_duration")}</div>
              <div
                className={cn(
                  "mt-0.5 text-xs",
                  mode === "reduce_duration" ? "opacity-80" : "text-muted-foreground",
                )}
              >
                {t("asset:loanActions.reduce_duration_description")}
              </div>
            </button>
            <button
              type="button"
              onClick={() => setMode("reduce_payment")}
              disabled={isSubmitting}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                mode === "reduce_payment"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-accent",
              )}
            >
              <div className="font-medium">{t("asset:loanActions.reduce_payment")}</div>
              <div
                className={cn(
                  "mt-0.5 text-xs",
                  mode === "reduce_payment" ? "opacity-80" : "text-muted-foreground",
                )}
              >
                {t("asset:loanActions.reduce_payment_description")}
              </div>
            </button>
          </div>
          {mode === "reduce_duration" && newEndDate && (
            <div className="bg-muted rounded-md px-3 py-2 text-sm">
              <span className="text-muted-foreground">{t("asset:loanActions.new_end_date")}: </span>
              <span className="font-medium">
                {newEndDate.toLocaleDateString(i18n.language, {
                  month: "short",
                  year: "numeric",
                })}
              </span>
            </div>
          )}
          {(isAmountInvalid || isDateInvalid) && (
            <p className="text-destructive text-sm" role="alert">
              {t(
                amount > currentBalance
                  ? "asset:loanActions.validation.amount_exceeds_balance"
                  : isDateInvalid
                    ? "asset:loanActions.validation.date_outside_loan"
                    : "asset:loanActions.validation.invalid",
              )}
            </p>
          )}
          {mode === "reduce_payment" && newMonthlyPayment !== null && (
            <div className="bg-muted rounded-md px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {t("asset:loanActions.new_monthly_payment")}:{" "}
              </span>
              <span className="font-medium">
                <AmountDisplay value={newMonthlyPayment} currency={currency} />
              </span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || isAmountInvalid || isDateInvalid}
          >
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {t("asset:loanActions.confirm_repayment")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("asset:loanActions.close_loan")}</DialogTitle>
          <DialogDescription>{t("asset:loanActions.close_loan_description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.closure_date")}</Label>
            <DatePickerInput
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
        </div>
        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RecalculateScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBalance: number;
  currency: string;
  interestRate: number;
  endDate: Date | null;
  onSubmit: (newRate: number) => Promise<void>;
}

export function RecalculateScheduleDialog({
  open,
  onOpenChange,
  currentBalance,
  currency,
  interestRate,
  endDate,
  onSubmit,
}: RecalculateScheduleDialogProps) {
  const { t, i18n } = useTranslation();
  const [newRate, setNewRate] = useState<string>(() => String(interestRate));
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) setNewRate(String(interestRate));
  }, [interestRate, open]);

  const today = new Date();
  const remainingMonths = endDate ? Math.max(1, differenceInCalendarMonths(endDate, today)) : 0;
  const parsedRate = parseFloat(newRate);
  const isRateInvalid = !Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100;
  const newMonthlyPayment = calculateMonthlyPayment(currentBalance, parsedRate, remainingMonths);

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(parseFloat(newRate || "0"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("asset:loanActions.recalculate_schedule")}</DialogTitle>
          <DialogDescription>{t("asset:loanActions.recalculate_description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="bg-muted grid grid-cols-2 gap-x-4 gap-y-1 rounded-md px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              {t("asset:loanActions.recalculate_current_balance")}
            </span>
            <span className="text-right font-medium">
              <AmountDisplay value={currentBalance} currency={currency} />
            </span>
            <span className="text-muted-foreground">
              {t("asset:loanActions.recalculate_remaining_months")}
            </span>
            <span className="text-right font-medium">{remainingMonths}</span>
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
            <Label>{t("asset:loanActions.recalculate_new_rate")}</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
          {newMonthlyPayment !== null && (
            <div className="bg-muted rounded-md px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {t("asset:loanActions.new_monthly_payment")}:{" "}
              </span>
              <span className="font-medium">
                <AmountDisplay value={newMonthlyPayment} currency={currency} />
              </span>
            </div>
          )}
          {isRateInvalid && (
            <p className="text-destructive text-sm" role="alert">
              {t("asset:quickAdd.validation.invalid")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || remainingMonths <= 0 || isRateInvalid}
          >
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {t("asset:loanActions.recalculate_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
